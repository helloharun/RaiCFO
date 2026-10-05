import type { DB } from '../db.js';
import { BASE_CURRENCY, fromCents, isValidISODate, toCents } from '../money.js';
import { type Account, type EntryInput, ValidationError, isDebitNormal } from '../types.js';

export const USER_ID = 1;

export function audit(db: DB, action: string, entity: string, entityId: number | null, details?: unknown): void {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
    USER_ID,
    action,
    entity,
    entityId,
    details === undefined ? null : JSON.stringify(details),
  );
}

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(USER_ID, key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string | null): void {
  db.prepare(
    'INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
  ).run(USER_ID, key, value);
}

export function listAccounts(db: DB, includeInactive = true): Account[] {
  return db
    .prepare(`SELECT * FROM accounts WHERE user_id = ? ${includeInactive ? '' : 'AND is_active = 1'} ORDER BY code`)
    .all(USER_ID) as Account[];
}

export function getAccount(db: DB, id: number): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(id, USER_ID) as Account | undefined;
}

export function getAccountByCode(db: DB, code: string): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE code = ? AND user_id = ?').get(code, USER_ID) as Account | undefined;
}

export function fxRate(db: DB, currency: string, date: string): number {
  const cur = currency.toUpperCase();
  if (cur === BASE_CURRENCY) return 1;
  const row = db
    .prepare('SELECT rate FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1')
    .get(cur, date) as { rate: number } | undefined;
  if (!row) throw new ValidationError(`No exchange rate configured for ${cur}. Add one in Settings.`);
  return row.rate;
}

function securityId(db: DB, symbol: string, currency: string): number {
  const sym = symbol.trim().toUpperCase();
  const row = db.prepare('SELECT id FROM securities WHERE user_id = ? AND symbol = ?').get(USER_ID, sym) as { id: number } | undefined;
  if (row) return row.id;
  return Number(db.prepare('INSERT INTO securities (user_id, symbol, currency) VALUES (?, ?, ?)').run(USER_ID, sym, currency).lastInsertRowid);
}

export interface NormalizedLine {
  accountId: number;
  debit: number;
  credit: number;
  originalDebit: number;
  originalCredit: number;
  memo: string | null;
  securityId: number | null;
  quantity: number | null;
}

/** Validates an entry and converts amounts to integer cents (original + CAD base). Throws ValidationError. */
export function validateEntry(db: DB, input: EntryInput, opts: { skipLock?: boolean; reversalOf?: number } = {}): { lines: NormalizedLine[]; currency: string; fxRate: number } {
  const errors: string[] = [];
  if (!isValidISODate(input.date)) errors.push('A valid date (YYYY-MM-DD) is required.');
  if (!input.description || !input.description.trim()) errors.push('A description is required.');
  if (!Array.isArray(input.lines) || input.lines.length < 2) errors.push('A journal entry needs at least two lines.');
  if (errors.length) throw new ValidationError(errors.join(' '), errors);

  const lockDate = getSetting(db, 'lock_date');
  if (!opts.skipLock && lockDate && input.date <= lockDate) {
    throw new ValidationError(`The books are locked through ${lockDate}. Choose a later date or change the lock date in Settings.`);
  }

  const currency = (input.currency || BASE_CURRENCY).toUpperCase();
  const rate = input.fxRate && input.fxRate > 0 ? input.fxRate : fxRate(db, currency, input.date);

  const lines: NormalizedLine[] = [];
  input.lines.forEach((l, i) => {
    const acct = getAccount(db, Number(l.accountId));
    const od = toCents(Number(l.debit || 0));
    const oc = toCents(Number(l.credit || 0));
    if (!acct) errors.push(`Line ${i + 1}: account not found.`);
    else if (!acct.is_active) errors.push(`Line ${i + 1}: account "${acct.name}" is inactive.`);
    if (!Number.isFinite(od) || !Number.isFinite(oc) || od < 0 || oc < 0) errors.push(`Line ${i + 1}: amounts must be positive numbers.`);
    if (od > 0 && oc > 0) errors.push(`Line ${i + 1}: a line cannot have both a debit and a credit.`);
    if (od === 0 && oc === 0) errors.push(`Line ${i + 1}: a line needs a debit or a credit amount.`);
    let secId: number | null = l.securityId ?? null;
    if (!secId && l.symbol && l.symbol.trim()) secId = securityId(db, l.symbol, currency);
    lines.push({
      accountId: Number(l.accountId),
      originalDebit: od,
      originalCredit: oc,
      debit: Math.round(od * rate),
      credit: Math.round(oc * rate),
      memo: l.memo ?? null,
      securityId: secId,
      quantity: l.quantity === undefined || l.quantity === null || Number.isNaN(Number(l.quantity)) ? null : Number(l.quantity),
    });
  });
  if (errors.length) throw new ValidationError(errors.join(' '), errors);

  const od = lines.reduce((s, l) => s + l.originalDebit, 0);
  const oc = lines.reduce((s, l) => s + l.originalCredit, 0);
  if (od !== oc) {
    throw new ValidationError(
      `Entry does not balance: debits ${fromCents(od).toFixed(2)} ≠ credits ${fromCents(oc).toFixed(2)} (difference ${fromCents(od - oc).toFixed(2)}).`,
    );
  }

  if (!opts.reversalOf && input.source !== 'reversal') {
    const sold = new Map<string, number>();
    for (const l of lines) {
      if (l.securityId && l.quantity && l.quantity < 0) {
        const k = `${l.accountId}:${l.securityId}`;
        sold.set(k, (sold.get(k) ?? 0) + l.quantity);
      }
    }
    for (const [k, qty] of sold) {
      const [accountId, secId] = k.split(':').map(Number);
      const heldAt = (to: string) =>
        (db
          .prepare(
            `SELECT COALESCE(SUM(l.quantity),0) AS q FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
             WHERE e.user_id = ? AND l.account_id = ? AND l.security_id = ? AND e.date <= ?`,
          )
          .get(USER_ID, accountId, secId, to) as { q: number }).q;
      const held = Math.min(heldAt(input.date), heldAt('9999-12-31'));
      if (held + qty < -1e-9) {
        const sym = (db.prepare('SELECT symbol FROM securities WHERE id = ?').get(secId) as { symbol: string } | undefined)?.symbol ?? 'security';
        const acct = getAccount(db, accountId)?.name ?? 'account';
        throw new ValidationError(`Cannot sell ${Math.abs(qty)} ${sym} from ${acct}: only ${Math.round(held * 1e8) / 1e8} held on ${input.date}. Short sales are not supported.`);
      }
    }
  }

  // FX rounding can leave a cent of difference in base currency; absorb it on the largest line.
  const bd = lines.reduce((s, l) => s + l.debit, 0);
  const bc = lines.reduce((s, l) => s + l.credit, 0);
  const diff = bd - bc;
  if (diff !== 0) {
    const side = diff > 0 ? 'credit' : 'debit';
    const target = lines.filter((l) => l[side] > 0).sort((a, b) => b[side] - a[side])[0];
    target[side] += Math.abs(diff);
  }
  return { lines, currency, fxRate: rate };
}

