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
  FREQUENCIES, type RecurringRow, budgetStatus, cancelReconciliation, commitCsv, completeReconciliation, postRecurringOnce, postRecurringNow, previewCsv,
  reconciliationDetail, runDueRecurring, setBudget, startReconciliation, toggleCleared, upsertRecurring,
} from '../engine/services.js';
import { dashboard } from '../engine/analytics.js';
import { buildProposal, type Interpretation } from '../ai/proposal.js';
import { findCategory, ruleInterpret } from '../ai/parser.js';
import { llmConfig, llmInterpret, sanitizeInterpretation } from '../ai/llm.js';
import { ask } from '../ai/ask.js';
import { seedDemo } from '../scripts/demoData.js';
import { getConfig } from '../config.js';
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

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const dateQ = (v: unknown, fallback: string) => {
  const s = str(v);
  if (s && !isValidISODate(s)) throw new ValidationError(`Invalid date: ${s}`);
  return s ?? fallback;
};
const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError('Invalid id.');
  return n;
};
const USER_SOURCES = new Set(['manual', 'ai', 'ai-rules', 'csv', 'recurring', 'opening']);
const userSource = (v: unknown, fb: string) => (typeof v === 'string' && USER_SOURCES.has(v) ? v : fb);
const finite = (v: unknown, label: string, opts: { min?: number; max?: number } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < (opts.min ?? -1e11) || n > (opts.max ?? 1e11)) throw new ValidationError(`${label} must be a valid number.`);
  return n;
};
const optId = (v: unknown) => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError('Invalid account id.');
  return n;
};
const text = (v: unknown, max: number) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));

