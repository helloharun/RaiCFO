import express, { type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db.js';
import type { AppConfig } from '../config.js';
import { fromCents, isValidISODate, todayISO } from '../money.js';
import { ValidationError } from '../types.js';
import { USER_ID, audit, getAccount } from '../engine/ledger.js';
import { generalLedger, trialBalance, balanceSheet, incomeStatement } from '../engine/reports.js';
import { BACKUP_FORMAT, createBackup, encryptBuffer } from '../features/backup.js';
import { debtPlan, deleteGoal, financialHealth, forecast, listGoals, upsertGoal } from '../features/planning.js';
import { integrityCheck } from '../features/integrity.js';
import { toCsv } from '../security/csv.js';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};
const posId = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError('Invalid id.');
  return n;
};
const date = (v: unknown, fb: string) => {
  if (v === undefined || v === '') return fb;
  if (typeof v !== 'string' || !isValidISODate(v)) throw new ValidationError('Invalid date.');
  return v;
};
const stampName = () => new Date().toISOString().slice(0, 10);

function sendCsv(res: Response, name: string, header: string[], rows: unknown[][]) {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.send('\uFEFF' + toCsv(header, rows));
}

export function featureRouter(db: DB, cfg: AppConfig) {
  const r = express.Router();
  const t = () => todayISO();
  const money = (c: number) => fromCents(c).toFixed(2);

  /* ---------- Ledger downloads ---------- */
  r.get('/export/general-ledger.csv', h(async (req, res) => {
    const from = date(req.query.from, '1900-01-01');
    const to = date(req.query.to, t());
    const accountId = req.query.accountId ? posId(req.query.accountId) : undefined;
    const gl = await generalLedger(db, from, to, accountId);
    const rows: unknown[][] = [];
    for (const a of gl.accounts) {
      rows.push([a.code, a.name, a.type, from, '', 'Opening balance', '', '', '', money(a.openingBalance)]);
      for (const l of a.rows) rows.push([a.code, a.name, a.type, l.date, l.entry_id, l.description, l.payee, money(l.debit), money(l.credit), money(l.balance)]);
      rows.push([a.code, a.name, a.type, to, '', 'Closing balance', '', '', '', money(a.closingBalance)]);
    }
    sendCsv(res, `general-ledger-${from}-to-${to}.csv`, ['account_code', 'account', 'type', 'date', 'entry_id', 'description', 'payee', 'debit', 'credit', 'balance'], rows);
  }));

  r.get('/export/trial-balance.csv', h(async (req, res) => {
    const asOf = date(req.query.asOf, t());
    const tb = await trialBalance(db, asOf);
    const rows: unknown[][] = tb.rows.map((x) => [x.code, x.name, x.type, money(x.debit), money(x.credit)]);
    rows.push(['', 'TOTAL', '', money(tb.totalDebit), money(tb.totalCredit)]);
    sendCsv(res, `trial-balance-${asOf}.csv`, ['account_code', 'account', 'type', 'debit', 'credit'], rows);
  }));

  r.get('/export/accounts.csv', h(async (_req, res) => {
    const rows = await db.prepare('SELECT code, name, type, subtype, currency, institution, is_active, interest_rate, min_payment FROM accounts WHERE user_id = ? ORDER BY sort_order, code').all(USER_ID) as Array<Record<string, unknown>>;
    sendCsv(res, 'chart-of-accounts.csv', ['code', 'name', 'type', 'subtype', 'currency', 'institution', 'active', 'interest_rate', 'min_payment'],
      rows.map((x) => [x.code, x.name, x.type, x.subtype, x.currency, x.institution, x.is_active ? 'yes' : 'no', x.interest_rate, x.min_payment === null ? '' : money(x.min_payment as number)]));
  }));

  r.get('/export/ledger.json', h(async (_req, res) => {
    const all = (sql: string) => db.prepare(sql).all(USER_ID);
    const payload = {
      app: 'Personal Finance HQ',
      format: 'pfhq-export-v1',
      exportedAt: new Date().toISOString(),
      baseCurrency: 'CAD',
      amountsIn: 'cents',
      accounts: await all('SELECT * FROM accounts WHERE user_id = ? ORDER BY code'),
      journalEntries: await all('SELECT * FROM journal_entries WHERE user_id = ? ORDER BY date, id'),
      journalLines: await all('SELECT l.* FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.user_id = ? ORDER BY l.entry_id, l.id'),
      securities: await all('SELECT * FROM securities WHERE user_id = ?'),
      budgets: await all('SELECT * FROM budgets WHERE user_id = ?'),
      recurring: await all('SELECT * FROM recurring_transactions WHERE user_id = ?'),
      goals: await all('SELECT * FROM goals WHERE user_id = ?'),
      reconciliations: await all('SELECT * FROM reconciliations WHERE user_id = ?'),
      merchantRules: await all('SELECT * FROM merchant_rules WHERE user_id = ?'),
      fxRates: await db.prepare('SELECT * FROM fx_rates').all(),
      settings: await all('SELECT key, value FROM settings WHERE user_id = ?'),
      auditLog: await all('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id'),
      reports: { trialBalance: (await trialBalance(db, t())), balanceSheet: (await balanceSheet(db, t())), incomeStatementYtd: (await incomeStatement(db, `${t().slice(0, 4)}-01-01`, t())) },
    };
    await audit(db, 'export', 'ledger', null, { format: 'json' });
    res.setHeader('content-disposition', `attachment; filename="personal-finance-ledger-${stampName()}.json"`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(payload, null, 2));
  }));

  /* ---------- Restorable backups (all tables, never sessions) ---------- */
  r.get('/backups', h(() => ({ encrypted: Boolean(cfg.BACKUP_ENCRYPTION_KEY), format: BACKUP_FORMAT })));
  r.get('/export/backup.json', h(async (_req, res) => {
    const body = Buffer.from(JSON.stringify(await createBackup(db)), 'utf8');
    await audit(db, 'export', 'backup', null, { encrypted: false });
    res.setHeader('content-disposition', `attachment; filename="personal-finance-backup-${stampName()}.json"`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(body);
  }));
  r.get('/export/backup.json.enc', h(async (_req, res) => {
    if (!cfg.BACKUP_ENCRYPTION_KEY) throw new ValidationError('Set BACKUP_ENCRYPTION_KEY to enable encrypted backups.');
    const body = encryptBuffer(Buffer.from(JSON.stringify(await createBackup(db)), 'utf8'), cfg.BACKUP_ENCRYPTION_KEY);
    await audit(db, 'export', 'backup', null, { encrypted: true });
    res.setHeader('content-disposition', `attachment; filename="personal-finance-backup-${stampName()}.json.enc"`);
    res.setHeader('content-type', 'application/octet-stream');
    res.send(body);
  }));

  /* ---------- Integrity ---------- */
  r.get('/integrity', h((req) => integrityCheck(db, date(req.query.asOf, t()))));

  /* ---------- Goals & planning ---------- */
  r.get('/goals', h(() => listGoals(db)));
  r.post('/goals', h(async (req) => ({ id: (await upsertGoal(db, req.body ?? {})) })));
  r.put('/goals/:id', h(async (req) => ({ id: (await upsertGoal(db, req.body ?? {}, posId(req.params.id))) })));
  r.delete('/goals/:id', h(async (req) => ((await deleteGoal(db, posId(req.params.id))), { ok: true })));
  r.get('/planning/health', h(() => financialHealth(db)));
  r.get('/planning/forecast', h((req) => forecast(db, req.query.days ? Number(req.query.days) : 60)));
  r.post('/planning/debt', h((req) => debtPlan(db, req.body ?? {})));
  r.put('/accounts/:id/debt-terms', h(async (req) => {
    const a = await getAccount(db, posId(req.params.id));
    if (!a || a.type !== 'liability') throw new ValidationError('Liability account not found.');
    const apr = req.body?.interestRate === null || req.body?.interestRate === '' ? null : Number(req.body?.interestRate);
    const min = req.body?.minPayment === null || req.body?.minPayment === '' ? null : Number(req.body?.minPayment);
    if (apr !== null && (!Number.isFinite(apr) || apr < 0 || apr > 100)) throw new ValidationError('Interest rate must be between 0 and 100%.');
    if (min !== null && (!Number.isFinite(min) || min < 0 || min > 1e9)) throw new ValidationError('Minimum payment must be zero or more.');
    await db.prepare('UPDATE accounts SET interest_rate = ?, min_payment = ? WHERE id = ?').run(apr, min === null ? null : Math.round(min * 100), a.id);
    await audit(db, 'update_debt_terms', 'account', a.id, { apr, min });
    return { ok: true };
  }));

  return r;
}
