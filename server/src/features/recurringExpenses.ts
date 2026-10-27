import type { DB } from '../db.js';
import { todayISO } from '../money.js';
import { USER_ID, getSetting, setSetting } from '../engine/ledger.js';
import { merchantMatcher } from '../engine/insights.js';
import { ValidationError } from '../types.js';
import { planFlows } from './contributions.js';

/**
 * Detects what a "normal month" costs, read-only over the ledger:
 *  - fixed payments: a merchant charged a stable amount at a steady interval (rent, subscriptions)
 *  - habitual spending: expense categories used in several months (groceries, gas) at their average
 *  - debt payments: money paid into liability accounts
 * Nothing is posted or computed manually — it is all derived from posted entries.
 */

interface ExpLine { date: string; payee: string | null; text: string; accountId: number; accountName: string; amt: number }

interface Cadence { label: string; perYear: number }
const CADENCES: Array<[min: number, max: number, Cadence]> = [
  [6, 9, { label: 'weekly', perYear: 52.14 }],
  [12, 16, { label: 'every 2 weeks', perYear: 26.09 }],
  [25, 35, { label: 'monthly', perYear: 12 }],
  [55, 70, { label: 'every 2 months', perYear: 6 }],
  [80, 100, { label: 'quarterly', perYear: 4 }],
  [160, 200, { label: 'every 6 months', perYear: 2 }],
  [320, 410, { label: 'yearly', perYear: 1 }],
];
const cadenceFor = (d: number) => CADENCES.find(([lo, hi]) => d >= lo && d <= hi)?.[2];
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000;
const HIDDEN_KEY = 'recurring_expenses_hidden';

export interface RecurringItem {
  key: string;
  label: string;
  kind: 'fixed' | 'habit';
  detail: string;
  monthly: number;
  annual: number;
  lastDate: string;
}

