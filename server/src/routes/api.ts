import express, { type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db.js';
import { fromCents, isValidISODate, monthStart, toCents, todayISO } from '../money.js';
import { type EntryInput, SUBTYPES, TRANSACTION_TYPES, ValidationError } from '../types.js';
import {
  USER_ID, accountBalances, audit, getAccount, getEntry, getSetting, listAccounts, listEntries, postEntry, reverseEntry, setSetting, validateEntry,
} from '../engine/ledger.js';
import {
  balanceSheet, cashFlowStatement, equityStatement, generalLedger, incomeStatement, netWorthStatement, netWorthTrend, trialBalance,
} from '../engine/reports.js';
import { holdings } from '../engine/investments.js';
import {
  FREQUENCIES, type RecurringRow, budgetStatus, cancelReconciliation, commitCsv, completeReconciliation, postRecurringOnce, previewCsv,
  reconciliationDetail, runDueRecurring, setBudget, startReconciliation, toggleCleared, upsertRecurring,
} from '../engine/services.js';
import { dashboard } from '../engine/analytics.js';
import { buildProposal, type Interpretation } from '../ai/proposal.js';
import { findCategory, ruleInterpret } from '../ai/parser.js';
import { llmConfig, llmInterpret } from '../ai/llm.js';
import { ask } from '../ai/ask.js';
import { seedDemo } from '../scripts/demoData.js';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const dateQ = (v: unknown, fallback: string) => {
  const s = str(v);
  if (s && !isValidISODate(s)) throw new ValidationError(`Invalid date: ${s}`);
  return s ?? fallback;
};
const id = (req: Request) => Number(req.params.id);

export function apiRouter(db: DB) {
  const r = express.Router();

  r.get('/health', h(() => ({ ok: true })));

  r.get('/meta', h(() => {
    const cfg = llmConfig();
    return {
      baseCurrency: 'CAD',
      subtypes: SUBTYPES,
      transactionTypes: TRANSACTION_TYPES,
      frequencies: FREQUENCIES,
      ai: cfg ? { enabled: true, provider: cfg.provider, model: cfg.model } : { enabled: false },
      today: todayISO(),
    };
  }));

  /* ---------- Accounts ---------- */
  r.get('/accounts', h((req) => {
    const asOf = dateQ(req.query.asOf, todayISO());
    const bal = accountBalances(db, { to: asOf });
    return listAccounts(db, req.query.includeInactive !== 'false').map((a) => ({
      ...a,
      balance: bal.get(a.id)?.balance ?? 0,
      nativeBalance: bal.get(a.id)?.nativeBalance ?? 0,
      hasActivity: Boolean(db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(a.id)),
    }));
  }));

  const accountFields = (b: Record<string, unknown>, existing?: { type: string }) => {
    const type = String(b.type ?? existing?.type ?? '');
    if (!(type in SUBTYPES)) throw new ValidationError('Invalid account type.');
    const subtype = String(b.subtype ?? '');
    if (!SUBTYPES[type as keyof typeof SUBTYPES].includes(subtype)) throw new ValidationError(`Invalid subtype for ${type}.`);
    if (!String(b.name ?? '').trim()) throw new ValidationError('Name is required.');
    return {
      code: String(b.code ?? '').trim(),
      name: String(b.name).trim(),
      type,
      subtype,
      currency: String(b.currency ?? 'CAD').toUpperCase(),
      parent_id: b.parentId ? Number(b.parentId) : null,
      institution: (b.institution as string) || null,
      aliases: (b.aliases as string) || null,
      description: (b.description as string) || null,
    };
  };

  r.post('/accounts', h((req) => {
    const f = accountFields(req.body);
    if (!f.code) {
      const prefix = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 }[f.type as 'asset'];
      const max = db.prepare("SELECT MAX(CAST(code AS INTEGER)) AS m FROM accounts WHERE user_id = ? AND code LIKE ?").get(USER_ID, `${prefix}%`) as { m: number | null };
      f.code = String((max.m ?? prefix * 1000) + 5);
    }
    if (db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND code = ?').get(USER_ID, f.code)) throw new ValidationError(`Account code ${f.code} is already used.`);
    const newId = Number(
      db.prepare('INSERT INTO accounts (user_id, code, name, type, subtype, currency, parent_id, institution, aliases, description, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM accounts))')
        .run(USER_ID, f.code, f.name, f.type, f.subtype, f.currency, f.parent_id, f.institution, f.aliases, f.description).lastInsertRowid,
    );
    audit(db, 'create', 'account', newId, f);
    return getAccount(db, newId);
  }));

  r.put('/accounts/:id', h((req) => {
    const a = getAccount(db, id(req));
    if (!a) throw new ValidationError('Account not found.');
    const f = accountFields({ ...a, parentId: a.parent_id, ...req.body }, a);
    const used = db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(a.id);
    if (used && f.type !== a.type) throw new ValidationError('The type of an account with transactions cannot be changed. Create a new account instead.');
    if (f.parent_id === a.id) throw new ValidationError('An account cannot be its own parent.');
    if (f.code && f.code !== a.code && db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND code = ?').get(USER_ID, f.code)) throw new ValidationError(`Account code ${f.code} is already used.`);
    db.prepare("UPDATE accounts SET code = ?, name = ?, type = ?, subtype = ?, currency = ?, parent_id = ?, institution = ?, aliases = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
      .run(f.code || a.code, f.name, f.type, f.subtype, f.currency, f.parent_id, f.institution, f.aliases, f.description, a.id);
    audit(db, 'update', 'account', a.id, { before: a, after: f });
    return getAccount(db, a.id);
  }));

  r.post('/accounts/:id/:action', h((req) => {
    if (!['deactivate', 'reactivate'].includes(String(req.params.action))) throw new ValidationError('Unknown action.');
    const a = getAccount(db, id(req));
    if (!a) throw new ValidationError('Account not found.');
    const active = req.params.action === 'reactivate' ? 1 : 0;
    if (!active && a.is_system) throw new ValidationError('System accounts cannot be deactivated.');
    if (!active) {
      const bal = accountBalances(db).get(a.id)?.balance ?? 0;
      if (bal !== 0 && !req.body?.force) throw new ValidationError(`This account still has a balance of ${fromCents(bal).toFixed(2)}. Transfer it out first (or pass force).`);
    }
    db.prepare("UPDATE accounts SET is_active = ?, updated_at = datetime('now') WHERE id = ?").run(active, a.id);
    audit(db, active ? 'reactivate' : 'deactivate', 'account', a.id);
    return getAccount(db, a.id);
  }));

  r.delete('/accounts/:id', h((req, res) => {
    const a = getAccount(db, id(req));
    if (!a) throw new ValidationError('Account not found.');
    if (a.is_system) throw new ValidationError('System accounts cannot be deleted.');
    const refs = db.prepare('SELECT (SELECT COUNT(*) FROM journal_lines WHERE account_id = ?) + (SELECT COUNT(*) FROM budgets WHERE account_id = ?) + (SELECT COUNT(*) FROM merchant_rules WHERE account_id = ?) AS n').get(a.id, a.id, a.id) as { n: number };
    if (refs.n > 0) {
      res.status(409);
      return { error: 'This account has history and cannot be deleted. Deactivate it instead.' };
    }
    db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
    audit(db, 'delete', 'account', a.id, a);
    return { ok: true };
  }));

  r.post('/accounts/reorder', h((req) => {
    const ids: number[] = req.body?.ids ?? [];
    const upd = db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ? AND user_id = ?');
    db.transaction(() => ids.forEach((x, i) => upd.run(i, x, USER_ID)))();
    audit(db, 'reorder', 'account', null, { ids });
    return { ok: true };
  }));

  /* ---------- AI transaction interpretation ---------- */
  r.post('/ai/interpret', h(async (req) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw new ValidationError('Describe a transaction first.');
    const useLlm = req.body?.engine !== 'rules' && llmConfig();
    if (useLlm) {
      try {
        const interp = await llmInterpret(db, text);
        return buildProposal(db, interp, 'llm', text);
      } catch (e) {
        const p = buildProposal(db, ruleInterpret(db, text), 'rules', text);
        p.warnings.unshift(`AI interpretation failed (${(e as Error).message}); used the built-in parser.`);
        return p;
      }
    }
    return buildProposal(db, ruleInterpret(db, text), 'rules', text);
  }));

  r.post('/ai/rebuild', h((req) => {
    const interp = req.body?.interpretation as Interpretation;
    if (!interp) throw new ValidationError('Missing interpretation.');
    return buildProposal(db, { ...interp, clarifications: [] }, req.body?.engine === 'llm' ? 'llm' : 'rules', req.body?.rawInput);
  }));

  r.post('/ask', h(async (req) => {
    const q = String(req.body?.question ?? '').trim();
    if (!q) throw new ValidationError('Ask a question.');
    return ask(db, q);
  }));

  /* ---------- Journal ---------- */
  r.get('/journal', h((req) =>
    listEntries(db, {
      from: str(req.query.from),
      to: str(req.query.to),
      accountId: req.query.accountId ? Number(req.query.accountId) : undefined,
      search: str(req.query.search),
      type: str(req.query.type),
      limit: Math.min(Number(req.query.limit ?? 100), 1000),
      offset: Number(req.query.offset ?? 0),
    }),
  ));

  r.post('/journal/validate', h((req) => {
    try {
      const v = validateEntry(db, req.body as EntryInput);
      return { ok: true, totalDebit: v.lines.reduce((s, l) => s + l.debit, 0), totalCredit: v.lines.reduce((s, l) => s + l.credit, 0) };
    } catch (e) {
      if (e instanceof ValidationError) return { ok: false, error: e.message };
      throw e;
    }
  }));

  r.post('/journal', h((req) => {
    const entry = req.body as EntryInput;
    const entryId = postEntry(db, { ...entry, source: entry.source ?? 'manual' });
    return getEntry(db, entryId);
  }));

  r.get('/journal/:id', h((req) => {
    const e = getEntry(db, id(req));
    if (!e) throw new ValidationError('Entry not found.');
    return e;
  }));

  r.post('/journal/:id/reverse', h((req) => {
    const revId = reverseEntry(db, id(req), { date: str(req.body?.date), reason: str(req.body?.reason) });
    return getEntry(db, revId);
  }));

  r.post('/journal/:id/replace', h((req) => {
    const original = getEntry(db, id(req));
    if (!original) throw new ValidationError('Entry not found.');
    const newId = db.transaction(() => {
      reverseEntry(db, original.id, { reason: 'Edited' });
      return postEntry(db, { ...(req.body as EntryInput), source: original.source, metadata: { ...(req.body?.metadata ?? {}), replaces: original.id } });
    })();
    return getEntry(db, newId);
  }));

  r.get('/export/journal.csv', h((_req, res) => {
    const rows = db
      .prepare(
        `SELECT e.id, e.date, e.description, e.payee, e.transaction_type, a.code, a.name, l.debit, l.credit, l.memo
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.user_id = ? ORDER BY e.date, e.id, l.id`,
      )
      .all(USER_ID) as Array<Record<string, unknown>>;
    const esc = (v: unknown) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = ['entry_id,date,description,payee,type,account_code,account,debit,credit,memo']
      .concat(rows.map((r) => [r.id, r.date, r.description, r.payee, r.transaction_type, r.code, r.name, fromCents(r.debit as number).toFixed(2), fromCents(r.credit as number).toFixed(2), r.memo].map(esc).join(',')))
      .join('\n');
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="journal.csv"');
    res.send(csv);
  }));

  /* ---------- Reports ---------- */
  const t = () => todayISO();
  const range = (req: Request) => ({ from: dateQ(req.query.from, monthStart(t()).slice(0, 4) + '-01-01'), to: dateQ(req.query.to, t()) });
  r.get('/reports/trial-balance', h((req) => trialBalance(db, dateQ(req.query.asOf, t()))));
  r.get('/reports/balance-sheet', h((req) => balanceSheet(db, dateQ(req.query.asOf, t()))));
  r.get('/reports/income-statement', h((req) => { const x = range(req); return incomeStatement(db, x.from, x.to); }));
  r.get('/reports/cash-flow', h((req) => { const x = range(req); return cashFlowStatement(db, x.from, x.to); }));
  r.get('/reports/equity', h((req) => { const x = range(req); return equityStatement(db, x.from, x.to); }));
  r.get('/reports/net-worth', h((req) => {
    const asOf = dateQ(req.query.asOf, t());
    return { ...netWorthStatement(db, asOf), trend: netWorthTrend(db, 12, asOf) };
  }));
  r.get('/reports/general-ledger', h((req) => { const x = range(req); return generalLedger(db, x.from, x.to, req.query.accountId ? Number(req.query.accountId) : undefined); }));

  r.get('/dashboard', h(() => dashboard(db)));

  /* ---------- Budgets ---------- */
  r.get('/budgets', h((req) => budgetStatus(db, str(req.query.month) ?? t().slice(0, 7))));
  r.put('/budgets', h((req) => {
    setBudget(db, Number(req.body.accountId), String(req.body.month), Number(req.body.amount || 0));
    return budgetStatus(db, req.body.month === '*' ? t().slice(0, 7) : String(req.body.month));
  }));
  r.post('/budgets/copy', h((req) => {
    const { fromMonth, toMonth } = req.body ?? {};
    const src = budgetStatus(db, String(fromMonth));
    src.rows.filter((x) => x.budget).forEach((x) => setBudget(db, x.accountId, String(toMonth), fromCents(x.budget)));
    return budgetStatus(db, String(toMonth));
  }));

  /* ---------- Investments ---------- */
  r.get('/investments', h((req) => {
    const asOf = dateQ(req.query.asOf, t());
    const hs = holdings(db, { asOf });
    const totalCost = hs.reduce((s, x) => s + x.cost, 0);
    const totalMarket = hs.reduce((s, x) => s + (x.marketValue ?? x.cost), 0);
    const realized = db
      .prepare(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS g FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE a.subtype = 'capital_gains' AND e.user_id = ? AND e.date >= ? AND e.date <= ?`)
      .get(USER_ID, `${asOf.slice(0, 4)}-01-01`, asOf) as { g: number };
    const income = db
      .prepare(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS g FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE a.subtype IN ('dividend','interest') AND a.type='income' AND e.user_id = ? AND e.date >= ? AND e.date <= ?`)
      .get(USER_ID, `${asOf.slice(0, 4)}-01-01`, asOf) as { g: number };
    return { asOf, holdings: hs, totalCost, totalMarket, unrealizedGain: totalMarket - totalCost, realizedGainYtd: realized.g, investmentIncomeYtd: income.g };
  }));
  r.get('/securities', h(() => db.prepare('SELECT * FROM securities WHERE user_id = ? ORDER BY symbol').all(USER_ID)));
  r.put('/securities/:id', h((req) => {
    const price = req.body.price === null || req.body.price === '' ? null : toCents(Number(req.body.price));
    db.prepare('UPDATE securities SET name = COALESCE(?, name), currency = COALESCE(?, currency), last_price = ?, price_date = ? WHERE id = ? AND user_id = ?')
      .run(req.body.name ?? null, req.body.currency ?? null, price, dateQ(req.body.priceDate, t()), id(req), USER_ID);
    audit(db, 'update_price', 'security', id(req), req.body);
    return db.prepare('SELECT * FROM securities WHERE id = ?').get(id(req));
  }));

  /* ---------- Reconciliation ---------- */
  r.get('/reconciliations', h(() =>
    db.prepare('SELECT r.*, a.name AS account_name FROM reconciliations r JOIN accounts a ON a.id = r.account_id WHERE r.user_id = ? ORDER BY r.id DESC').all(USER_ID),
  ));
  r.post('/reconciliations', h((req) => reconciliationDetail(db, startReconciliation(db, Number(req.body.accountId), String(req.body.statementDate), Number(req.body.statementBalance)))));
  r.get('/reconciliations/:id', h((req) => reconciliationDetail(db, id(req))));
  r.post('/reconciliations/:id/toggle', h((req) => {
    const ids: number[] = Array.isArray(req.body.lineIds) ? req.body.lineIds : [req.body.lineId];
    db.transaction(() => ids.forEach((l) => toggleCleared(db, id(req), Number(l), req.body.cleared)))();
    return reconciliationDetail(db, id(req));
  }));
  r.post('/reconciliations/:id/complete', h((req) => { completeReconciliation(db, id(req)); return reconciliationDetail(db, id(req)); }));
  r.delete('/reconciliations/:id', h((req) => { cancelReconciliation(db, id(req)); return { ok: true }; }));

  /* ---------- CSV import ---------- */
  const categorize = (description: string, inflow: boolean) => {
    const accts = listAccounts(db, false);
    const cat = findCategory(db, description.toLowerCase(), accts, inflow ? ['income', 'expense'] : ['expense'], description);
    if (cat) return cat.id;
    return accts.find((a) => a.subtype === (inflow ? 'other_income' : 'other_expense'))?.id ?? null;
  };
  r.post('/import/preview', h((req) => previewCsv(db, String(req.body.csv ?? ''), Number(req.body.accountId), req.body.mapping ?? {}, categorize)));
  r.post('/import/commit', h((req) => commitCsv(db, Number(req.body.accountId), req.body.rows ?? [])));

  /* ---------- Recurring ---------- */
  r.get('/recurring', h(() =>
    (db.prepare('SELECT * FROM recurring_transactions WHERE user_id = ? ORDER BY is_active DESC, next_date').all(USER_ID) as RecurringRow[]).map((x) => ({ ...x, template: JSON.parse(x.template) })),
  ));
  r.post('/recurring', h((req) => ({ id: upsertRecurring(db, req.body) })));
  r.put('/recurring/:id', h((req) => ({ id: upsertRecurring(db, { ...req.body, id: id(req) }) })));
  r.post('/recurring/:id/:action', h((req) => {
    if (!['pause', 'resume'].includes(String(req.params.action))) throw new ValidationError('Unknown action.');
    db.prepare('UPDATE recurring_transactions SET is_active = ? WHERE id = ? AND user_id = ?').run(req.params.action === 'resume' ? 1 : 0, id(req), USER_ID);
    audit(db, String(req.params.action), 'recurring', id(req));
    return { ok: true };
  }));
  r.post('/recurring/:id/post-now', h((req) => {
    const row = db.prepare('SELECT * FROM recurring_transactions WHERE id = ? AND user_id = ?').get(id(req), USER_ID) as RecurringRow | undefined;
    if (!row) throw new ValidationError('Not found.');
    const entryId = postRecurringOnce(db, row, dateQ(req.body?.date, row.next_date));
    return getEntry(db, entryId);
  }));
  r.post('/recurring/run', h(() => ({ posted: runDueRecurring(db) })));

  /* ---------- Settings, FX, rules, audit ---------- */
  r.get('/settings', h(() => ({
    lock_date: getSetting(db, 'lock_date'),
    default_payment_account: getSetting(db, 'default_payment_account'),
    owner_name: getSetting(db, 'owner_name'),
  })));
  r.put('/settings', h((req) => {
    for (const k of ['lock_date', 'default_payment_account', 'owner_name']) {
      if (k in req.body) {
        const v = req.body[k] === '' ? null : req.body[k] === null ? null : String(req.body[k]);
        if (k === 'lock_date' && v && !isValidISODate(v)) throw new ValidationError('Invalid lock date.');
        setSetting(db, k, v);
      }
    }
    audit(db, 'update', 'settings', null, req.body);
    return { ok: true };
  }));
  r.get('/fx-rates', h(() => db.prepare('SELECT * FROM fx_rates ORDER BY currency, date DESC').all()));
  r.put('/fx-rates', h((req) => {
    const cur = String(req.body.currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new ValidationError('Currency must be a 3-letter code.');
    const rate = Number(req.body.rate);
    if (!(rate > 0)) throw new ValidationError('Rate must be positive.');
    const date = dateQ(req.body.date, t());
    db.prepare('INSERT INTO fx_rates (currency, date, rate) VALUES (?, ?, ?) ON CONFLICT(currency, date) DO UPDATE SET rate = excluded.rate').run(cur, date, rate);
    audit(db, 'set_fx', 'fx_rate', null, { cur, date, rate });
    return { ok: true };
  }));
  r.get('/merchant-rules', h(() => db.prepare('SELECT m.*, a.name AS account_name FROM merchant_rules m JOIN accounts a ON a.id = m.account_id WHERE m.user_id = ? ORDER BY m.hits DESC').all(USER_ID)));
  r.delete('/merchant-rules/:id', h((req) => { db.prepare('DELETE FROM merchant_rules WHERE id = ? AND user_id = ?').run(id(req), USER_ID); return { ok: true }; }));
  r.get('/audit', h((req) =>
    db.prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(USER_ID, Math.min(Number(req.query.limit ?? 200), 1000), Number(req.query.offset ?? 0)),
  ));

  r.post('/demo/seed', h(() => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE user_id = ?').get(USER_ID) as { n: number }).n;
    if (n > 0) throw new ValidationError('Demo data can only be loaded into an empty ledger.');
    return { posted: seedDemo(db) };
  }));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, details: err.details });
    console.error(err);
    res.status(500).json({ error: (err as Error).message ?? 'Internal error' });
  });
  return r;
}