export function postEntry(db: DB, input: EntryInput, opts: { skipLock?: boolean; reversalOf?: number } = {}): number {
  const { lines, currency, fxRate: rate } = validateEntry(db, input, opts);
  return db.transaction(() => {
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO journal_entries (user_id, date, description, payee, memo, transaction_type, source, currency, fx_rate,
            raw_input, explanation, metadata, import_hash, reversal_of, recurring_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          USER_ID,
          input.date,
          input.description.trim(),
          input.payee ?? null,
          input.memo ?? null,
          input.transactionType ?? 'manual',
          input.source ?? 'manual',
          currency,
          rate,
          input.rawInput ?? null,
          input.explanation ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          input.importHash ?? null,
          opts.reversalOf ?? null,
          input.recurringId ?? null,
        ).lastInsertRowid,
    );
    const ins = db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, original_debit, original_credit, memo, security_id, quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) ins.run(entryId, l.accountId, l.debit, l.credit, l.originalDebit, l.originalCredit, l.memo, l.securityId, l.quantity);
    audit(db, opts.reversalOf ? 'reverse' : 'post', 'journal_entry', entryId, {
      date: input.date,
      description: input.description,
      source: input.source ?? 'manual',
      lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
    });
    learnMerchantRule(db, input, lines);
    return entryId;
  })();
}

function learnMerchantRule(db: DB, input: EntryInput, lines: NormalizedLine[]): void {
  const payee = input.payee?.trim().toLowerCase();
  if (!payee || payee.length < 3 || input.source === 'opening' || input.source === 'reversal') return;
  const categoryLines = lines.filter((l) => {
    const a = getAccount(db, l.accountId);
    return a && (a.type === 'expense' || a.type === 'income');
  });
  if (categoryLines.length !== 1) return;
  db.prepare(
    `INSERT INTO merchant_rules (user_id, pattern, account_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, pattern) DO UPDATE SET account_id = excluded.account_id, hits = hits + 1`,
  ).run(USER_ID, payee, categoryLines[0].accountId);
}

export interface EntryWithLines {
  id: number;
  date: string;
  description: string;
  payee: string | null;
  memo: string | null;
  transaction_type: string;
  source: string;
  currency: string;
  fx_rate: number;
  raw_input: string | null;
  explanation: string | null;
  metadata: string | null;
  reversal_of: number | null;
  reversed_by: number | null;
  recurring_id: number | null;
  created_at: string;
  lines: Array<{
    id: number;
    account_id: number;
    account_name: string;
    account_code: string;
    account_type: string;
    debit: number;
    credit: number;
    original_debit: number;
    original_credit: number;
    memo: string | null;
    symbol: string | null;
    quantity: number | null;
    cleared: number;
    reconciliation_id: number | null;
  }>;
}

