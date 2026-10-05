import type { DB } from '../db.js';
import { BASE_CURRENCY, fromCents, isValidISODate, toCents, todayISO } from '../money.js';
import { type Account, type EntryInput, type LineInput, type TransactionType, INVESTMENT_SUBTYPES, LOAN_SUBTYPES, TRANSACTION_TYPES } from '../types.js';
import { USER_ID, fxRate, getAccount, getAccountByCode, listAccounts, getSetting } from '../engine/ledger.js';
import { costBasisForSale } from '../engine/investments.js';

/** Structured interpretation of a natural-language transaction. Produced by the AI (or rule parser); never posted directly. */
export interface Interpretation {
  transactionDate?: string;
  amount?: number;
  currency?: string;
  merchant?: string | null;
  transactionType?: TransactionType | string;
  category?: string | null;
  categoryAccountId?: number | null;
  paymentAccount?: string | null;
  paymentAccountId?: number | null;
  destinationAccount?: string | null;
  destinationAccountId?: number | null;
  paymentMethod?: string | null;
  principal?: number | null;
  interest?: number | null;
  fees?: number | null;
  quantity?: number | null;
  symbol?: string | null;
  price?: number | null;
  costBasis?: number | null;
  taxAmount?: number | null;
  taxType?: string | null;
  direction?: 'increase' | 'decrease' | null;
  description?: string | null;
  notes?: string | null;
  confidence?: number;
  clarifications?: string[];
}

