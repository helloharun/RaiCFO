import type { DB } from '../db.js';
import { addDays, addMonths, monthStart, todayISO } from '../money.js';
import { CASH_SUBTYPES, ValidationError } from '../types.js';
import { USER_ID, accountBalances, audit, getAccount, listAccounts } from '../engine/ledger.js';
import { type RecurringRow, nextOccurrence } from '../engine/services.js';
import type { EntryInput } from '../types.js';

/* ---------------- Goals ---------------- */

export interface GoalRow {
  id: number;
  name: string;
  kind: string;
  target_amount: number;
  target_date: string | null;
  account_ids: string | null;
  manual_amount: number;
  notes: string | null;
  is_archived: number;
  created_at: string;
}

export const GOAL_KINDS = ['savings', 'emergency_fund', 'debt_payoff', 'investment', 'purchase', 'net_worth', 'other'] as const;

function monthsBetween(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + (td - fd) / 30;
}

async function goalProgress(db: DB, g: GoalRow, today: string) {
  const ids: number[] = g.account_ids ? JSON.parse(g.account_ids) : [];
  const balNow = await accountBalances(db, { to: today });
  const bal3 = await accountBalances(db, { to: addMonths(today, -3) });
  const sum = async (m: typeof balNow) => {
    if (g.kind === 'net_worth') {
      return (await listAccounts(db)).reduce((s, a) => s + (a.type === 'asset' ? 1 : a.type === 'liability' ? -1 : 0) * (m.get(a.id)?.balance ?? 0), 0);
    }
    return ids.reduce((s, id) => s + (m.get(id)?.balance ?? 0), 0);
  };
  let current: number;
  let past: number;
  if (g.kind === 'debt_payoff') {
    // progress = how much of the starting debt (target) has been paid down
    const owed = await sum(balNow);
    current = Math.max(0, g.target_amount - owed);
    past = Math.max(0, g.target_amount - (await sum(bal3)));
  } else if (ids.length || g.kind === 'net_worth') {
    current = await sum(balNow);
    past = await sum(bal3);
  } else {
    current = g.manual_amount;
    past = g.manual_amount;
  }
  const remaining = Math.max(0, g.target_amount - current);
  const monthsLeft = g.target_date ? monthsBetween(today, g.target_date) : null;
  const requiredMonthly = monthsLeft !== null ? (monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining) : null;
  const avgMonthly = Math.round((current - past) / 3);
  const projectedDate = remaining === 0 ? today : avgMonthly > 0 ? addMonths(today, Math.ceil(remaining / avgMonthly)) : null;
  const onTrack = remaining === 0 || (requiredMonthly !== null ? avgMonthly >= requiredMonthly : avgMonthly > 0);
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    targetAmount: g.target_amount,
    targetDate: g.target_date,
    accountIds: ids,
    manualAmount: g.manual_amount,
    notes: g.notes,
    isArchived: Boolean(g.is_archived),
    current,
    remaining,
    progress: g.target_amount ? Math.min(1, current / g.target_amount) : 0,
    monthsLeft,
    requiredMonthly,
    avgMonthly,
    projectedDate,
    onTrack,
    completed: remaining === 0,
  };
}

export async function listGoals(db: DB, today = todayISO()) {
  const rows = await db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY is_archived, COALESCE(target_date, \'9999\'), id').all(USER_ID) as GoalRow[];
  const out = [];
  for (const g of rows) out.push(await goalProgress(db, g, today));
  return out;
}