export function getEntry(db: DB, id: number): EntryWithLines | undefined {
  const e = db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').get(id, USER_ID) as EntryWithLines | undefined;
  if (!e) return undefined;
  e.lines = linesFor(db, [id]).get(id) ?? [];
  return e;
}

function linesFor(db: DB, ids: number[]): Map<number, EntryWithLines['lines']> {
  const map = new Map<number, EntryWithLines['lines']>();
  if (!ids.length) return map;
  const rows = db
    .prepare(
      `SELECT l.*, a.name AS account_name, a.code AS account_code, a.type AS account_type, s.symbol
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id LEFT JOIN securities s ON s.id = l.security_id
       WHERE l.entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY l.entry_id, (l.debit = 0), l.id`,
    )
    .all(...ids) as Array<EntryWithLines['lines'][number] & { entry_id: number }>;
  for (const r of rows) {
    if (!map.has(r.entry_id)) map.set(r.entry_id, []);
    map.get(r.entry_id)!.push(r);
  }
  return map;
}

export interface EntryFilter {
  from?: string;
  to?: string;
  accountId?: number;
  search?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

export function listEntries(db: DB, f: EntryFilter = {}): { entries: EntryWithLines[]; total: number } {
  const where = ['e.user_id = ?'];
  const params: unknown[] = [USER_ID];
  if (f.from) (where.push('e.date >= ?'), params.push(f.from));
  if (f.to) (where.push('e.date <= ?'), params.push(f.to));
  if (f.type) (where.push('e.transaction_type = ?'), params.push(f.type));
  if (f.accountId) (where.push('EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND x.account_id = ?)'), params.push(f.accountId));
  if (f.search) {
    where.push('(e.description LIKE ? OR e.payee LIKE ? OR e.memo LIKE ? OR e.raw_input LIKE ?)');
    const s = `%${f.search}%`;
    params.push(s, s, s, s);
  }
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM journal_entries e WHERE ${w}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT e.* FROM journal_entries e WHERE ${w} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.limit ?? 100, f.offset ?? 0) as EntryWithLines[];
  const lines = linesFor(db, rows.map((r) => r.id));
  rows.forEach((r) => (r.lines = lines.get(r.id) ?? []));
  return { entries: rows, total };
}

/** Reverses (voids) an entry by posting an equal-and-opposite entry. Posted entries are never deleted. */
export function reverseEntry(db: DB, id: number, opts: { date?: string; reason?: string } = {}): number {
  const e = getEntry(db, id);
  if (!e) throw new ValidationError('Entry not found.');
  if (e.reversed_by) throw new ValidationError('This entry has already been reversed.');
  if (e.reversal_of) throw new ValidationError('A reversal entry cannot itself be reversed. Post a new entry instead.');
  const date = opts.date ?? e.date;
  return db.transaction(() => {
    const revId = postEntry(
      db,
      {
        date,
        description: `Reversal of #${e.id}: ${e.description}`,
        payee: e.payee,
        memo: opts.reason ?? null,
        transactionType: e.transaction_type,
        source: 'reversal',
        currency: e.currency,
        fxRate: e.fx_rate,
        lines: e.lines.map((l) => ({
          accountId: l.account_id,
          debit: fromCents(l.original_credit),
          credit: fromCents(l.original_debit),
          memo: l.memo,
          symbol: l.symbol,
          quantity: l.quantity === null ? null : -l.quantity,
        })),
      },
      { reversalOf: e.id },
    );
    db.prepare('UPDATE journal_entries SET reversed_by = ? WHERE id = ?').run(revId, e.id);
    return revId;
  })();
}

export interface Balance {
  debit: number;
  credit: number;
  /** Balance in the account's normal direction (CAD cents). */
  balance: number;
  /** Balance in the account's own currency (cents), normal direction. */
  nativeBalance: number;
}

/** Account balances (CAD cents) from the ledger, optionally limited to a date window. */
export function accountBalances(db: DB, opts: { from?: string; to?: string } = {}): Map<number, Balance> {
  const where = ['e.user_id = ?'];
  const params: unknown[] = [USER_ID];
  if (opts.from) (where.push('e.date >= ?'), params.push(opts.from));
  if (opts.to) (where.push('e.date <= ?'), params.push(opts.to));
  const rows = db
    .prepare(
      `SELECT a.id, a.type, a.currency, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit,
         COALESCE(SUM(CASE WHEN e.currency = a.currency THEN l.original_debit - l.original_credit ELSE (l.debit - l.credit) END),0) AS native
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE ${where.join(' AND ')} GROUP BY a.id`,
    )
    .all(...params) as Array<{ id: number; type: Account['type']; currency: string; debit: number; credit: number; native: number }>;
  const map = new Map<number, Balance>();
  for (const r of rows) {
    const sign = isDebitNormal(r.type) ? 1 : -1;
    map.set(r.id, { debit: r.debit, credit: r.credit, balance: sign * (r.debit - r.credit), nativeBalance: sign * r.native });
  }
  return map;
}

export function balanceOf(db: DB, accountId: number, to?: string): number {
  return accountBalances(db, { to }).get(accountId)?.balance ?? 0;
}