export async function recurringExpenses(db: DB, today = todayISO()) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  // Fixed payments look back ~2 years so a yearly pair fits; averages use the 12-month window.
  const detectFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 800 * 86400000).toISOString().slice(0, 10);
  const first = (await db.prepare('SELECT MIN(date) AS d FROM journal_entries WHERE user_id = ? AND date <= ?').get(USER_ID, today)) as { d: string | null };
  const months = first.d && first.d > from ? Math.min(12, Math.max(1, (day(today) - day(first.d)) / 30.4375)) : 12;

  const lines = (await db
    .prepare(
      `SELECT e.date, e.payee, e.description, e.memo, e.raw_input, l.account_id, a.name AS account_name, (l.debit - l.credit) AS amt
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.user_id = ? AND a.type = 'expense' AND l.debit - l.credit > 0 AND e.date >= ? AND e.date <= ?
          AND e.reversal_of IS NULL AND e.reversed_by IS NULL
        ORDER BY e.date, e.id`,
    )
    .all(USER_ID, detectFrom, today)) as Array<{ date: string; payee: string | null; description: string; memo: string | null; raw_input: string | null; account_id: number; account_name: string; amt: number }>;
  const m = await merchantMatcher(db);

  const byMerchant = new Map<string, { ev: Array<{ date: string; amt: number; accountId: number }>; accountName: string }>();
  const byAccount = new Map<number, { name: string; total: number; months: Set<string>; count: number; fixedAmt: number }>();
  for (const r of lines) {
    const line: ExpLine = { date: r.date, payee: r.payee, text: `${r.description} ${r.memo ?? ''} ${r.raw_input ?? ''}`, accountId: Number(r.account_id), accountName: r.account_name, amt: Number(r.amt) };
    const merchant = m.canonical(r.payee) ?? m.find(line.text);
    if (merchant) {
      const g = byMerchant.get(merchant) ?? { ev: [], accountName: line.accountName };
      g.ev.push({ date: line.date, amt: line.amt, accountId: line.accountId });
      byMerchant.set(merchant, g);
    }
    if (line.date >= from) {
      const a = byAccount.get(line.accountId) ?? { name: line.accountName, total: 0, months: new Set<string>(), count: 0, fixedAmt: 0 };
      a.total += line.amt;
      a.months.add(line.date.slice(0, 7));
      a.count++;
      byAccount.set(line.accountId, a);
    }
  }

  const items: RecurringItem[] = [];
  const now = day(today);
  for (const [merchant, g] of byMerchant) {
    const ev = g.ev.sort((x, y) => x.date.localeCompare(y.date));
    const amounts = ev.map((x) => x.amt);
    const med = median(amounts);
    if (med <= 0) continue;
    const stable = (Math.max(...amounts) - Math.min(...amounts)) / med <= 0.15;
    if (!stable) continue;
    const intervals = ev.slice(1).map((x, i) => day(x.date) - day(ev[i].date));
    const minN = Math.min(...intervals), maxN = Math.max(...intervals);
    const medInt = median(intervals);
    const cad = cadenceFor(medInt);
    // A steady rhythm: at least 3 events (2 intervals) that don't drift wildly, or 2 yearly events.
    const yearly = cad?.perYear === 1;
    const steady = cad && ev.length >= (yearly ? 2 : 3) && (yearly ? minN >= 320 : maxN <= medInt * 1.8 && minN >= medInt * 0.45);
    if (!steady || !cad) continue;
    const lastGap = now - day(ev[ev.length - 1].date);
    if (lastGap > Math.max(medInt * 1.5, medInt + 45)) continue; // looks ended
    const monthly = Math.round((med * cad.perYear) / 12);
    for (const x of ev) byAccount.get(x.accountId)!.fixedAmt += x.amt;
    items.push({ key: `m:${merchant}`, label: merchant, kind: 'fixed', detail: `${cad.label} · in ${g.accountName}`, monthly, annual: monthly * 12, lastDate: ev[ev.length - 1].date });
  }
  for (const [accountId, a] of byAccount) {
    const habitAmt = a.total - a.fixedAmt;
    if (a.months.size < 3 || habitAmt <= 0) continue;
    const monthly = Math.round(habitAmt / months);
    if (monthly < 100) continue;
    items.push({ key: `a:${accountId}`, label: a.name, kind: 'habit', detail: `average · ${a.count} transactions`, monthly, annual: monthly * 12, lastDate: today });
  }

  // Debt payments: money paid into liability accounts (borrowing excluded by the flow rule).
  const liab = (await db.prepare("SELECT id FROM accounts WHERE user_id = ? AND type = 'liability'").all(USER_ID)) as Array<{ id: number }>;
  const flows = await planFlows(db, liab.map((x) => Number(x.id)), today);
  const debtInWindow = flows.filter((f) => f.kind === 'contribution' && f.date >= from).reduce((s, f) => s + f.amount, 0);
  const debtMonthly = Math.round(debtInWindow / months);

  const income = (await db
    .prepare(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS g FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.user_id = ? AND a.type = 'income' AND e.date >= ? AND e.date <= ? AND e.reversal_of IS NULL AND e.reversed_by IS NULL`,
    )
    .get(USER_ID, from, today)) as { g: number };
  const incomeMonthly = Math.round(Number(income.g) / months);

  let hidden: string[] = [];
  try {
    const h = await getSetting(db, HIDDEN_KEY);
    hidden = h ? (JSON.parse(h) as string[]) : [];
  } catch {
    hidden = [];
  }
  const visible = items.filter((i) => !hidden.includes(i.key));
  const fixed = visible.filter((i) => i.kind === 'fixed').sort((x, y) => y.monthly - x.monthly);
  const habit = visible.filter((i) => i.kind === 'habit').sort((x, y) => y.monthly - x.monthly);
  const fixedMonthly = fixed.reduce((s, i) => s + i.monthly, 0);
  const habitMonthly = habit.reduce((s, i) => s + i.monthly, 0);
  return {
    monthsAnalyzed: Math.round(months * 10) / 10,
    incomeMonthly,
    fixed,
    habit,
    fixedMonthly,
    habitMonthly,
    debtMonthly,
    totalMonthly: fixedMonthly + habitMonthly + debtMonthly,
    leftoverMonthly: incomeMonthly - fixedMonthly - habitMonthly - debtMonthly,
    hiddenCount: items.length - visible.length,
  };
}

export async function setRecurringHidden(db: DB, key: string, hide: boolean) {
  if (key === '*' && !hide) {
    await setSetting(db, HIDDEN_KEY, null);
    return;
  }
  if (typeof key !== 'string' || key.length > 140 || !/^(m|a):/.test(key)) throw new ValidationError('Invalid item.');
  let hidden: string[] = [];
  try {
    const h = await getSetting(db, HIDDEN_KEY);
    hidden = h ? (JSON.parse(h) as string[]).filter((x) => typeof x === 'string') : [];
  } catch {
    hidden = [];
  }
  hidden = hidden.filter((x) => x !== key);
  if (hide) hidden.push(key);
  await setSetting(db, HIDDEN_KEY, hidden.length ? JSON.stringify(hidden.slice(-200)) : null);
}
