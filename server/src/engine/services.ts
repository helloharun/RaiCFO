import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type { DB } from '../db.js';
import { addDays, addMonths, fromCents, isValidISODate, monthEnd, toCents, todayISO, toISO } from '../money.js';
import { type EntryInput, ValidationError } from '../types.js';
import { USER_ID, accountBalances, audit, getAccount, listAccounts, postEntry } from './ledger.js';

/* ---------------- Budgets ---------------- */

export function setBudget(db: DB, accountId: number, month: string, amount: number): void {
  const a = getAccount(db, accountId);
  if (!a || a.type !== 'expense') throw new ValidationError('Budgets can only be set on expense accounts.');
  if (month !== '*' && !/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Month must be YYYY-MM or * (default).');
  if (!amount) db.prepare('DELETE FROM budgets WHERE user_id = ? AND account_id = ? AND month = ?').run(USER_ID, accountId, month);
  else
    db.prepare(
      'INSERT INTO budgets (user_id, account_id, month, amount) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, account_id, month) DO UPDATE SET amount = excluded.amount',
    ).run(USER_ID, accountId, month, toCents(amount));
  audit(db, 'set_budget', 'budget', accountId, { month, amount });
}

export function budgetStatus(db: DB, month: string) {
  const from = `${month}-01`;
  const to = monthEnd(from);
  const bal = accountBalances(db, { from, to });
  const budgets = db.prepare('SELECT account_id, month, amount FROM budgets WHERE user_id = ? AND month IN (?, ?)').all(USER_ID, month, '*') as Array<{
    account_id: number;
    month: string;
    amount: number;
  }>;
  const today = todayISO();
  const daysInMonth = Number(to.slice(8));
  const elapsed = today < from ? 0 : today > to ? daysInMonth : Number(today.slice(8));
  const rows = listAccounts(db)
    .filter((a) => a.type === 'expense')
    .map((a) => {
      const specific = budgets.find((b) => b.account_id === a.id && b.month === month);
      const def = budgets.find((b) => b.account_id === a.id && b.month === '*');
      const budget = specific?.amount ?? def?.amount ?? 0;
      const actual = bal.get(a.id)?.balance ?? 0;
      return {
        accountId: a.id,
        code: a.code,
        name: a.name,
        isActive: a.is_active,
        budget,
        isDefault: !specific && Boolean(def),
        actual,
        remaining: budget - actual,
        pct: budget ? actual / budget : null,
        projected: elapsed ? Math.round((actual / elapsed) * daysInMonth) : actual,
      };
    })
    .filter((r) => r.isActive || r.actual || r.budget);
  return {
    month,
    rows,
    totalBudget: rows.reduce((s, r) => s + r.budget, 0),
    totalActual: rows.reduce((s, r) => s + r.actual, 0),
    budgetedActual: rows.filter((r) => r.budget).reduce((s, r) => s + r.actual, 0),
    elapsedFraction: elapsed / daysInMonth,
  };
}

/* ---------------- Reconciliation ---------------- */

export function startReconciliation(db: DB, accountId: number, statementDate: string, statementBalance: number): number {
  const a = getAccount(db, accountId);
  if (!a || !(a.type === 'asset' || a.type === 'liability')) throw new ValidationError('Choose a bank, cash, or credit-card account.');
  if (!isValidISODate(statementDate)) throw new ValidationError('Invalid statement date.');
  const open = db.prepare("SELECT id FROM reconciliations WHERE account_id = ? AND status = 'in_progress'").get(accountId) as { id: number } | undefined;
  if (open) return open.id;
  const id = Number(
    db.prepare('INSERT INTO reconciliations (user_id, account_id, statement_date, statement_balance) VALUES (?, ?, ?, ?)').run(USER_ID, accountId, statementDate, toCents(statementBalance))
      .lastInsertRowid,
  );
  audit(db, 'start', 'reconciliation', id, { accountId, statementDate, statementBalance });
  return id;
}

export function reconciliationDetail(db: DB, id: number) {
  const r = db.prepare('SELECT * FROM reconciliations WHERE id = ? AND user_id = ?').get(id, USER_ID) as
    | { id: number; account_id: number; statement_date: string; statement_balance: number; status: string; completed_at: string | null }
    | undefined;
  if (!r) throw new ValidationError('Reconciliation not found.');
  const a = getAccount(db, r.account_id)!;
  const sign = a.type === 'asset' ? 1 : -1;
  const lines = db
    .prepare(
      `SELECT l.id, l.debit, l.credit, l.cleared, l.reconciliation_id, e.id AS entry_id, e.date, e.description, e.payee
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.date <= ? AND (l.reconciliation_id IS NULL OR l.reconciliation_id = ?)
       ORDER BY e.date, e.id`,
    )
    .all(r.account_id, r.statement_date, id) as Array<{ id: number; debit: number; credit: number; cleared: number; reconciliation_id: number | null; entry_id: number; date: string; description: string; payee: string | null }>;
  const prev = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN reconciliations r ON r.id = l.reconciliation_id
       WHERE l.account_id = ? AND r.status = 'completed' AND r.id <> ?`,
    )
    .get(r.account_id, id) as { b: number };
  const previouslyReconciled = sign * prev.b;
  const clearedNow = lines.filter((l) => l.cleared && l.reconciliation_id === id).reduce((s, l) => s + sign * (l.debit - l.credit), 0);
  const clearedBalance = previouslyReconciled + clearedNow;
  const rows = lines.map((l) => ({ ...l, amount: sign * (l.debit - l.credit), isCleared: Boolean(l.cleared && l.reconciliation_id === id) }));
  const bookBalance = accountBalances(db, { to: r.statement_date }).get(r.account_id)?.balance ?? 0;
  return {
    ...r,
    account: a,
    rows,
    previouslyReconciled,
    clearedBalance,
    bookBalance,
    difference: r.statement_balance - clearedBalance,
  };
}

export function toggleCleared(db: DB, reconciliationId: number, lineId: number, cleared?: boolean): void {
  const r = reconciliationDetail(db, reconciliationId);
  if (r.status !== 'in_progress') throw new ValidationError('This reconciliation is already completed.');
  const line = r.rows.find((l) => l.id === lineId);
  if (!line) throw new ValidationError('Line is not part of this reconciliation.');
  const next = cleared ?? !line.isCleared;
  db.prepare('UPDATE journal_lines SET cleared = ?, reconciliation_id = ? WHERE id = ?').run(next ? 1 : 0, next ? reconciliationId : null, lineId);
}

export function completeReconciliation(db: DB, id: number): void {
  const r = reconciliationDetail(db, id);
  if (r.status !== 'in_progress') throw new ValidationError('Already completed.');
  if (r.difference !== 0) throw new ValidationError(`Cannot complete: cleared balance differs from the statement by ${fromCents(r.difference).toFixed(2)}.`);
  db.prepare("UPDATE reconciliations SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(id);
  audit(db, 'complete', 'reconciliation', id, { accountId: r.account_id, statementBalance: r.statement_balance });
}

export function cancelReconciliation(db: DB, id: number): void {
  const r = reconciliationDetail(db, id);
  if (r.status !== 'in_progress') throw new ValidationError('Completed reconciliations cannot be cancelled.');
  db.transaction(() => {
    db.prepare('UPDATE journal_lines SET cleared = 0, reconciliation_id = NULL WHERE reconciliation_id = ?').run(id);
    db.prepare('DELETE FROM reconciliations WHERE id = ?').run(id);
  })();
  audit(db, 'cancel', 'reconciliation', id);
}

/* ---------------- Recurring transactions ---------------- */

export const FREQUENCIES = ['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'] as const;

export function nextOccurrence(date: string, freq: string): string {
  switch (freq) {
    case 'daily':
      return addDays(date, 1);
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'semimonthly': {
      const d = Number(date.slice(8));
      return d < 15 ? `${date.slice(0, 8)}15` : `${addMonths(date.slice(0, 8) + '01', 1)}`;
    }
    case 'quarterly':
      return addMonths(date, 3);
    case 'yearly':
      return addMonths(date, 12);
    default:
      return addMonths(date, 1);
  }
}

export interface RecurringRow {
  id: number;
  description: string;
  frequency: string;
  next_date: string;
  end_date: string | null;
  template: string;
  auto_post: number;
  is_active: number;
}

export function runDueRecurring(db: DB, today = todayISO()): number[] {
  const due = db.prepare('SELECT * FROM recurring_transactions WHERE user_id = ? AND is_active = 1 AND auto_post = 1 AND next_date <= ?').all(USER_ID, today) as RecurringRow[];
  const posted: number[] = [];
  for (const r of due) {
    let next = r.next_date;
    let guard = 0;
    while (next <= today && (!r.end_date || next <= r.end_date) && guard++ < 400) {
      try {
        posted.push(postRecurringOnce(db, r, next));
      } catch (e) {
        audit(db, 'recurring_failed', 'recurring', r.id, { date: next, error: (e as Error).message });
        break;
      }
      next = nextOccurrence(next, r.frequency);
    }
    db.prepare('UPDATE recurring_transactions SET next_date = ?, is_active = ? WHERE id = ?').run(next, r.end_date && next > r.end_date ? 0 : 1, r.id);
  }
  return posted;
}

/** Posts the next scheduled occurrence immediately (optionally on another date) and advances the schedule. */
export function postRecurringNow(db: DB, r: RecurringRow, date = r.next_date): number {
  return db.transaction(() => {
    const entryId = postRecurringOnce(db, r, date);
    const next = nextOccurrence(r.next_date, r.frequency);
    db.prepare('UPDATE recurring_transactions SET next_date = ?, is_active = ? WHERE id = ?').run(next, r.end_date && next > r.end_date ? 0 : r.is_active, r.id);
    audit(db, 'post_now', 'recurring', r.id, { date, entryId, nextDate: next });
    return entryId;
  })();
}

export function postRecurringOnce(db: DB, r: RecurringRow, date: string): number {
  const tpl = JSON.parse(r.template) as Omit<EntryInput, 'date'>;
  return postEntry(db, { ...tpl, date, source: 'recurring', recurringId: r.id });
}

export function upsertRecurring(db: DB, input: { id?: number; description: string; frequency: string; nextDate: string; endDate?: string | null; autoPost?: boolean; template: Omit<EntryInput, 'date'> }): number {
  if (!FREQUENCIES.includes(input.frequency as (typeof FREQUENCIES)[number])) throw new ValidationError('Invalid frequency.');
  if (!isValidISODate(input.nextDate)) throw new ValidationError('Invalid next date.');
  // Validate the template by dry-running the balance check.
  const lines = input.template.lines ?? [];
  const d = lines.reduce((s, l) => s + toCents(Number(l.debit || 0)), 0);
  const c = lines.reduce((s, l) => s + toCents(Number(l.credit || 0)), 0);
  if (lines.length < 2 || d !== c || d === 0) throw new ValidationError('The recurring template must be a balanced journal entry.');
  const tpl = JSON.stringify({ ...input.template, description: input.template.description || input.description });
  if (input.id) {
    db.prepare('UPDATE recurring_transactions SET description = ?, frequency = ?, next_date = ?, end_date = ?, auto_post = ?, template = ? WHERE id = ? AND user_id = ?').run(
      input.description, input.frequency, input.nextDate, input.endDate ?? null, input.autoPost === false ? 0 : 1, tpl, input.id, USER_ID,
    );
    audit(db, 'update', 'recurring', input.id, input);
    return input.id;
  }
  const id = Number(
    db.prepare('INSERT INTO recurring_transactions (user_id, description, frequency, next_date, end_date, auto_post, template) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      USER_ID, input.description, input.frequency, input.nextDate, input.endDate ?? null, input.autoPost === false ? 0 : 1, tpl,
    ).lastInsertRowid,
  );
  audit(db, 'create', 'recurring', id, input);
  return id;
}

/* ---------------- CSV import ---------------- */

export interface CsvMapping {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  dateFormat?: 'auto' | 'YMD' | 'MDY' | 'DMY';
  invert?: boolean;
  hasHeader?: boolean;
}

function parseCsvDate(s: string, fmt: CsvMapping['dateFormat'] = 'auto'): string | null {
  const v = s.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(v)) {
    const [y, m, d] = v.slice(0, 10).split('-').map(Number);
    return toISO(new Date(y, m - 1, d));
  }
  const m = v.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/);
  if (m) {
    let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[1].length === 4) return toISO(new Date(a, b - 1, c));
    if (c < 100) c += 2000;
    let f = fmt;
    if (f === 'auto' || !f) f = a > 12 ? 'DMY' : 'MDY';
    if (f === 'DMY') [a, b] = [b, a];
    const out = toISO(new Date(c, a - 1, b));
    return isValidISODate(out) ? out : null;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : toISO(d);
}

const num = (s: unknown) => {
  if (s === undefined || s === null) return 0;
  let v = String(s).trim();
  const neg = /^\(.*\)$/.test(v) || /-/.test(v);
  v = v.replace(/[^0-9.]/g, '');
  const n = Number(v || 0);
  return neg ? -n : n;
};

export function guessMapping(headers: string[]): Partial<CsvMapping> {
  const find = (re: RegExp) => headers.find((h) => re.test(h.toLowerCase()));
  return {
    date: find(/date|posted/),
    description: find(/desc|payee|merchant|memo|details|name|transaction/),
    amount: find(/^amount$|amount|value/),
    debit: find(/debit|withdraw|out/),
    credit: find(/credit|deposit|in$/),
  };
}

export interface ImportRow {
  rowNumber: number;
  date: string | null;
  description: string;
  amount: number;
  counterAccountId: number | null;
  counterAccountName: string | null;
  importHash: string;
  duplicate: boolean;
  error?: string;
}

export function previewCsv(db: DB, csvText: string, accountId: number, mapping: CsvMapping, categorize: (description: string, inflow: boolean) => number | null) {
  const account = getAccount(db, accountId);
  if (!account) throw new ValidationError('Choose the account this statement belongs to.');
  const records = parse(csvText, { columns: mapping.hasHeader === false ? false : true, skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }) as unknown as Array<Record<string, string>>;
  const headers = records.length ? Object.keys(records[0]) : [];
  if (!mapping.date || !mapping.description || !(mapping.amount || mapping.debit || mapping.credit)) {
    return { headers, guessed: guessMapping(headers), rows: [] as ImportRow[] };
  }
  const rows: ImportRow[] = records.map((r, i) => {
    const date = parseCsvDate(r[mapping.date] ?? '', mapping.dateFormat);
    const description = (r[mapping.description] ?? '').trim();
    let amount = mapping.amount ? num(r[mapping.amount]) : num(r[mapping.credit ?? '']) - Math.abs(num(r[mapping.debit ?? '']));
    if (mapping.amount && mapping.debit && mapping.credit) amount = num(r[mapping.credit]) - Math.abs(num(r[mapping.debit]));
    if (mapping.invert) amount = -amount;
    amount = Math.round(amount * 100) / 100;
    const importHash = createHash('sha1').update(`${accountId}|${date}|${amount}|${description.toLowerCase()}`).digest('hex');
    const duplicate = Boolean(db.prepare('SELECT 1 FROM journal_entries WHERE import_hash = ? AND reversed_by IS NULL').get(importHash));
    const counter = amount ? categorize(description, amount > 0) : null;
    return {
      rowNumber: i + 1,
      date,
      description,
      amount,
      counterAccountId: counter,
      counterAccountName: counter ? getAccount(db, counter)?.name ?? null : null,
      importHash,
      duplicate,
      error: !date ? 'Unrecognised date' : !amount ? 'Zero amount' : undefined,
    };
  });
  return { headers, guessed: guessMapping(headers), rows };
}

export function commitCsv(db: DB, accountId: number, rows: Array<{ date: string; description: string; amount: number; counterAccountId: number; importHash?: string }>) {
  const account = getAccount(db, accountId);
  if (!account) throw new ValidationError('Account not found.');
  const posted: number[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  db.transaction(() => {
    rows.forEach((r, i) => {
      try {
        const amt = Math.abs(r.amount);
        const inflow = r.amount > 0;
        const counter = getAccount(db, r.counterAccountId);
        posted.push(
          postEntry(db, {
            date: r.date,
            description: r.description || 'Imported transaction',
            payee: r.description,
            source: 'csv',
            transactionType: counter?.type === 'expense' ? (account.subtype === 'credit_card' ? 'credit_card_purchase' : 'expense') : counter?.type === 'income' ? 'income' : 'transfer',
            importHash: r.importHash ?? null,
            lines: inflow
              ? [
                  { accountId, debit: amt },
                  { accountId: r.counterAccountId, credit: amt },
                ]
              : [
                  { accountId: r.counterAccountId, debit: amt },
                  { accountId, credit: amt },
                ],
          }),
        );
      } catch (e) {
        errors.push({ index: i, error: (e as Error).message });
      }
    });
  })();
  audit(db, 'import', 'csv', accountId, { posted: posted.length, errors: errors.length });
  return { posted, errors };
}

export function monthsBack(n: number, today = todayISO()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(`${today.slice(0, 7)}-01`, -i).slice(0, 7));
  return out;
}
