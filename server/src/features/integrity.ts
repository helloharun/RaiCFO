import type { DB } from '../db.js';
import { todayISO } from '../money.js';
import { USER_ID } from '../engine/ledger.js';
import { balanceSheet, trialBalance } from '../engine/reports.js';
import { holdings } from '../engine/investments.js';

type Status = 'pass' | 'warn' | 'fail';

export function integrityCheck(db: DB, asOf = todayISO()) {
  const checks: Array<{ name: string; status: Status; detail: string }> = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });

  const ic = db.pragma('integrity_check', { simple: true }) as string;
  add('Database file integrity', ic === 'ok' ? 'pass' : 'fail', ic === 'ok' ? 'SQLite integrity_check passed.' : String(ic));
  const fk = db.pragma('foreign_key_check') as unknown[];
  add('Referential integrity', fk.length ? 'fail' : 'pass', fk.length ? `${fk.length} broken reference(s).` : 'All foreign keys valid.');

  const unbalanced = db
    .prepare('SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.user_id = ? GROUP BY e.id HAVING SUM(l.debit) <> SUM(l.credit) LIMIT 20')
    .all(USER_ID) as Array<{ id: number }>;
  add('Every entry balances (Dr = Cr)', unbalanced.length ? 'fail' : 'pass', unbalanced.length ? `Unbalanced entries: ${unbalanced.map((x) => '#' + x.id).join(', ')}` : 'All journal entries balance.');

  const short = db
    .prepare('SELECT e.id FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id WHERE e.user_id = ? GROUP BY e.id HAVING COUNT(l.id) < 2 LIMIT 20')
    .all(USER_ID) as Array<{ id: number }>;
  add('Entries have at least two lines', short.length ? 'fail' : 'pass', short.length ? `Entries: ${short.map((x) => '#' + x.id).join(', ')}` : 'OK');

  const tb = trialBalance(db, asOf);
  add('Trial balance', tb.balanced ? 'pass' : 'fail', `Debits ${(tb.totalDebit / 100).toFixed(2)} / Credits ${(tb.totalCredit / 100).toFixed(2)}`);

  const bs = balanceSheet(db, asOf) as unknown as { balanced?: boolean; totalAssets?: number; totalLiabilitiesAndEquity?: number };
  add('Accounting equation (A = L + E)', bs.balanced === false ? 'fail' : 'pass', bs.balanced === false ? 'Balance sheet does not balance.' : 'Assets = Liabilities + Equity.');

  const badRev = db
    .prepare(
      `SELECT e.id FROM journal_entries e LEFT JOIN journal_entries r ON r.id = e.reversed_by
       WHERE e.user_id = ? AND e.reversed_by IS NOT NULL AND (r.id IS NULL OR r.reversal_of <> e.id) LIMIT 20`,
    )
    .all(USER_ID) as Array<{ id: number }>;
  add('Reversal links consistent', badRev.length ? 'fail' : 'pass', badRev.length ? `Entries: ${badRev.map((x) => '#' + x.id).join(', ')}` : 'OK');

  const neg = holdings(db, { asOf }).filter((h) => h.quantity < -1e-9);
  add('No negative investment holdings', neg.length ? 'fail' : 'pass', neg.length ? neg.map((h) => `${h.symbol} ${h.quantity}`).join(', ') : 'OK');

  const inactive = db
    .prepare(
      `SELECT a.name FROM accounts a JOIN journal_lines l ON l.account_id = a.id JOIN journal_entries e ON e.id = l.entry_id
       WHERE a.is_active = 0 AND e.date <= ? GROUP BY a.id HAVING SUM(l.debit) - SUM(l.credit) <> 0`,
    )
    .all(asOf) as Array<{ name: string }>;
  add('Inactive accounts have zero balance', inactive.length ? 'warn' : 'pass', inactive.length ? inactive.map((x) => x.name).join(', ') : 'OK');

  const future = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE user_id = ? AND date > ?').get(USER_ID, asOf) as { n: number }).n;
  add('Future-dated entries', future ? 'warn' : 'pass', future ? `${future} entr${future === 1 ? 'y is' : 'ies are'} dated after ${asOf}.` : 'None');

  const status: Status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return { asOf, status, checkedAt: new Date().toISOString(), checks };
}