export async function upsertGoal(db: DB, b: Record<string, unknown>, id?: number) {
  const name = String(b.name ?? '').trim().slice(0, 120);
  if (!name) throw new ValidationError('Goal name is required.');
  const kind = String(b.kind ?? 'savings');
  if (!(GOAL_KINDS as readonly string[]).includes(kind)) throw new ValidationError('Invalid goal type.');
  const target = Number(b.targetAmount);
  if (!Number.isFinite(target) || target <= 0 || target > 1e11) throw new ValidationError('Target amount must be a positive number.');
  const targetDate = b.targetDate ? String(b.targetDate) : null;
  if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new ValidationError('Invalid target date.');
  const accountIds = Array.isArray(b.accountIds) ? [...new Set(b.accountIds.map(Number))].filter((x) => Number.isInteger(x) && x > 0).slice(0, 50) : [];
  for (const a of accountIds) if (!(await getAccount(db, a))) throw new ValidationError('Linked account not found.');
  const manual = Number(b.manualAmount ?? 0);
  if (!Number.isFinite(manual) || manual < 0 || manual > 1e11) throw new ValidationError('Invalid current amount.');
  const notes = b.notes ? String(b.notes).slice(0, 1000) : null;
  const vals = [name, kind, Math.round(target * 100), targetDate, accountIds.length ? JSON.stringify(accountIds) : null, Math.round(manual * 100), notes, b.isArchived ? 1 : 0];
  if (id) {
    const r = await db.prepare('UPDATE goals SET name = ?, kind = ?, target_amount = ?, target_date = ?, account_ids = ?, manual_amount = ?, notes = ?, is_archived = ? WHERE id = ? AND user_id = ?').run(...vals, id, USER_ID);
    if (!r.changes) throw new ValidationError('Goal not found.');
    await audit(db, 'update', 'goal', id, { name, kind, target });
    return id;
  }
  const newId = Number((await db.prepare('INSERT INTO goals (name, kind, target_amount, target_date, account_ids, manual_amount, notes, is_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...vals)).lastInsertRowid);
  await audit(db, 'create', 'goal', newId, { name, kind, target });
  return newId;
}

export async function deleteGoal(db: DB, id: number) {
  const r = await db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(id, USER_ID);
  if (!r.changes) throw new ValidationError('Goal not found.');
  await audit(db, 'delete', 'goal', id);
}

/* ---------------- Financial health ---------------- */

export async function financialHealth(db: DB, today = todayISO()) {
  const accts = await listAccounts(db);
  const bal = await accountBalances(db, { to: today });
  const b = (pred: (a: (typeof accts)[number]) => boolean) => accts.filter(pred).reduce((s, a) => s + (bal.get(a.id)?.balance ?? 0), 0);
  const liquid = b((a) => a.type === 'asset' && CASH_SUBTYPES.includes(a.subtype));
  const assets = b((a) => a.type === 'asset');
  const liabilities = b((a) => a.type === 'liability');
  const cardDebt = b((a) => a.type === 'liability' && a.subtype === 'credit_card');
  const from = addMonths(monthStart(today), -3);
  const to = addDays(monthStart(today), -1);
  const period = await accountBalances(db, { from, to });
  const p = (type: string) => accts.filter((a) => a.type === type).reduce((s, a) => s + (period.get(a.id)?.balance ?? 0), 0);
  const income3 = p('income');
  const expense3 = p('expense');
  const avgExpenses = Math.round(expense3 / 3);
  const avgIncome = Math.round(income3 / 3);
  const efMonths = avgExpenses ? liquid / avgExpenses : null;
  const savingsRate = income3 ? (income3 - expense3) / income3 : null;
  const debtToAsset = assets ? liabilities / assets : null;
  const metrics = [
    { key: 'emergency_fund', label: 'Emergency fund', value: efMonths, unit: 'months', status: efMonths === null ? 'na' : efMonths >= 6 ? 'good' : efMonths >= 3 ? 'ok' : 'poor', hint: 'Liquid cash ÷ average monthly expenses (last 3 full months). Aim for 3–6 months.' },
    { key: 'savings_rate', label: 'Savings rate', value: savingsRate, unit: 'ratio', status: savingsRate === null ? 'na' : savingsRate >= 0.2 ? 'good' : savingsRate >= 0.1 ? 'ok' : 'poor', hint: '(Income − expenses) ÷ income over the last 3 full months. Aim for 20%+.' },
    { key: 'debt_to_asset', label: 'Debt-to-asset', value: debtToAsset, unit: 'ratio', status: debtToAsset === null ? 'na' : debtToAsset <= 0.3 ? 'good' : debtToAsset <= 0.6 ? 'ok' : 'poor', hint: 'Total liabilities ÷ total assets. Lower is better.' },
    { key: 'card_debt', label: 'Credit-card debt', value: cardDebt, unit: 'cents', status: cardDebt <= 0 ? 'good' : avgIncome && cardDebt < avgIncome * 0.25 ? 'ok' : 'poor', hint: 'Balances carried on credit cards. Pay in full monthly to avoid interest.' },
  ];
  return { asOf: today, liquid, assets, liabilities, netWorth: assets - liabilities, avgIncome, avgExpenses, metrics };
}

/* ---------------- Cash-flow forecast & upcoming bills ---------------- */

export async function forecast(db: DB, days = 60, today = todayISO()) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new ValidationError('Days must be between 1 and 366.');
  const end = addDays(today, days);
  const accts = await listAccounts(db);
  const byId = new Map(accts.map((a) => [a.id, a]));
  const liquidIds = new Set(accts.filter((a) => a.type === 'asset' && CASH_SUBTYPES.includes(a.subtype)).map((a) => a.id));
  const bal = await accountBalances(db, { to: today });
  const startBalance = [...liquidIds].reduce((s, id) => s + (bal.get(id)?.balance ?? 0), 0);
  const recurring = await db.prepare('SELECT * FROM recurring_transactions WHERE user_id = ? AND is_active = 1').all(USER_ID) as RecurringRow[];
  const events: Array<{ date: string; recurringId: number; description: string; frequency: string; amount: number; cashEffect: number; kind: 'bill' | 'income' | 'transfer'; accounts: string[] }> = [];
  for (const r of recurring) {
    const tpl = JSON.parse(r.template) as Omit<EntryInput, 'date'>;
    const lines = tpl.lines ?? [];
    const total = lines.reduce((s, l) => s + Math.round(Number(l.debit || 0) * 100), 0);
    const cashEffect = lines.reduce((s, l) => (liquidIds.has(Number(l.accountId)) ? s + Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100) : s), 0);
    const types = lines.map((l) => byId.get(Number(l.accountId))?.type);
    const kind = types.includes('expense') || (cashEffect < 0 && types.includes('liability')) ? 'bill' : types.includes('income') ? 'income' : 'transfer';
    let d = r.next_date;
    let guard = 0;
    while (d <= end && (!r.end_date || d <= r.end_date) && guard++ < 400) {
      events.push({ date: d < today ? today : d, recurringId: r.id, description: r.description, frequency: r.frequency, amount: total, cashEffect, kind, accounts: lines.map((l) => byId.get(Number(l.accountId))?.name ?? '?') });
      d = nextOccurrence(d, r.frequency);
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.cashEffect - b.cashEffect);
  const series: Array<{ date: string; balance: number }> = [];
  let running = startBalance;
  let low = { date: today, balance: startBalance };
  let i = 0;
  for (let d = today; d <= end; d = addDays(d, 1)) {
    while (i < events.length && events[i].date === d) running += events[i++].cashEffect;
    series.push({ date: d, balance: running });
    if (running < low.balance) low = { date: d, balance: running };
  }
  const bills = events.filter((e) => e.kind === 'bill');
  return {
    from: today,
    to: end,
    startBalance,
    endBalance: running,
    lowest: low,
    goesNegative: low.balance < 0,
    totalBills: bills.reduce((s, e) => s + e.amount, 0),
    totalIncome: events.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0),
    events,
    series,
  };
}

/* ---------------- Debt payoff planner ---------------- */

interface Debt {
  accountId: number;
  name: string;
  balance: number;
  apr: number;
  minPayment: number;
}

function simulate(debts: Debt[], strategy: 'avalanche' | 'snowball' | 'minimum', extra: number) {
  const ds = debts.map((d) => ({ ...d, bal: d.balance, interest: 0, paidOffMonth: d.balance <= 0 ? 0 : null as number | null }));
  const budget = ds.reduce((s, d) => s + d.minPayment, 0) + (strategy === 'minimum' ? 0 : extra);
  let month = 0;
  let totalInterest = 0;
  const timeline: Array<{ month: number; totalBalance: number }> = [{ month: 0, totalBalance: ds.reduce((s, d) => s + d.bal, 0) }];
  while (ds.some((d) => d.bal > 0) && month < 600) {
    month++;
    for (const d of ds) {
      if (d.bal <= 0) continue;
      const i = Math.round((d.bal * d.apr) / 100 / 12);
      d.bal += i;
      d.interest += i;
      totalInterest += i;
    }
    let available = budget;
    for (const d of ds) {
      if (d.bal <= 0) continue;
      const pay = Math.min(d.minPayment, d.bal, available);
      d.bal -= pay;
      available -= pay;
    }
    if (strategy !== 'minimum') {
      const order = ds.filter((d) => d.bal > 0).sort((a, b) => (strategy === 'avalanche' ? b.apr - a.apr || a.bal - b.bal : a.bal - b.bal || b.apr - a.apr));
      for (const d of order) {
        if (available <= 0) break;
        const pay = Math.min(d.bal, available);
        d.bal -= pay;
        available -= pay;
      }
    }
    for (const d of ds) if (d.bal <= 0 && d.paidOffMonth === null) d.paidOffMonth = month;
    timeline.push({ month, totalBalance: ds.reduce((s, d) => s + Math.max(0, d.bal), 0) });
    if (month > 1 && timeline[month].totalBalance >= timeline[month - 1].totalBalance && timeline[month].totalBalance > 0) {
      return { strategy, months: null, totalInterest: null, payoffNever: true, debts: ds.map((d) => ({ accountId: d.accountId, name: d.name, paidOffMonth: null, interest: d.interest })), timeline };
    }
  }
  const done = !ds.some((d) => d.bal > 0);
  return { strategy, months: done ? month : null, totalInterest: done ? totalInterest : null, payoffNever: !done, debts: ds.map((d) => ({ accountId: d.accountId, name: d.name, paidOffMonth: d.paidOffMonth, interest: d.interest })), timeline };
}

export async function debtPlan(db: DB, opts: { extraMonthly?: number; overrides?: Record<string, { apr?: number; minPayment?: number }> } = {}, today = todayISO()) {
  const extra = Math.round(Number(opts.extraMonthly ?? 0) * 100);
  if (!Number.isFinite(extra) || extra < 0 || extra > 1e10) throw new ValidationError('Extra payment must be zero or more.');
  const bal = await accountBalances(db, { to: today });
  const debts: Debt[] = (await listAccounts(db, false))
    .filter((a) => a.type === 'liability' && (bal.get(a.id)?.balance ?? 0) > 0)
    .map((a) => {
      const o = opts.overrides?.[String(a.id)] ?? {};
      const balance = bal.get(a.id)!.balance;
      const apr = Number(o.apr ?? a.interest_rate ?? 0);
      const min = o.minPayment !== undefined ? Math.round(Number(o.minPayment) * 100) : a.min_payment ?? Math.max(1000, Math.round(balance * 0.03));
      if (!Number.isFinite(apr) || apr < 0 || apr > 100) throw new ValidationError(`Invalid interest rate for ${a.name}.`);
      if (!Number.isFinite(min) || min < 0) throw new ValidationError(`Invalid minimum payment for ${a.name}.`);
      return { accountId: a.id, name: a.name, balance, apr, minPayment: min, configured: a.interest_rate !== null && a.interest_rate !== undefined };
    });
  const pick = (r: ReturnType<typeof simulate>) => ({ ...r, timeline: r.timeline.filter((_, i) => i % Math.max(1, Math.ceil(r.timeline.length / 120)) === 0 || i === r.timeline.length - 1) });
  const date = (m: number | null) => (m === null ? null : addMonths(today, m));
  const results = (['avalanche', 'snowball', 'minimum'] as const).map((s) => {
    const r = pick(simulate(debts, s, extra));
    return { ...r, payoffDate: date(r.months), debts: r.debts.map((d) => ({ ...d, payoffDate: date(d.paidOffMonth) })) };
  });
  return { debts, extraMonthly: extra, totalDebt: debts.reduce((s, d) => s + d.balance, 0), results };
}