export interface Proposal {
  interpretation: Interpretation;
  entry: EntryInput;
  explanation: string[];
  clarifications: string[];
  warnings: string[];
  confidence: number;
  balanced: boolean;
  engine: 'rules' | 'llm';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9&+' -]/g, ' ').replace(/\s+/g, ' ').trim();

/** Finds an account by id, exact name, code, alias or institution, limited to the given predicate. */
export function resolveAccount(db: DB, ref: string | number | null | undefined, pred: (a: Account) => boolean = () => true): Account | undefined {
  if (ref === null || ref === undefined || ref === '') return undefined;
  const accts = listAccounts(db, false).filter(pred);
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const byId = accts.find((a) => a.id === Number(ref));
    if (byId) return byId;
    const byCode = accts.find((a) => a.code === String(ref));
    if (byCode) return byCode;
  }
  const q = norm(String(ref));
  if (!q) return undefined;
  const exact = accts.find((a) => norm(a.name) === q);
  if (exact) return exact;
  const scored = accts
    .map((a) => {
      let score = 0;
      const name = norm(a.name);
      if (name.includes(q)) score = Math.max(score, 60 + q.length);
      if (q.includes(name)) score = Math.max(score, 70 + name.length);
      for (const al of (a.aliases ?? '').split(',').map(norm).filter(Boolean)) {
        if (al === q) score = Math.max(score, 90 + al.length);
        else if (new RegExp(`\\b${escapeRe(al)}\\b`).test(q)) score = Math.max(score, 40 + al.length);
      }
      if (a.institution && new RegExp(`\\b${escapeRe(norm(a.institution))}\\b`).test(q)) score = Math.max(score, 30);
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  return scored[0]?.a;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isCashLike = (a: Account) => a.type === 'asset' && ['cash', 'bank', 'savings'].includes(a.subtype);
const isPaymentSource = (a: Account) => isCashLike(a) || (a.type === 'liability' && ['credit_card', 'line_of_credit'].includes(a.subtype));
const isInvestment = (a: Account) => a.type === 'asset' && INVESTMENT_SUBTYPES.includes(a.subtype);
const isLoan = (a: Account) => a.type === 'liability' && LOAN_SUBTYPES.includes(a.subtype);

export function defaultBankAccount(db: DB): Account | undefined {
  const pref = getSetting(db, 'default_payment_account');
  const a = pref ? getAccount(db, Number(pref)) : undefined;
  if (a && a.is_active) return a;
  return listAccounts(db, false).find((x) => x.type === 'asset' && x.subtype === 'bank') ?? listAccounts(db, false).find(isCashLike);
}

function bySubtype(db: DB, subtype: string): Account | undefined {
  return listAccounts(db, false).find((a) => a.subtype === subtype);
}

const DEFAULT_INCOME_SUBTYPE: Record<string, string> = { interest: 'interest', dividend: 'dividend', income: 'other_income' };

const fmt = (n: number) => n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function lineReason(a: Account, side: 'debit' | 'credit'): string {
  const map: Record<string, [string, string]> = {
    asset: ['increases this asset', 'decreases this asset'],
    liability: ['reduces what you owe', 'increases what you owe'],
    equity: ['reduces equity', 'increases equity'],
    income: ['reduces income', 'records income earned'],
    expense: ['records spending', 'reduces (reverses) this expense'],
  };
  return map[a.type][side === 'debit' ? 0 : 1];
}

const TYPE_NOTES: Partial<Record<TransactionType, string>> = {
  transfer: 'A transfer moves money between your own accounts — it is neither income nor an expense.',
  credit_card_payment: 'Paying a credit card reduces the liability. No new expense is recorded: the expense was recognised when you made the purchase.',
  credit_card_purchase: 'A credit-card purchase records the expense now and increases the card balance you owe.',
  investment_purchase: 'Buying an investment exchanges cash for another asset — it is not an expense.',
  investment_sale: 'Selling an investment removes its cost basis from the account; the difference between proceeds and cost is a realised capital gain (or loss).',
  loan_proceeds: 'Borrowing increases cash and creates a liability — it is not income.',
  loan_payment: 'Only the interest portion of a loan payment is an expense; the principal portion reduces the loan liability.',
  liability_reduction: 'Paying down a liability is not an expense; it reduces what you owe.',
  refund: 'A refund reverses part of the original expense rather than counting as income.',
  reimbursement: 'A reimbursement offsets the original expense (or settles a receivable); it is not income.',
  asset_purchase: 'Buying a long-lived asset exchanges cash for another asset — it is not an expense.',
  asset_sale: 'Selling an asset removes its book value; any difference versus proceeds is a gain or loss.',
  opening_balance: 'Opening balances are offset to Opening Balance Equity so they do not distort income or expenses.',
  owner_contribution: 'Contributions increase equity directly; they are not income.',
  owner_withdrawal: 'Withdrawals reduce equity directly; they are not expenses.',
  adjustment: 'Adjustments correct a balance; the offset flows through Other Income / Other Expenses — review carefully.',
};

/**
 * Deterministic accounting rules: turns an interpretation into a balanced journal entry proposal.
 * The AI never chooses debits/credits itself; this function does.
 */
export function buildProposal(db: DB, interp: Interpretation, engine: 'rules' | 'llm' = 'rules', rawInput?: string): Proposal {
  const clar: string[] = [...(interp.clarifications ?? [])];
  const warnings: string[] = [];
  const type = (TRANSACTION_TYPES as readonly string[]).includes(String(interp.transactionType))
    ? (interp.transactionType as TransactionType)
    : 'expense';
  if (!interp.transactionType) clar.push('What kind of transaction is this (expense, income, transfer…)? I assumed an expense.');

  let date = interp.transactionDate;
  if (!isValidISODate(date)) {
    if (date) warnings.push(`Could not understand the date "${date}"; using today.`);
    date = todayISO();
  }
  const currency = (interp.currency || BASE_CURRENCY).toUpperCase();
  let rate = 1;
  try {
    rate = fxRate(db, currency, date);
  } catch (e) {
    warnings.push((e as Error).message);
  }
  const amount = Math.abs(Number(interp.amount ?? 0));
  if (!amount) clar.push('What was the amount?');

  const merchant = interp.merchant?.trim() || null;

  const pay = () => {
    let a =
      resolveAccount(db, interp.paymentAccountId ?? undefined, isPaymentSource) ??
      resolveAccount(db, interp.paymentAccount ?? undefined) ??
      resolveAccount(db, interp.paymentMethod ?? undefined, isPaymentSource);
    if (!a) {
      a = defaultBankAccount(db);
      if (a) clar.push(`Which account was used? I assumed ${a.name}.`);
    }
    return a;
  };
  const dest = (pred: (a: Account) => boolean, fallback?: () => Account | undefined, question?: string) => {
    let a = resolveAccount(db, interp.destinationAccountId ?? undefined) ?? resolveAccount(db, interp.destinationAccount ?? undefined, pred);
    if (!a && fallback) {
      a = fallback();
      if (a && question) clar.push(question.replace('%s', a.name));
    }
    return a;
  };
  const category = (pred: (a: Account) => boolean, fallbackSubtype: string, question: string) => {
    let a = resolveAccount(db, interp.categoryAccountId ?? undefined, pred) ?? resolveAccount(db, interp.category ?? undefined, pred);
    if (!a && merchant) a = merchantRule(db, merchant, pred);
    if (!a) {
      a = bySubtype(db, fallbackSubtype);
      if (a) clar.push(question.replace('%s', a.name));
    }
    return a;
  };
  const isExpense = (a: Account) => a.type === 'expense';
  const isIncome = (a: Account) => a.type === 'income';

  const lines: Array<LineInput & { account?: Account }> = [];
  const dr = (account: Account | undefined, amt: number, extra: Partial<LineInput> = {}) => {
    if (account && amt > 0) lines.push({ accountId: account.id, account, debit: round2(amt), credit: 0, ...extra });
  };
  const cr = (account: Account | undefined, amt: number, extra: Partial<LineInput> = {}) => {
    if (account && amt > 0) lines.push({ accountId: account.id, account, debit: 0, credit: round2(amt), ...extra });
  };

  let effectiveType: TransactionType = type;
  let descr = interp.description?.trim() || '';

  switch (type) {
    case 'expense':
    case 'credit_card_purchase': {
      const cat = category(isExpense, 'other_expense', 'Which expense category fits best? I used %s.');
      const src = pay();
      if (src?.subtype === 'credit_card') effectiveType = 'credit_card_purchase';
      dr(cat, amount);
      cr(src, amount);
      descr ||= `${cat?.name ?? 'Expense'}${merchant ? ` at ${merchant}` : ''}`;
      break;
    }
    case 'income':
    case 'interest':
    case 'dividend': {
      const cat = category(isIncome, DEFAULT_INCOME_SUBTYPE[type], 'Which income category is this? I used %s.');
      const to = dest((a) => a.type === "asset", () => resolveAccount(db, interp.paymentAccount ?? undefined) ?? defaultBankAccount(db), 'Which account received the money? I assumed %s.');
      dr(to, amount);
      cr(cat, amount);
      descr ||= `${cat?.name ?? 'Income'}${merchant ? ` from ${merchant}` : ''}`;
      break;
    }
    case 'transfer': {
      const from = resolveAccount(db, interp.paymentAccountId ?? undefined) ?? resolveAccount(db, interp.paymentAccount ?? undefined);
      const to = resolveAccount(db, interp.destinationAccountId ?? undefined) ?? resolveAccount(db, interp.destinationAccount ?? undefined);
      if (!from) clar.push('Which account did the money come from?');
      if (!to) clar.push('Which account did the money go to?');
      if (from && to && from.id === to.id) clar.push('The source and destination accounts are the same.');
      if (to?.type === 'liability') effectiveType = to.subtype === 'credit_card' ? 'credit_card_payment' : 'liability_reduction';
      dr(to, amount);
      cr(from, amount);
      descr ||= `Transfer${from ? ` from ${from.name}` : ''}${to ? ` to ${to.name}` : ''}`;
      break;
    }
    case 'credit_card_payment': {
      const card =
        resolveAccount(db, interp.destinationAccountId ?? undefined, (a) => a.subtype === 'credit_card') ??
        resolveAccount(db, interp.destinationAccount ?? undefined, (a) => a.subtype === 'credit_card') ??
        firstOrAsk(db, (a) => a.subtype === 'credit_card', clar, 'Which credit card was paid? I assumed %s.');
      const from = resolveAccount(db, interp.paymentAccountId ?? undefined, isCashLike) ?? resolveAccount(db, interp.paymentAccount ?? undefined, isCashLike) ?? withAsk(defaultBankAccount(db), clar, 'Which account was the payment made from? I assumed %s.');
      dr(card, amount);
      cr(from, amount);
      descr ||= `Payment to ${card?.name ?? 'credit card'}`;
      break;
    }
    case 'loan_payment': {
      const loan =
        resolveAccount(db, interp.destinationAccountId ?? undefined, isLoan) ??
        resolveAccount(db, interp.destinationAccount ?? undefined, isLoan) ??
        firstOrAsk(db, isLoan, clar, 'Which loan was paid? I assumed %s.');
      const from = resolveAccount(db, interp.paymentAccountId ?? undefined, isPaymentSource) ?? resolveAccount(db, interp.paymentAccount ?? undefined, isPaymentSource) ?? withAsk(defaultBankAccount(db), clar, 'Which account was the payment made from? I assumed %s.');
      let interest = Math.abs(Number(interp.interest ?? 0));
      let principal = Math.abs(Number(interp.principal ?? 0));
      const total = amount || principal + interest;
      if (!principal && !interest) {
        principal = total;
        clar.push('How much of this payment was interest vs. principal? I recorded it all as principal.');
      } else if (!principal) principal = Math.max(total - interest, 0);
      else if (!interest) interest = Math.max(total - principal, 0);
      if (Math.abs(principal + interest - total) > 0.005) warnings.push(`Principal (${fmt(principal)}) + interest (${fmt(interest)}) ≠ payment (${fmt(total)}). Using principal + interest.`);
      const interestAcct = loan?.subtype === 'mortgage' ? bySubtype(db, 'mortgage_interest') : bySubtype(db, 'interest_expense');
      dr(loan, principal, { memo: 'Principal' });
      dr(interestAcct, interest, { memo: 'Interest' });
      cr(from, principal + interest);
      descr ||= `Payment on ${loan?.name ?? 'loan'}`;
      break;
    }
    case 'loan_proceeds': {
      const loan =
        resolveAccount(db, interp.paymentAccountId ?? undefined, isLoan) ??
        resolveAccount(db, interp.paymentAccount ?? undefined, isLoan) ??
        firstOrAsk(db, isLoan, clar, 'Which loan is this? I assumed %s.');
      const to = dest(isCashLike, () => defaultBankAccount(db), 'Which account received the funds? I assumed %s.');
      dr(to, amount);
      cr(loan, amount);
      descr ||= `Proceeds from ${loan?.name ?? 'loan'}`;
      break;
    }
    case 'investment_purchase': {
      const inv = dest(isInvestment, () => listAccounts(db, false).find(isInvestment), 'Which investment account holds this? I assumed %s.');
      const from = resolveAccount(db, interp.paymentAccountId ?? undefined, isPaymentSource) ?? resolveAccount(db, interp.paymentAccount ?? undefined, isPaymentSource) ?? withAsk(defaultBankAccount(db), clar, 'Which account paid for it? I assumed %s.');
      const qty = interp.quantity ?? null;
      const fees = Math.abs(Number(interp.fees ?? 0));
      const total = amount || (qty && interp.price ? qty * interp.price + fees : 0);
      if (!interp.symbol) clar.push('Which security (ticker symbol) did you buy?');
      if (!qty) clar.push('How many units/shares did you buy?');
      dr(inv, total, { symbol: interp.symbol ?? null, quantity: qty, memo: fees ? `Includes ${fmt(fees)} commission` : null });
      cr(from, total);
      descr ||= `Buy ${qty ?? ''} ${interp.symbol ?? 'investment'}`.replace(/\s+/g, ' ').trim();
      break;
    }
    case 'investment_sale': {
      const inv =
        resolveAccount(db, interp.paymentAccountId ?? undefined, isInvestment) ??
        resolveAccount(db, interp.paymentAccount ?? undefined, isInvestment) ??
        firstOrAsk(db, isInvestment, clar, 'Which investment account was it sold from? I assumed %s.');
      const to = resolveAccount(db, interp.destinationAccountId ?? undefined) ?? resolveAccount(db, interp.destinationAccount ?? undefined) ?? withAsk(inv, clar, 'Where did the proceeds go? I kept them as cash in %s.');
      const qty = interp.quantity ?? null;
      const proceeds = amount || (qty && interp.price ? qty * interp.price - Math.abs(Number(interp.fees ?? 0)) : 0);
      let cost = interp.costBasis ?? null;
      if (cost === null && inv && interp.symbol) {
        const basis = costBasisForSale(db, inv.id, interp.symbol, qty ?? Infinity, date);
        if (basis) {
          cost = fromCents(basis.cost) / rate;
          if (qty && qty > basis.held) warnings.push(`You only hold ${basis.held} units of ${interp.symbol}.`);
        }
      }
      if (cost === null) {
        cost = proceeds;
        clar.push('What was the cost basis of the units sold? I could not find a holding, so no gain/loss was recorded.');
      }
      if (!interp.symbol) clar.push('Which security (ticker symbol) did you sell?');
      const gains = bySubtype(db, 'capital_gains');
      dr(to, proceeds);
      cr(inv, cost, { symbol: interp.symbol ?? null, quantity: qty ? -qty : null, memo: 'Cost basis (average cost)' });
      const gain = round2(proceeds - cost);
      if (gain > 0) cr(gains, gain, { memo: 'Realised capital gain' });
      if (gain < 0) dr(gains, -gain, { memo: 'Realised capital loss' });
      descr ||= `Sell ${qty ?? ''} ${interp.symbol ?? 'investment'}`.replace(/\s+/g, ' ').trim();
      break;
    }
    case 'asset_purchase': {
      const asset = dest((a) => a.type === 'asset' && !isCashLike(a), () => bySubtype(db, 'personal_asset'), 'Which asset account should this go to? I used %s.');
      const src = pay();
      dr(asset, amount);
      cr(src, amount);
      descr ||= `Purchase of ${asset?.name ?? 'asset'}${merchant ? ` from ${merchant}` : ''}`;
      break;
    }
    case 'asset_sale': {
      const asset =
        resolveAccount(db, interp.paymentAccountId ?? undefined, (a) => a.type === 'asset' && !isCashLike(a)) ??
        resolveAccount(db, interp.paymentAccount ?? undefined, (a) => a.type === 'asset' && !isCashLike(a)) ??
        firstOrAsk(db, (a) => a.subtype === 'personal_asset', clar, 'Which asset was sold? I assumed %s.');
      const to = dest(isCashLike, () => defaultBankAccount(db), 'Where did the proceeds go? I assumed %s.');
      let book = interp.costBasis ?? null;
      if (book === null && asset) {
        const bal = db
          .prepare('SELECT COALESCE(SUM(l.debit - l.credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.date <= ? AND e.user_id = ?')
          .get(asset.id, date, USER_ID) as { b: number };
        book = fromCents(bal.b) / rate;
        if (book > 0) clar.push(`I used the full book value of ${asset.name} (${fmt(book)}) as the cost of the asset sold. Adjust if only part was sold.`);
      }
      book = Math.max(book ?? 0, 0);
      dr(to, amount);
      cr(asset, book);
      const gain = round2(amount - book);
      if (gain > 0) cr(bySubtype(db, 'other_income'), gain, { memo: 'Gain on sale' });
      if (gain < 0) dr(bySubtype(db, 'other_expense'), -gain, { memo: 'Loss on sale' });
      descr ||= `Sale of ${asset?.name ?? 'asset'}`;
      break;
    }
    case 'liability_increase': {
      const liab = dest((a) => a.type === 'liability', () => bySubtype(db, 'accounts_payable'), 'Which liability increased? I used %s.');
      const cat = category((a) => a.type === 'expense' || a.type === 'asset', 'other_expense', 'What was this for? I used %s.');
      dr(cat, amount);
      cr(liab, amount);
      descr ||= `${cat?.name ?? 'Charge'} owed${merchant ? ` to ${merchant}` : ''}`;
      break;
    }
    case 'liability_reduction': {
      const liab = dest((a) => a.type === 'liability', () => firstOrAsk(db, (a) => a.type === 'liability', [], ''), 'Which liability was paid down? I assumed %s.');
      const from = resolveAccount(db, interp.paymentAccountId ?? undefined, isCashLike) ?? resolveAccount(db, interp.paymentAccount ?? undefined, isCashLike) ?? withAsk(defaultBankAccount(db), clar, 'Which account was used? I assumed %s.');
      dr(liab, amount);
      cr(from, amount);
      descr ||= `Payment on ${liab?.name ?? 'liability'}`;
      break;
    }
    case 'refund': {
      const cat = category(isExpense, 'other_expense', 'Which expense is being refunded? I used %s.');
      const to = resolveAccount(db, interp.destinationAccountId ?? undefined, isPaymentSource) ?? resolveAccount(db, interp.destinationAccount ?? undefined, isPaymentSource) ?? pay();
      dr(to, amount);
      cr(cat, amount);
      descr ||= `Refund${merchant ? ` from ${merchant}` : ''}`;
      break;
    }
    case 'reimbursement': {
      let cat = resolveAccount(db, interp.categoryAccountId ?? undefined) ?? resolveAccount(db, interp.category ?? undefined, (a) => a.type === 'expense' || a.subtype === 'accounts_receivable');
      if (!cat) {
        cat = bySubtype(db, 'accounts_receivable');
        if (cat) clar.push(`Was this reimbursing an expense you recorded, or settling money owed to you? I credited ${cat.name}.`);
      }
      const to = dest(isPaymentSource, () => defaultBankAccount(db), 'Which account received the reimbursement? I assumed %s.');
      dr(to, amount);
      cr(cat, amount);
      descr ||= `Reimbursement${merchant ? ` from ${merchant}` : ''}`;
      break;
    }
    case 'owner_contribution': {
      const to = dest((a) => a.type === 'asset', () => defaultBankAccount(db), 'Which account received the contribution? I assumed %s.');
      dr(to, amount);
      cr(bySubtype(db, 'owner_contribution'), amount);
      descr ||= 'Owner contribution';
      break;
    }
    case 'owner_withdrawal': {
      const from = pay();
      dr(bySubtype(db, 'owner_withdrawal'), amount);
      cr(from, amount);
      descr ||= 'Owner withdrawal';
      break;
    }
    case 'opening_balance': {
      const acct =
        resolveAccount(db, interp.destinationAccountId ?? undefined) ??
        resolveAccount(db, interp.destinationAccount ?? undefined) ??
        resolveAccount(db, interp.paymentAccountId ?? undefined) ??
        resolveAccount(db, interp.paymentAccount ?? undefined);
      if (!acct) clar.push('Which account is this opening balance for?');
      const obe = bySubtype(db, 'opening_balance_equity');
      if (acct?.type === 'liability') (dr(obe, amount), cr(acct, amount));
      else (dr(acct, amount), cr(obe, amount));
      descr ||= `Opening balance — ${acct?.name ?? 'account'}`;
      break;
    }
    case 'adjustment': {
      const acct = resolveAccount(db, interp.destinationAccountId ?? undefined) ?? resolveAccount(db, interp.destinationAccount ?? undefined) ?? resolveAccount(db, interp.paymentAccount ?? undefined);
      if (!acct) clar.push('Which account needs adjusting?');
      const increase = interp.direction !== 'decrease';
      if (!interp.direction) clar.push('Should the balance increase or decrease? I assumed increase.');
      const debitSide = acct ? (acct.type === 'asset' || acct.type === 'expense') === increase : true;
      const offset = debitSide ? bySubtype(db, 'other_income') : bySubtype(db, 'other_expense');
      if (debitSide) (dr(acct, amount), cr(offset, amount));
      else (dr(offset, amount), cr(acct, amount));
      descr ||= `Balance adjustment — ${acct?.name ?? 'account'}`;
      break;
    }
  }

  if (interp.taxAmount) warnings.push(`Includes ${interp.taxType ?? 'sales tax'} of ${fmt(interp.taxAmount)} ${currency} (recorded in the entry metadata).`);
  if (currency !== BASE_CURRENCY) warnings.push(`Converted from ${currency} at ${rate} CAD per ${currency}. CAD amounts are used in reports.`);
  if (date > todayISO()) warnings.push('This transaction is dated in the future.');

  const od = lines.reduce((s, l) => s + toCents(l.debit ?? 0), 0);
  const oc = lines.reduce((s, l) => s + toCents(l.credit ?? 0), 0);
  const balanced = lines.length >= 2 && od === oc && od > 0;

  const explanation: string[] = [];
  if (TYPE_NOTES[effectiveType]) explanation.push(TYPE_NOTES[effectiveType]!);
  for (const l of lines) {
    const side = (l.debit ?? 0) > 0 ? 'debit' : 'credit';
    const amt = side === 'debit' ? l.debit! : l.credit!;
    explanation.push(`${side === 'debit' ? 'Debit' : 'Credit'} ${l.account!.name} ${fmt(amt)} — ${lineReason(l.account!, side)}${l.memo ? ` (${l.memo.toLowerCase()})` : ''}.`);
  }
  if (balanced) explanation.push(`Debits (${fmt(fromCents(od))}) equal credits (${fmt(fromCents(oc))}), so the entry balances.`);

  const uniqueClar = [...new Set(clar)];
  const confidence = Math.max(0.1, Math.min(interp.confidence ?? 0.95, 0.95 - 0.15 * uniqueClar.length));

  const entry: EntryInput = {
    date,
    description: capitalize(descr || rawInput || 'Transaction'),
    payee: merchant,
    memo: interp.notes ?? null,
    transactionType: effectiveType,
    source: engine === 'llm' ? 'ai' : 'ai-rules',
    currency,
    fxRate: rate,
    rawInput: rawInput ?? null,
    explanation: explanation.join('\n'),
    metadata: {
      ...(interp.taxAmount ? { taxAmount: interp.taxAmount, taxType: interp.taxType ?? 'sales tax' } : {}),
      ...(interp.paymentMethod ? { paymentMethod: interp.paymentMethod } : {}),
      ...(interp.fees ? { fees: interp.fees } : {}),
      ...(interp.price ? { price: interp.price } : {}),
    },
    lines: lines.map(({ account: _a, ...l }) => l),
  };

  return {
    interpretation: { ...interp, transactionType: effectiveType, transactionDate: date, currency, amount },
    entry,
    explanation,
    clarifications: uniqueClar,
    warnings,
    confidence: Math.round(confidence * 100) / 100,
    balanced,
    engine,
  };
}

function merchantRule(db: DB, merchant: string, pred: (a: Account) => boolean): Account | undefined {
  const m = merchant.toLowerCase();
  const rules = db.prepare('SELECT pattern, account_id FROM merchant_rules WHERE user_id = ? ORDER BY length(pattern) DESC').all(USER_ID) as Array<{ pattern: string; account_id: number }>;
  for (const r of rules) {
    if (m.includes(r.pattern) || r.pattern.includes(m)) {
      const a = getAccount(db, r.account_id);
      if (a && a.is_active && pred(a)) return a;
    }
  }
  return undefined;
}

function firstOrAsk(db: DB, pred: (a: Account) => boolean, clar: string[], q: string): Account | undefined {
  const matches = listAccounts(db, false).filter(pred);
  if (matches.length && q) clar.push(q.replace('%s', matches[0].name));
  return matches[0];
}

function withAsk(a: Account | undefined, clar: string[], q: string): Account | undefined {
  if (a) clar.push(q.replace('%s', a.name));
  return a;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export { getAccountByCode };
