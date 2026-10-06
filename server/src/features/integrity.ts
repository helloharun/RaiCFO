import type { DB } from '../db.js';
import { todayISO } from '../money.js';
import { USER_ID } from '../engine/ledger.js';
import { balanceSheet, trialBalance } from '../engine/reports.js';
import { holdings } from '../engine/investments.js';

type Status = 'pass' | 'warn' | 'fail';

export async function integrityCheck(db: DB, asOf = todayISO()) {
  const checks: Array<{ name: string; status: Status; detail: string }> = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });

  const trg = (await db.prepare(
    `SELECT COUNT(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = current_schema()::regnamespace AND t.tgname LIKE 'trg\\_%' AND t.tgenabled <> 'D'`,
  ).get()) as { n: number };
  add('Ledger protection triggers', trg.n >= 7 ? 'pass' : 'fail', trg.n >= 7 ? `${trg.n} append-only triggers active (deletes, amount edits, truncation and audit edits are blocked).` : `Only ${trg.n} protection triggers are active.`);
  const lines = (await db.prepare('SELECT COUNT(*) AS n FROM journal_lines l LEFT JOIN accounts a ON a.id = l.account_id LEFT JOIN journal_entries e ON e.id = l.entry_id WHERE a.id IS NULL OR e.id IS NULL').get()) as { n: number };
  add('Referential integrity', lines.n ? 'fail' : 'pass', lines.n ? `${lines.n} orphaned journal line(s).` : 'All journal lines reference valid entries and accounts (enforced by foreign keys).');

  const unbalanced = (await db
    .prepare('SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.user_id = ? GROUP BY e.id HAVING SUM(l.debit) <> SUM(l.credit) LIMIT 20')
    .all(USER_ID)) as Array<{ id: number }>;
  add('Every entry balances (Dr = Cr)', unbalanced.length ? 'fail' : 'pass', unbalanced.length ? `Unbalanced entries: ${unbalanced.map((x) => '#' + x.id).join(', ')}` : 'All journal entries balance.');

  const short = (await db
    .prepare('SELECT e.id FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id WHERE e.user_id = ? GROUP BY e.id HAVING COUNT(l.id) < 2 LIMIT 20')
    .all(USER_ID)) as Array<{ id: number }>;
  add('Entries have at least two lines', short.length ? 'fail' : 'pass', short.length ? `Entries: ${short.map((x) => '#' + x.id).join(', ')}` : 'OK');

  const tb = await trialBalance(db, asOf);
  add('Trial balance', tb.balanced ? 'pass' : 'fail', `Debits ${(tb.totalDebit / 100).toFixed(2)} / Credits ${(tb.totalCredit / 100).toFixed(2)}`);

  const bs = (await balanceSheet(db, asOf)) as unknown as { balanced?: boolean; totalAssets?: number; totalLiabilitiesAndEquity?: number };
  add('Accounting equation (A = L + E)', bs.balanced === false ? 'fail' : 'pass', bs.balanced === false ? 'Balance sheet does not balance.' : 'Assets = Liabilities + Equity.');

  const badRev = (await db
    .prepare(
      `SELECT e.id FROM journal_entries e LEFT JOIN journal_entries r ON r.id = e.reversed_by
       WHERE e.user_id = ? AND e.reversed_by IS NOT NULL AND (r.id IS NULL OR r.reversal_of <> e.id) LIMIT 20`,
    )
    .all(USER_ID)) as Array<{ id: number }>;
  add('Reversal links consistent', badRev.length ? 'fail' : 'pass', badRev.length ? `Entries: ${badRev.map((x) => '#' + x.id).join(', ')}` : 'OK');

  const neg = (await holdings(db, { asOf })).filter((h) => h.quantity < -1e-9);
  add('No negative investment holdings', neg.length ? 'fail' : 'pass', neg.length ? neg.map((h) => `${h.symbol} ${h.quantity}`).join(', ') : 'OK');

  const inactive = (await db
    .prepare(
      `SELECT a.name FROM accounts a JOIN journal_lines l ON l.account_id = a.id JOIN journal_entries e ON e.id = l.entry_id
       WHERE a.is_active = 0 AND e.date <= ? GROUP BY a.id HAVING SUM(l.debit) - SUM(l.credit) <> 0`,
    )
    .all(asOf)) as Array<{ name: string }>;
  add('Inactive accounts have zero balance', inactive.length ? 'warn' : 'pass', inactive.length ? inactive.map((x) => x.name).join(', ') : 'OK');

  const future = (await db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE user_id = ? AND date > ?').get(USER_ID, asOf) as { n: number }).n;
  add('Future-dated entries', future ? 'warn' : 'pass', future ? `${future} entr${future === 1 ? 'y is' : 'ies are'} dated after ${asOf}.` : 'None');

  const status: Status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return { asOf, status, checkedAt: new Date().toISOString(), checks };
}