export function apiRouter(db: DB) {
  const r = express.Router();

  r.get('/meta', h(() => {
    const cfg = llmConfig();
    return {
      baseCurrency: 'CAD',
      subtypes: SUBTYPES,
      transactionTypes: TRANSACTION_TYPES,
      frequencies: FREQUENCIES,
      ai: cfg ? { enabled: true, provider: cfg.provider, model: cfg.model } : { enabled: false },
      demoDataAllowed: getConfig()?.ALLOW_DEMO_DATA !== false,
      username: getConfig()?.APP_USERNAME ?? null,
      today: todayISO(),
    };
  }));

  /* ---------- Accounts ---------- */
  r.get('/accounts', h(async (req) => {
    const asOf = dateQ(req.query.asOf, todayISO());
    const bal = await accountBalances(db, { to: asOf });
    const active = new Set(((await db.prepare('SELECT DISTINCT account_id FROM journal_lines').all()) as Array<{ account_id: number }>).map((x) => x.account_id));
    return (await listAccounts(db, req.query.includeInactive !== 'false')).map((a) => ({
      ...a,
      balance: bal.get(a.id)?.balance ?? 0,
      nativeBalance: bal.get(a.id)?.nativeBalance ?? 0,
      hasActivity: active.has(a.id),
    }));
  }));

  const accountFields = (b: Record<string, unknown>, existing?: { type: string }) => {
    const type = String(b.type ?? existing?.type ?? '');
    if (!(type in SUBTYPES)) throw new ValidationError('Invalid account type.');
    const subtype = String(b.subtype ?? '');
    if (!SUBTYPES[type as keyof typeof SUBTYPES].includes(subtype)) throw new ValidationError(`Invalid subtype for ${type}.`);
    if (!String(b.name ?? '').trim()) throw new ValidationError('Name is required.');
    return {
      code: String(b.code ?? '').trim().slice(0, 20),
      name: String(b.name).trim().slice(0, 120),
      type,
      subtype,
      currency: /^[A-Za-z]{3}$/.test(String(b.currency ?? 'CAD')) ? String(b.currency ?? 'CAD').toUpperCase() : (() => { throw new ValidationError('Currency must be a 3-letter code.'); })(),
      parent_id: b.parentId ? Number(b.parentId) : null,
      institution: text(b.institution, 120),
      aliases: text(b.aliases, 500),
      description: text(b.description, 1000),
    };
  };

  r.post('/accounts', h(async (req) => {
    const f = accountFields(req.body);
    if (!f.code) {
      const prefix = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 }[f.type as 'asset'];
      const max = await db.prepare("SELECT MAX(CASE WHEN code ~ '^[0-9]+$' THEN CAST(code AS BIGINT) END) AS m FROM accounts WHERE user_id = ? AND code LIKE ?").get(USER_ID, `${prefix}%`) as { m: number | null };
      f.code = String((max.m ?? prefix * 1000) + 5);
    }
    if (await db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND code = ?').get(USER_ID, f.code)) throw new ValidationError(`Account code ${f.code} is already used.`);
    const newId = Number(
      (await db.prepare('INSERT INTO accounts (user_id, code, name, type, subtype, currency, parent_id, institution, aliases, description, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM accounts))')
        .run(USER_ID, f.code, f.name, f.type, f.subtype, f.currency, f.parent_id, f.institution, f.aliases, f.description)).lastInsertRowid,
    );
    await audit(db, 'create', 'account', newId, f);
    return getAccount(db, newId);
  }));

  r.put('/accounts/:id', h(async (req) => {
    const a = await getAccount(db, id(req));
    if (!a) throw new ValidationError('Account not found.');
    const f = accountFields({ ...a, parentId: a.parent_id, ...req.body }, a);
    const used = await db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(a.id);
    if (used && f.type !== a.type) throw new ValidationError('The type of an account with transactions cannot be changed. Create a new account instead.');
    if (f.parent_id === a.id) throw new ValidationError('An account cannot be its own parent.');
    if (f.code && f.code !== a.code && await db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND code = ?').get(USER_ID, f.code)) throw new ValidationError(`Account code ${f.code} is already used.`);
    await db.prepare("UPDATE accounts SET code = ?, name = ?, type = ?, subtype = ?, currency = ?, parent_id = ?, institution = ?, aliases = ?, description = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?")
      .run(f.code || a.code, f.name, f.type, f.subtype, f.currency, f.parent_id, f.institution, f.aliases, f.description, a.id);
    await audit(db, 'update', 'account', a.id, { before: a, after: f });
    return getAccount(db, a.id);
  }));

  r.post('/accounts/:id/:action', h(async (req) => {
    if (!['deactivate', 'reactivate'].includes(String(req.params.action))) throw new ValidationError('Unknown action.');
    const a = await getAccount(db, id(req));
    if (!a) throw new ValidationError('Account not found.');
    const active = req.params.action === 'reactivate' ? 1 : 0;
    if (!active && a.is_system) throw new ValidationError('System accounts cannot be deactivated.');
    if (!active) {
      const bal = (await accountBalances(db)).get(a.id)?.balance ?? 0;
      if (bal !== 0 && !req.body?.force) throw new ValidationError(`This account still has a balance of ${fromCents(bal).toFixed(2)}. Transfer it out first (or pass force).`);
    }
    await db.prepare("UPDATE accounts SET is_active = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?").run(active, a.id);
    await audit(db, active ? 'reactivate' : 'deactivate', 'account', a.id);
    return getAccount(db, a.id);
  }));

  r.delete('/accounts/:id', h(async (req, res) => {
    const a = await getAccount(db, id(req));
    if (!a) throw new ValidationError('Account not found.');
    if (a.is_system) throw new ValidationError('System accounts cannot be deleted.');
    const refs = await db.prepare('SELECT (SELECT COUNT(*) FROM journal_lines WHERE account_id = ?) + (SELECT COUNT(*) FROM budgets WHERE account_id = ?) + (SELECT COUNT(*) FROM merchant_rules WHERE account_id = ?) AS n').get(a.id, a.id, a.id) as { n: number };
    if (refs.n > 0) {
      res.status(409);
      return { error: 'This account has history and cannot be deleted. Deactivate it instead.' };
    }
    await db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
    await audit(db, 'delete', 'account', a.id, a);
    return { ok: true };
  }));

  r.post('/accounts/reorder', h(async (req) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).slice(0, 5000) : [];
    if (ids.some((x) => !Number.isSafeInteger(x))) throw new ValidationError('Invalid account ids.');
    const upd = db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ? AND user_id = ?');
    await db.transaction(async () => {
      for (const [i, x] of ids.entries()) await upd.run(i, x, USER_ID);
    })();
    await audit(db, 'reorder', 'account', null, { ids });
    return { ok: true };
  }));

  /* ---------- AI transaction interpretation ---------- */
  r.post('/ai/interpret', h(async (req) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw new ValidationError('Describe a transaction first.');
    if (text.length > 2000) throw new ValidationError('Please keep the description under 2,000 characters.');
    const useLlm = req.body?.engine !== 'rules' && llmConfig();
    if (useLlm) {
      try {
        const interp = await llmInterpret(db, text);
        return await buildProposal(db, interp, 'llm', text);
      } catch (e) {
        const p = await buildProposal(db, (await ruleInterpret(db, text)), 'rules', text);
        p.warnings.unshift(`AI interpretation failed (${(e as Error).message}); used the built-in parser.`);
        return p;
      }
    }
    return buildProposal(db, (await ruleInterpret(db, text)), 'rules', text);
  }));

  r.post('/ai/rebuild', h((req) => {
    const interp = req.body?.interpretation as Interpretation;
    if (!interp) throw new ValidationError('Missing interpretation.');
    return buildProposal(db, { ...sanitizeInterpretation(interp), clarifications: [] }, req.body?.engine === 'llm' ? 'llm' : 'rules', typeof req.body?.rawInput === 'string' ? req.body.rawInput.slice(0, 2000) : undefined);
  }));

  r.post('/ask', h(async (req) => {
    const q = String(req.body?.question ?? '').trim();
    if (!q) throw new ValidationError('Ask a question.');
    if (q.length > 1000) throw new ValidationError('Please keep questions under 1,000 characters.');
    return ask(db, q);
  }));

  /* ---------- Journal ---------- */
  r.get('/journal', h((req) =>
    listEntries(db, {
      from: str(req.query.from) && dateQ(req.query.from, ''),
      to: str(req.query.to) && dateQ(req.query.to, ''),
      accountId: optId(req.query.accountId),
      search: str(req.query.search),
      type: str(req.query.type),
      limit: Math.min(Math.max(Math.trunc(Number(req.query.limit ?? 100)) || 100, 1), 1000),
      offset: Math.max(Math.trunc(Number(req.query.offset ?? 0)) || 0, 0),
    }),
  ));

  r.post('/journal/validate', h(async (req) => {
    try {
      const v = await validateEntry(db, req.body as EntryInput);
      return { ok: true, totalDebit: v.lines.reduce((s, l) => s + l.debit, 0), totalCredit: v.lines.reduce((s, l) => s + l.credit, 0) };
    } catch (e) {
      if (e instanceof ValidationError) return { ok: false, error: e.message };
      throw e;
    }
  }));

  r.post('/journal', h(async (req) => {
    const entry = req.body as EntryInput;
    const entryId = await postEntry(db, { ...entry, source: userSource(entry?.source, 'manual') });
    return getEntry(db, entryId);
  }));

  r.get('/journal/:id', h(async (req) => {
    const e = await getEntry(db, id(req));
    if (!e) throw new ValidationError('Entry not found.');
    return e;
  }));

  r.post('/journal/:id/reverse', h(async (req) => {
    const revId = await reverseEntry(db, id(req), { date: str(req.body?.date), reason: str(req.body?.reason) });
    return getEntry(db, revId);
  }));

  r.post('/journal/:id/replace', h(async (req) => {
    const original = await getEntry(db, id(req));
    if (!original) throw new ValidationError('Entry not found.');
    const newId = await db.transaction(async () => {
      await reverseEntry(db, original.id, { reason: 'Edited' });
      return postEntry(db, { ...(req.body as EntryInput), source: original.source === 'reversal' ? 'manual' : original.source, metadata: { ...(req.body?.metadata ?? {}), replaces: original.id } });
    })();
    return getEntry(db, newId);
  }));

  r.get('/export/journal.csv', h(async (_req, res) => {
    const rows = (await db
      .prepare(
        `SELECT e.id, e.date, e.description, e.payee, e.transaction_type, a.code, a.name, l.debit, l.credit, l.memo
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.user_id = ? ORDER BY e.date, e.id, l.id`,
      )
      .all(USER_ID)) as Array<Record<string, unknown>>;
    const csv = '\uFEFF' + toCsv(
      ['entry_id', 'date', 'description', 'payee', 'type', 'account_code', 'account', 'debit', 'credit', 'memo'],
      rows.map((r) => [r.id, r.date, r.description, r.payee, r.transaction_type, r.code, r.name, fromCents(r.debit as number).toFixed(2), fromCents(r.credit as number).toFixed(2), r.memo]),
    );
    res.setHeader('content-type', 'text/csv; charset=utf-8');
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
  r.get('/reports/net-worth', h(async (req) => {
    const asOf = dateQ(req.query.asOf, t());
    return { ...(await netWorthStatement(db, asOf)), trend: (await netWorthTrend(db, 12, asOf)) };
  }));
  r.get('/reports/general-ledger', h((req) => { const x = range(req); return generalLedger(db, x.from, x.to, optId(req.query.accountId)); }));

  r.get('/dashboard', h(() => dashboard(db)));

  /* ---------- Budgets ---------- */
  r.get('/budgets', h((req) => budgetStatus(db, str(req.query.month) ?? t().slice(0, 7))));
  r.put('/budgets', h(async (req) => {
    await setBudget(db, Number(req.body.accountId), String(req.body.month), finite(req.body.amount || 0, 'Budget', { min: 0 }));
    return budgetStatus(db, req.body.month === '*' ? t().slice(0, 7) : String(req.body.month));
  }));
  r.post('/budgets/copy', h(async (req) => {
    const { fromMonth, toMonth } = req.body ?? {};
    const src = await budgetStatus(db, String(fromMonth));
    await db.transaction(async () => {
      for (const x of src.rows.filter((y) => y.budget)) await setBudget(db, x.accountId, String(toMonth), fromCents(x.budget));
    })();
    return budgetStatus(db, String(toMonth));
  }));

  /* ---------- Investments ---------- */
  r.get('/investments', h(async (req) => {
    const asOf = dateQ(req.query.asOf, t());
    const hs = await holdings(db, { asOf });
    const totalCost = hs.reduce((s, x) => s + x.cost, 0);
    const totalMarket = hs.reduce((s, x) => s + (x.marketValue ?? x.cost), 0);
    const realized = (await db
      .prepare(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS g FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE a.subtype = 'capital_gains' AND e.user_id = ? AND e.date >= ? AND e.date <= ?`)
      .get(USER_ID, `${asOf.slice(0, 4)}-01-01`, asOf)) as { g: number };
    const income = (await db
      .prepare(`SELECT COALESCE(SUM(l.credit - l.debit),0) AS g FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE a.subtype IN ('dividend','interest') AND a.type='income' AND e.user_id = ? AND e.date >= ? AND e.date <= ?`)
      .get(USER_ID, `${asOf.slice(0, 4)}-01-01`, asOf)) as { g: number };
    return { asOf, holdings: hs, totalCost, totalMarket, unrealizedGain: totalMarket - totalCost, realizedGainYtd: realized.g, investmentIncomeYtd: income.g };
  }));
  r.get('/securities', h(async () => await db.prepare('SELECT * FROM securities WHERE user_id = ? ORDER BY symbol').all(USER_ID)));
  r.put('/securities/:id', h(async (req) => {
    const price = req.body.price === null || req.body.price === '' ? null : toCents(finite(req.body.price, 'Price', { min: 0 }));
    await db.prepare('UPDATE securities SET name = COALESCE(?, name), currency = COALESCE(?, currency), last_price = ?, price_date = ? WHERE id = ? AND user_id = ?')
      .run(text(req.body.name, 120), /^[A-Za-z]{3}$/.test(String(req.body.currency ?? '')) ? String(req.body.currency).toUpperCase() : null, price, dateQ(req.body.priceDate, t()), id(req), USER_ID);
    await audit(db, 'update_price', 'security', id(req), req.body);
    return await db.prepare('SELECT * FROM securities WHERE id = ?').get(id(req));
  }));

  /* ---------- Reconciliation ---------- */
  r.get('/reconciliations', h(async () =>
    await db.prepare('SELECT r.*, a.name AS account_name FROM reconciliations r JOIN accounts a ON a.id = r.account_id WHERE r.user_id = ? ORDER BY r.id DESC').all(USER_ID),
  ));
  r.post('/reconciliations', h(async (req) => reconciliationDetail(db, (await startReconciliation(db, Number(req.body.accountId), String(req.body.statementDate), finite(req.body.statementBalance, 'Statement balance'))))));
  r.get('/reconciliations/:id', h((req) => reconciliationDetail(db, id(req))));
  r.post('/reconciliations/:id/toggle', h(async (req) => {
    const ids: number[] = (Array.isArray(req.body.lineIds) ? req.body.lineIds : [req.body.lineId]).slice(0, 10000);
    await db.transaction(async () => {
      for (const l of ids) await toggleCleared(db, id(req), Number(l), req.body.cleared);
    })();
    return reconciliationDetail(db, id(req));
  }));
  r.post('/reconciliations/:id/complete', h(async (req) => { await completeReconciliation(db, id(req)); return reconciliationDetail(db, id(req)); }));
  r.delete('/reconciliations/:id', h(async (req) => { await cancelReconciliation(db, id(req)); return { ok: true }; }));

  /* ---------- CSV import ---------- */
  const categorize = async (description: string, inflow: boolean) => {
    const accts = await listAccounts(db, false);
    const cat = await findCategory(db, description.toLowerCase(), accts, inflow ? ['income', 'expense'] : ['expense'], description);
    if (cat) return cat.id;
    return accts.find((a) => a.subtype === (inflow ? 'other_income' : 'other_expense'))?.id ?? null;
  };
  r.post('/import/preview', h((req) => previewCsv(db, String(req.body.csv ?? ''), Number(req.body.accountId), req.body.mapping ?? {}, categorize)));
  r.post('/import/commit', h((req) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length > 5000) throw new ValidationError('Import at most 5,000 rows at a time.');
    return commitCsv(db, Number(req.body.accountId), rows.map((x: Record<string, unknown>) => ({ ...x, amount: Number(x.amount), counterAccountId: Number(x.counterAccountId), description: String(x.description ?? '').slice(0, 300), date: String(x.date ?? '') })));
  }));

  /* ---------- Recurring ---------- */
  r.get('/recurring', h(async () =>
    (await db.prepare('SELECT * FROM recurring_transactions WHERE user_id = ? ORDER BY is_active DESC, next_date').all(USER_ID) as RecurringRow[]).map((x) => ({ ...x, template: JSON.parse(x.template) })),
  ));
  const recurringInput = (b: Record<string, unknown>) => {
    const tpl = (b?.template ?? {}) as Record<string, unknown>;
    if (!Array.isArray(tpl.lines)) throw new ValidationError('The recurring template must be a balanced journal entry.');
    const description = String(b.description ?? '').trim().slice(0, 300);
    if (!description) throw new ValidationError('Description is required.');
    if (b.endDate && !isValidISODate(String(b.endDate))) throw new ValidationError('Invalid end date.');
    return { ...(b as object), description, template: { ...tpl, source: 'recurring' } } as Parameters<typeof upsertRecurring>[1];
  };
  r.post('/recurring', h(async (req) => ({ id: (await upsertRecurring(db, recurringInput(req.body ?? {}))) })));
  r.put('/recurring/:id', h(async (req) => {
    if (!await db.prepare('SELECT 1 FROM recurring_transactions WHERE id = ? AND user_id = ?').get(id(req), USER_ID)) throw new ValidationError('Not found.');
    return { id: (await upsertRecurring(db, { ...recurringInput(req.body ?? {}), id: id(req) })) };
  }));
  r.post('/recurring/:id/post-now', h(async (req) => {
    const row = await db.prepare('SELECT * FROM recurring_transactions WHERE id = ? AND user_id = ?').get(id(req), USER_ID) as RecurringRow | undefined;
    if (!row) throw new ValidationError('Not found.');
    const entryId = await postRecurringNow(db, row, dateQ(req.body?.date, row.next_date));
    return getEntry(db, entryId);
  }));
  r.post('/recurring/:id/:action', h(async (req) => {
    if (!['pause', 'resume'].includes(String(req.params.action))) throw new ValidationError('Unknown action.');
    await db.prepare('UPDATE recurring_transactions SET is_active = ? WHERE id = ? AND user_id = ?').run(req.params.action === 'resume' ? 1 : 0, id(req), USER_ID);
    await audit(db, String(req.params.action), 'recurring', id(req));
    return { ok: true };
  }));
  r.post('/recurring/run', h(async () => ({ posted: (await runDueRecurring(db)) })));

  /* ---------- Settings, FX, rules, audit ---------- */
  r.get('/settings', h(async () => ({
    lock_date: (await getSetting(db, 'lock_date')),
    default_payment_account: (await getSetting(db, 'default_payment_account')),
    owner_name: (await getSetting(db, 'owner_name')),
  })));
  r.put('/settings', h(async (req) => {
    for (const k of ['lock_date', 'default_payment_account', 'owner_name']) {
      if (k in req.body) {
        const v = req.body[k] === '' ? null : req.body[k] === null ? null : String(req.body[k]).slice(0, 200);
        if (k === 'lock_date' && v && !isValidISODate(v)) throw new ValidationError('Invalid lock date.');
        await setSetting(db, k, v);
      }
    }
    await audit(db, 'update', 'settings', null, req.body);
    return { ok: true };
  }));
  r.get('/fx-rates', h(async () => await db.prepare('SELECT * FROM fx_rates ORDER BY currency, date DESC').all()));
  r.put('/fx-rates', h(async (req) => {
    const cur = String(req.body.currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new ValidationError('Currency must be a 3-letter code.');
    const rate = Number(req.body.rate);
    if (!(rate > 0)) throw new ValidationError('Rate must be positive.');
    const date = dateQ(req.body.date, t());
    await db.prepare('INSERT INTO fx_rates (currency, date, rate) VALUES (?, ?, ?) ON CONFLICT(currency, date) DO UPDATE SET rate = excluded.rate').run(cur, date, rate);
    await audit(db, 'set_fx', 'fx_rate', null, { cur, date, rate });
    return { ok: true };
  }));
  r.get('/merchant-rules', h(async () => await db.prepare('SELECT m.*, a.name AS account_name FROM merchant_rules m JOIN accounts a ON a.id = m.account_id WHERE m.user_id = ? ORDER BY m.hits DESC').all(USER_ID)));
  r.delete('/merchant-rules/:id', h(async (req) => { await db.prepare('DELETE FROM merchant_rules WHERE id = ? AND user_id = ?').run(id(req), USER_ID); return { ok: true }; }));
  r.get('/audit', h(async (req) =>
    await db.prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(USER_ID, Math.min(Math.max(Math.trunc(Number(req.query.limit ?? 200)) || 200, 1), 1000), Math.max(Math.trunc(Number(req.query.offset ?? 0)) || 0, 0)),
  ));

  r.post('/demo/seed', h(async () => {
    if (getConfig()?.ALLOW_DEMO_DATA === false) throw new ValidationError('Demo data is disabled (ALLOW_DEMO_DATA=false).');
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE user_id = ?').get(USER_ID) as { n: number }).n;
    if (n > 0) throw new ValidationError('Demo data can only be loaded into an empty ledger.');
    return { posted: (await seedDemo(db)) };
  }));

  return r;
}
