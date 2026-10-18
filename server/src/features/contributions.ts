import type { DB } from '../db.js';
import { todayISO } from '../money.js';
import { ValidationError } from '../types.js';
import { USER_ID, audit, getAccount, getSetting, listAccounts, setSetting } from '../engine/ledger.js';

/**
 * Registered-plan contribution room (TFSA, RRSP, FHSA, ...). Read-only over the ledger:
 * contributions/withdrawals are derived from posted entries that move money between a plan's
 * accounts and other asset/liability accounts. Nothing here posts or changes balances.
 */
export const PLAN_RULES = ['restore_next_year', 'no_restore', 'lifetime_cap'] as const;
export type PlanRule = (typeof PLAN_RULES)[number];

interface PlanRow {
  id: number;
  name: string;
  rule: PlanRule;
  account_ids: string | null;
  annual_limit: number;
  year_limits: string | null;
  room: string | null;
  lifetime_cap: number | null;
  carry_cap: number | null;
  lifetime_prior: number;
  income_pct: number | null;
  notes: string | null;
}

export interface PlanFlow { entryId: number; date: string; description: string; payee: string | null; kind: 'contribution' | 'withdrawal'; amount: number }

const EARNED_INCOME_SUBTYPES = ['employment', 'business', 'freelance'];
const parseMap = (s: string | null): Record<string, number> => {
  try {
    const o = s ? (JSON.parse(s) as Record<string, number>) : {};
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
};
const parseIds = (s: string | null): number[] => {
  try {
    const a = s ? (JSON.parse(s) as unknown) : [];
    return Array.isArray(a) ? a.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
  } catch {
    return [];
  }
};

/** Contributions and withdrawals for a set of accounts, per entry. Reversed entries and their reversals are ignored. */
export async function planFlows(db: DB, accountIds: number[], to: string): Promise<PlanFlow[]> {
  if (!accountIds.length) return [];
  const ph = accountIds.map(() => '?').join(',');
  const rows = (await db
    .prepare(
      `SELECT e.id, e.date, e.description, e.payee, l.account_id, l.debit, l.credit, a.type
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.user_id = ? AND e.date <= ? AND e.reversal_of IS NULL AND e.reversed_by IS NULL
          AND e.id IN (SELECT entry_id FROM journal_lines WHERE account_id IN (${ph}))
        ORDER BY e.date, e.id`,
    )
    .all(USER_ID, to, ...accountIds)) as Array<{ id: number; date: string; description: string; payee: string | null; account_id: number; debit: number; credit: number; type: string }>;
  const plan = new Set(accountIds);
  const byEntry = new Map<number, { e: (typeof rows)[number]; planNet: number; flow: number }>();
  for (const r of rows) {
    const x = byEntry.get(r.id) ?? { e: r, planNet: 0, flow: 0 };
    if (plan.has(Number(r.account_id))) x.planNet += Number(r.debit) - Number(r.credit);
    else if (r.type === 'asset' || r.type === 'liability') x.flow += Number(r.credit) - Number(r.debit);
    byEntry.set(r.id, x);
  }
  const out: PlanFlow[] = [];
  for (const { e, planNet, flow } of byEntry.values()) {
    const base = { entryId: Number(e.id), date: e.date, description: e.description, payee: e.payee };
    const contrib = Math.min(Math.max(flow, 0), Math.max(planNet, 0));
    const withdraw = Math.min(Math.max(-flow, 0), Math.max(-planNet, 0));
    if (contrib) out.push({ ...base, kind: 'contribution', amount: contrib });
    if (withdraw) out.push({ ...base, kind: 'withdrawal', amount: withdraw });
  }
  return out;
}

async function earnedIncome(db: DB, year: number): Promise<number> {
  const r = (await db
    .prepare(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS g FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.user_id = ? AND a.type = 'income' AND a.subtype IN (${EARNED_INCOME_SUBTYPES.map(() => '?').join(',')}) AND e.date >= ? AND e.date <= ?`,
    )
    .get(USER_ID, ...EARNED_INCOME_SUBTYPES, `${year}-01-01`, `${year}-12-31`)) as { g: number };
  return Number(r.g);
}

/** Room for one plan in one calendar year, rolled forward from the latest CRA figure entered on or before that year. */
export async function planRoom(db: DB, p: PlanRow, year: number, today = todayISO()) {
  const accountIds = parseIds(p.account_ids);
  const room = parseMap(p.room);
  const limits = parseMap(p.year_limits);
  const anchor = Math.max(-Infinity, ...Object.keys(room).map(Number).filter((y) => y <= year));
  const flows = await planFlows(db, accountIds, `${year}-12-31`);
  const sum = (y: number, kind: PlanFlow['kind']) => flows.filter((f) => f.kind === kind && Number(f.date.slice(0, 4)) === y).reduce((s, f) => s + f.amount, 0);
  const transactions = flows.filter((f) => Number(f.date.slice(0, 4)) === year);
  const contributed = sum(year, 'contribution');
  const withdrawn = sum(year, 'withdrawal');
  const base = { year, contributed, withdrawn, transactions, anchorYear: null as number | null, estimated: false, roomJan1: null as number | null, remaining: null as number | null, newRoom: null as number | null, lifetimeLeft: null as number | null, first60: 0 };
  if (p.rule === 'no_restore') base.first60 = flows.filter((f) => f.kind === 'contribution' && f.date >= `${year}-01-01` && f.date <= `${year}-03-01`).reduce((s, f) => s + f.amount, 0);
  if (!Number.isFinite(anchor)) return base;

  const newRoomFor = async (y: number) => {
    const limit = limits[y] ?? p.annual_limit;
    if (p.rule === 'no_restore' && p.income_pct && limits[y] === undefined) return Math.min(Math.round((Math.max(await earnedIncome(db, y - 1), 0) * p.income_pct) / 100), limit);
    return limit;
  };
  const contribBefore = (y: number) => flows.filter((f) => f.kind === 'contribution' && Number(f.date.slice(0, 4)) < y).reduce((s, f) => s + f.amount, 0);
  let jan1 = room[anchor];
  let newRoom: number | null = null;
  for (let y = anchor + 1; y <= year; y++) {
    const prevRemaining = jan1 - sum(y - 1, 'contribution');
    newRoom = await newRoomFor(y);
    if (p.rule === 'restore_next_year') jan1 = prevRemaining + newRoom + sum(y - 1, 'withdrawal');
    else if (p.rule === 'lifetime_cap') {
      const carried = Math.min(Math.max(prevRemaining, 0), p.carry_cap ?? Infinity);
      const left = (p.lifetime_cap ?? Infinity) - p.lifetime_prior - contribBefore(y);
      jan1 = Math.max(Math.min(newRoom + carried, left), 0);
    } else jan1 = prevRemaining + newRoom;
  }
  const lifetimeLeft = p.rule === 'lifetime_cap' && p.lifetime_cap !== null ? p.lifetime_cap - p.lifetime_prior - contribBefore(year) - contributed : null;
  return { ...base, anchorYear: anchor, estimated: year > anchor, roomJan1: jan1, remaining: jan1 - contributed, newRoom, lifetimeLeft, asOf: today };
}

const toApi = (p: PlanRow) => ({
  id: Number(p.id), name: p.name, rule: p.rule, accountIds: parseIds(p.account_ids), annualLimit: Number(p.annual_limit), yearLimits: parseMap(p.year_limits), room: parseMap(p.room),
  lifetimeCap: p.lifetime_cap === null ? null : Number(p.lifetime_cap), carryCap: p.carry_cap === null ? null : Number(p.carry_cap), lifetimePrior: Number(p.lifetime_prior), incomePct: p.income_pct, notes: p.notes,
});

/** Pre-fills TFSA / RRSP / FHSA once; the user can edit or delete them afterwards. Limits are editable defaults, verify with CRA. */
async function seedPlans(db: DB) {
  if (await getSetting(db, 'contribution_plans_seeded')) return;
  const accts = await listAccounts(db);
  const ids = (st: string) => JSON.stringify(accts.filter((a) => a.type === 'asset' && a.subtype === st).map((a) => a.id));
  const ins = db.prepare('INSERT INTO contribution_plans (name, rule, account_ids, annual_limit, year_limits, lifetime_cap, carry_cap, income_pct, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  await ins.run('TFSA', 'restore_next_year', ids('tfsa'), 700000, JSON.stringify({ 2024: 700000, 2025: 700000, 2026: 700000 }), null, null, null, null);
  await ins.run('RRSP', 'no_restore', ids('rrsp'), 3381000, JSON.stringify({ 2025: 3249000, 2026: 3381000 }), null, null, 18, 'New room = 18% of last year’s earned income, capped at the yearly maximum. Enter the deduction limit from your Notice of Assessment each year.');
  await ins.run('FHSA', 'lifetime_cap', '[]', 800000, null, 4000000, 800000, null, null);
  await setSetting(db, 'contribution_plans_seeded', '1');
}

export async function listPlans(db: DB, year: number) {
  await seedPlans(db);
  const rows = (await db.prepare('SELECT * FROM contribution_plans WHERE user_id = ? ORDER BY sort_order, id').all(USER_ID)) as PlanRow[];
  const plans = [];
  for (const p of rows) plans.push({ ...toApi(p), result: await planRoom(db, p, year) });
  return { year, plans };
}

const MAX_CENTS = 1e11;
const cents = (v: unknown, label: string, nullable = false): number | null => {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n * 100 > MAX_CENTS) throw new ValidationError(`${label} must be a positive amount.`);
  return Math.round(n * 100);
};
const yearMap = (v: unknown, label: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(`Invalid ${label}.`);
  const out: Record<string, number> = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 120) throw new ValidationError(`Too many ${label} entries.`);
  for (const [y, amt] of entries) {
    if (!/^\d{4}$/.test(y) || Number(y) < 1990 || Number(y) > 2100) throw new ValidationError(`Invalid year in ${label}.`);
    if (amt === null || amt === '') continue;
    out[y] = cents(amt, label)!;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
};

export async function upsertPlan(db: DB, b: Record<string, unknown>, id?: number) {
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) throw new ValidationError('Plan name is required.');
  const rule = String(b.rule ?? '');
  if (!(PLAN_RULES as readonly string[]).includes(rule)) throw new ValidationError('Invalid plan rule.');
  const accountIds = Array.isArray(b.accountIds) ? [...new Set(b.accountIds.map(Number))].filter((x) => Number.isInteger(x) && x > 0).slice(0, 50) : [];
  for (const a of accountIds) {
    const acc = await getAccount(db, a);
    if (!acc) throw new ValidationError('Linked account not found.');
    if (acc.type !== 'asset') throw new ValidationError('Only asset accounts can be linked to a plan.');
  }
  const pct = b.incomePct === null || b.incomePct === undefined || b.incomePct === '' ? null : Number(b.incomePct);
  if (pct !== null && (!Number.isFinite(pct) || pct <= 0 || pct > 100)) throw new ValidationError('Income % must be between 0 and 100.');
  const vals = [
    name, rule, JSON.stringify(accountIds), cents(b.annualLimit ?? 0, 'Annual limit'), yearMap(b.yearLimits, 'yearly limits'), yearMap(b.room, 'CRA room'),
    rule === 'lifetime_cap' ? cents(b.lifetimeCap, 'Lifetime cap', true) : null, rule === 'lifetime_cap' ? cents(b.carryCap, 'Carry-forward cap', true) : null,
    rule === 'lifetime_cap' ? cents(b.lifetimePrior ?? 0, 'Earlier contributions') : 0, rule === 'no_restore' ? pct : null, b.notes ? String(b.notes).slice(0, 1000) : null,
  ];
  if (id) {
    const r = await db.prepare('UPDATE contribution_plans SET name = ?, rule = ?, account_ids = ?, annual_limit = ?, year_limits = ?, room = ?, lifetime_cap = ?, carry_cap = ?, lifetime_prior = ?, income_pct = ?, notes = ? WHERE id = ? AND user_id = ?').run(...vals, id, USER_ID);
    if (!r.changes) throw new ValidationError('Plan not found.');
    await audit(db, 'update', 'contribution_plan', id, { name, rule });
    return id;
  }
  const newId = Number((await db.prepare('INSERT INTO contribution_plans (name, rule, account_ids, annual_limit, year_limits, room, lifetime_cap, carry_cap, lifetime_prior, income_pct, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals)).lastInsertRowid);
  await audit(db, 'create', 'contribution_plan', newId, { name, rule });
  return newId;
}

export async function deletePlan(db: DB, id: number) {
  const r = await db.prepare('DELETE FROM contribution_plans WHERE id = ? AND user_id = ?').run(id, USER_ID);
  if (!r.changes) throw new ValidationError('Plan not found.');
  await audit(db, 'delete', 'contribution_plan', id);
}
