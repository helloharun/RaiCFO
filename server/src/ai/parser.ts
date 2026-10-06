import type { DB } from '../db.js';
import { addDays, isValidISODate, parseISO, toISO, todayISO } from '../money.js';
import type { Account, TransactionType } from '../types.js';
import { USER_ID, listAccounts } from '../engine/ledger.js';
import { escapeRe, type Interpretation } from './proposal.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseDate(text: string, today = todayISO()): { date: string; matched?: string } {
  const t = text.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)) && isValidISODate(m[1])) return { date: m[1], matched: m[0] };
  if ((m = t.match(/\bday before yesterday\b/))) return { date: addDays(today, -2), matched: m[0] };
  if ((m = t.match(/\byesterday\b/))) return { date: addDays(today, -1), matched: m[0] };
  if ((m = t.match(/\b(today|tonight|this morning|this afternoon|this evening)\b/))) return { date: today, matched: m[0] };
  if ((m = t.match(/\btomorrow\b/))) return { date: addDays(today, 1), matched: m[0] };
  if ((m = t.match(/\b(\d+|a|one|two|three|four|five|six|seven)\s+(day|week)s?\s+ago\b/))) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = words[m[1]] ?? Number(m[1]);
    return { date: addDays(today, -n * (m[2] === 'week' ? 7 : 1)), matched: m[0] };
  }
  if ((m = t.match(/\blast week\b/))) return { date: addDays(today, -7), matched: m[0] };
  if ((m = t.match(/\b(last|on|this past)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const target = WEEKDAYS.indexOf(m[2]);
    const cur = parseISO(today).getDay();
    let diff = (cur - target + 7) % 7;
    if (diff === 0) diff = 7;
    return { date: addDays(today, -diff), matched: m[0].trim() };
  }
  const monthRe = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  if ((m = t.match(new RegExp(`\\b${monthRe}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`)))) {
    return { date: buildDate(today, MONTHS.indexOf(m[1].slice(0, 3)), Number(m[2]), m[3]), matched: m[0] };
  }
  if ((m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthRe}(?:,?\\s+(\\d{4}))?\\b`)))) {
    return { date: buildDate(today, MONTHS.indexOf(m[2].slice(0, 3)), Number(m[1]), m[3]), matched: m[0] };
  }
  return { date: today };
}

function buildDate(today: string, month: number, day: number, year?: string): string {
  const ty = Number(today.slice(0, 4));
  let d = new Date(year ? Number(year) : ty, month, day);
  if (!year && toISO(d) > today) d = new Date(ty - 1, month, day);
  return toISO(d);
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/\b(us\$|usd|us dollars?|american dollars?)/i, 'USD'],
  [/(€|\beur\b|\beuros?\b)/i, 'EUR'],
  [/(£|\bgbp\b|\bpounds?\b)/i, 'GBP'],
  [/(¥|\bjpy\b|\byen\b)/i, 'JPY'],
  [/\b(inr|rupees?)\b|₹/i, 'INR'],
  [/\b(aud)\b/i, 'AUD'],
  [/\b(mxn|pesos?)\b/i, 'MXN'],
];

interface AmountHit {
  value: number;
  index: number;
  raw: string;
  marked: boolean;
}

function amounts(text: string): AmountHit[] {
  const out: AmountHit[] = [];
  const re = /(?:(?:us|ca|c|a)?\$|€|£|¥|₹)\s?(\d[\d,]*(?:\.\d+)?)(\s?k\b)?|(\d[\d,]*(?:\.\d+)?)(\s?k\b)?(\s?(?:cad|usd|eur|gbp|dollars|bucks|euros?|pounds?|yen|rupees?)\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const numStr = m[1] ?? m[3];
    if (!numStr) continue;
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12).toLowerCase();
    // skip dates, ordinals, times
    if (/^[-/:]\d/.test(text.slice(m.index + m[0].length)) || /[-/:]$/.test(before)) continue;
    if (/^(st|nd|rd|th)\b/.test(after)) continue;
    const marked = Boolean(m[1]) || Boolean(m[5]);
    let value = Number(numStr.replace(/,/g, ''));
    if (m[2] || m[4]) value *= 1000;
    if (!Number.isFinite(value)) continue;
    // skip four-digit years
    if (!marked && /^(19|20)\d{2}$/.test(numStr)) continue;
    out.push({ value, index: m.index, raw: m[0], marked });
  }
  return out;
}

function numberNear(text: string, word: RegExp): number | null {
  const t = text.toLowerCase();
  const before = t.match(new RegExp(`(?:\\$|€|£)?\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:in\\s+|of\\s+|for\\s+)?(?:${word.source})`));
  if (before) return Number(before[1].replace(/,/g, ''));
  const after = t.match(new RegExp(`(?:${word.source})\\s*(?:of|was|is|:|=)?\\s*(?:\\$|€|£)?\\s?(\\d[\\d,]*(?:\\.\\d+)?)`));
  if (after) return Number(after[1].replace(/,/g, ''));
  return null;
}

const has = (t: string, re: RegExp) => re.test(t);

function detectType(t: string, mentions: Account[]): TransactionType {
  const mentionsCard = mentions.some((a) => a.subtype === 'credit_card') || /\b(credit card|visa|mastercard|amex)\b/.test(t);
  const mentionsLoan = mentions.some((a) => ['line_of_credit', 'personal_loan', 'auto_loan', 'student_loan', 'mortgage'].includes(a.subtype)) || /\b(loan|mortgage|line of credit|loc)\b/.test(t);
  const assets = mentions.filter((a) => a.type === 'asset');
  if (has(t, /\b(opening|starting|initial) balance\b/)) return 'opening_balance';
  if (has(t, /\badjust(ment|ed)?\b/)) return 'adjustment';
  if (has(t, /\bowner (contribution|contributed)\b|\bcontributed capital\b/)) return 'owner_contribution';
  if (has(t, /\bowner (withdrawal|withdrew|draw)\b/)) return 'owner_withdrawal';
  if (has(t, /\bdividends?\b|\bdistribution\b/)) return 'dividend';
  if (has(t, /\b(sold|sell|selling)\b/)) {
    if (has(t, /\b(shares?|units?|stocks?|etfs?|crypto|bitcoin|btc|eth)\b/) || mentions.some((a) => ['investment', 'tfsa', 'rrsp', 'other_investment'].includes(a.subtype)) || /\b[A-Z]{2,5}\b/.test(t.toUpperCase() === t ? '' : t)) return 'investment_sale';
    if (has(t, /\b(car|vehicle|truck|house|condo|property|laptop|furniture|bike)\b/)) return 'asset_sale';
  }
  if (has(t, /\b(bought|buy|purchased?|invested)\b/) && has(t, /\b(shares?|units?|stocks?|etfs?|bitcoin|btc|eth)\b/)) return 'investment_purchase';
  if (has(t, /\b(received|got|took out|borrowed|drew|draw|advance)\b/) && mentionsLoan && !has(t, /\b(payment|paid|pay)\b/)) return 'loan_proceeds';
  if (has(t, /\bborrowed\b/)) return 'loan_proceeds';
  if (mentionsLoan && has(t, /\b(payment|paid|pay|paying)\b/) && !has(t, /\b(using|with|on) (my )?(line of credit|loc)\b/)) return 'loan_payment';
  const cardWord = '(credit card|card|visa|mastercard|amex|mbna)';
  if (
    mentionsCard &&
    (has(t, new RegExp(`\\b${cardWord} (payment|bill|balance)\\b`)) ||
      has(t, new RegExp(`\\b(paid|pay|paying|payment|made a payment)\\b[^.]*\\b(to|towards?|off)\\s+(my\\s+|the\\s+)?([\\w-]+\\s+){0,2}${cardWord}\\b`)) ||
      has(t, new RegExp(`\\b(paid|pay|paying)\\s+(off\\s+)?(my|the)\\s+([\\w-]+\\s+){0,2}${cardWord}\\b`))) &&
    !has(t, /\b(for|on)\s+(groceries|dinner|lunch|gas|coffee)\b/)
  )
    return 'credit_card_payment';
  if (has(t, /\b(credit card|cc) payment\b/)) return 'credit_card_payment';
  if (has(t, /\brefund(ed)?\b|\breturned\b/)) return 'refund';
  if (has(t, /\breimburs|\bpaid me back\b|\bpaid back\b|\bpay me back\b|\bsent me .* for\b/)) return 'reimbursement';
  if (has(t, /\binterest\b/) && has(t, /\b(earned|received|got|paid me|income|credited)\b/) && !has(t, /\b(charge|charged|fee)\b/)) return 'interest';
  if (has(t, /\b(transfer(red)?|moved?|move|sent|contributed|contribute|deposited .* (in|into) (my )?(savings|tfsa|rrsp))\b/) && assets.length >= 1 && !has(t, /\b(salary|paycheque|paycheck|payroll)\b/)) {
    if (assets.length >= 2 || has(t, /\b(to|into)\s+(my\s+)?(savings|tfsa|rrsp|investment)/)) return 'transfer';
  }
  if (has(t, /\b(bought|purchased?)\b\s+(a\s+|an\s+|my\s+|the\s+)?(new\s+|used\s+)?(car|vehicle|truck|house|condo|home|property)\b/)) return 'asset_purchase';
  if (has(t, /\b(i owe|owe|iou|bill(ed)? .* (later|due)|on account|invoice due)\b/) && !has(t, /\bpaid\b/)) return 'liability_increase';
  if (has(t, /\b(salary|paycheque|paycheck|payroll|got paid|wages?|bonus|income|earned|deposit(ed)?|received|client paid|invoice paid|cashback|e-?transfer from)\b/) && !has(t, /\b(bought|spent|purchased?)\b/)) return 'income';
  return 'expense';
}

interface Mention {
  account: Account;
  index: number;
  length: number;
}

function findMentions(t: string, accts: Account[]): Mention[] {
  const out: Mention[] = [];
  for (const a of accts) {
    if (!['asset', 'liability'].includes(a.type)) continue;
    const terms = [a.name.toLowerCase(), ...(a.aliases ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)];
    let best: Mention | null = null;
    for (const term of terms) {
      const m = new RegExp(`\\b${escapeRe(term)}\\b`).exec(t);
      if (m && (!best || term.length > best.length)) best = { account: a, index: m.index, length: term.length };
    }
    if (best) out.push(best);
  }
  // Remove mentions fully contained in a longer mention at overlapping position (e.g. "td" inside "td savings").
  return out
    .filter((m) => !out.some((o) => o !== m && o.length > m.length && o.index <= m.index && o.index + o.length >= m.index + m.length))
    .sort((a, b) => a.index - b.index || b.length - a.length);
}

export async function findCategory(db: DB, t: string, accts: Account[], types: Array<Account['type']>, merchant?: string | null): Promise<Account | undefined> {
  const rules = await db.prepare('SELECT pattern, account_id FROM merchant_rules WHERE user_id = ? ORDER BY length(pattern) DESC').all(USER_ID) as Array<{ pattern: string; account_id: number }>;
  for (const r of rules) {
    if ((merchant && merchant.toLowerCase().includes(r.pattern)) || new RegExp(`\\b${escapeRe(r.pattern)}\\b`).test(t)) {
      const a = accts.find((x) => x.id === r.account_id && types.includes(x.type));
      if (a) return a;
    }
  }
  let best: { a: Account; len: number } | null = null;
  for (const a of accts) {
    if (!types.includes(a.type)) continue;
    const terms = [a.name.toLowerCase(), ...(a.aliases ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)];
    for (const term of terms) {
      if (term && new RegExp(`\\b${escapeRe(term)}\\b`).test(t) && (!best || term.length > best.len)) best = { a, len: term.length };
    }
  }
  return best?.a;
}

const STOP = '(?=\\s+(?:for|using|with|on|via|by|yesterday|today|last|this|and|from|to|into|in|paid|at|\\d)\\b|[,.;!]|$)';

function extractMerchant(text: string, type: TransactionType): string | null {
  const patterns = [
    new RegExp(`\\bat\\s+(?:the\\s+)?([A-Za-z0-9'&.\\- ]{2,40}?)${STOP}`, 'i'),
    new RegExp(`\\bfrom\\s+(?!my\\b|the\\b|td\\b|savings\\b|chequing\\b)([A-Z][A-Za-z0-9'&.\\- ]{1,40}?)${STOP}`),
  ];
  if (['income', 'reimbursement', 'refund'].includes(type)) patterns.push(new RegExp(`\\bfrom\\s+([A-Za-z][A-Za-z0-9'&.\\- ]{1,40}?)${STOP}`, 'i'));
  if (['expense', 'liability_increase'].includes(type)) patterns.push(new RegExp(`\\b(?:to|paid)\\s+(?!my\\b|the\\b)([A-Z][A-Za-z0-9'&.\\-]{1,30}(?: [A-Z][A-Za-z0-9'&.\\-]+)*)${STOP}`));
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const name = m[1].trim().replace(/\s+(store|inc|ltd)$/i, '');
      if (name && !/^(my|the|a|an|work|home)$/i.test(name)) return name.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

/** Deterministic, offline natural-language interpreter. Produces an Interpretation only. */
export async function ruleInterpret(db: DB, text: string, today = todayISO()): Promise<Interpretation> {
  const original = text.trim();
  const t = original.toLowerCase();
  const accts = await listAccounts(db, false);
  const { date } = parseDate(original, today);

  let currency = 'CAD';
  for (const [re, cur] of CURRENCY_SYMBOLS) if (re.test(original)) currency = cur;

  const mentions = findMentions(t, accts);
  const type = detectType(t, mentions.map((m) => m.account));

  const hits = amounts(original);
  const qtyMatch = original.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:shares?|units?)\s*(?:of\s+)?([A-Za-z.]{1,10})?/i) ?? original.match(/\b(?:bought|buy|sold|sell)\s+(\d[\d,]*(?:\.\d+)?)\s+([A-Z][A-Z.]{1,9})\b/);
  const quantity = qtyMatch ? Number(qtyMatch[1].replace(/,/g, '')) : null;
  let symbol: string | null = null;
  if (qtyMatch?.[2] && !/^(at|for|in|of|from)$/i.test(qtyMatch[2])) symbol = qtyMatch[2].toUpperCase();
  if (!symbol && ['investment_purchase', 'investment_sale', 'dividend'].includes(type)) {
    const sym = original.match(/\b([A-Z]{2,5}(?:\.[A-Z]{1,2})?)\b/g)?.find((s) => !['TD', 'RBC', 'CIBC', 'BMO', 'MBNA', 'TFSA', 'RRSP', 'USD', 'CAD', 'EUR', 'GBP', 'ETF', 'LOC', 'HST', 'GST', 'PST', 'QST'].includes(s));
    if (sym) symbol = sym;
  }
  const priceMatch = original.match(/\b(?:at|@)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:each|per\s+(?:share|unit))?/i);
  const price = priceMatch && quantity ? Number(priceMatch[1].replace(/,/g, '')) : null;

  const usable = hits.filter((h) => !(qtyMatch && h.index === qtyMatch.index) && !(priceMatch && quantity && h.index >= (priceMatch.index ?? -1) && h.index <= (priceMatch.index ?? -1) + priceMatch[0].length));
  const taxMatch = original.match(/(?:\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:in\s+|of\s+)?(hst|gst|pst|qst|tax|sales tax))|(?:(hst|gst|pst|qst|sales tax|tax)\s*(?:of|was|:)?\s*\$?\s?(\d[\d,]*(?:\.\d+)?))/i);
  const taxAmount = taxMatch ? Number((taxMatch[1] ?? taxMatch[4]).replace(/,/g, '')) : null;
  const taxType = taxMatch ? (taxMatch[2] ?? taxMatch[3]).toUpperCase() : null;

  const interest = type === 'loan_payment' ? numberNear(original, /interest/) : null;
  const principal = type === 'loan_payment' ? numberNear(original, /principal/) : null;
  const fees = numberNear(original, /(?:commission|fees?)/);
  const excluded = new Set([interest, principal, taxAmount, fees].filter((x): x is number => x !== null));
  const pool = usable.filter((h) => !excluded.has(h.value) || usable.length === 1);
  const pick = pool.find((h) => h.marked) ?? [...pool].sort((a, b) => b.value - a.value)[0];
  let amount = pick?.value ?? 0;
  if (!amount && type === 'loan_payment' && (principal || interest)) amount = (principal ?? 0) + (interest ?? 0);
  if (!amount && quantity && price) amount = quantity * price + (type === 'investment_purchase' ? fees ?? 0 : -(fees ?? 0));

  const merchant = extractMerchant(original, type);

  // Accounts: prefer explicit "from X ... to/into Y" structure.
  let payment: Account | undefined;
  let destination: Account | undefined;
  const after = (re: RegExp) => {
    const m = re.exec(t);
    if (!m) return undefined;
    return mentions.find((x) => x.index >= m.index + m[0].length - 1 && x.index <= m.index + m[0].length + 12)?.account;
  };
  const fromAcct = after(/\bfrom\s+(my\s+|the\s+)?/);
  const toAcct = after(/\b(to|into|in|onto|towards?)\s+(my\s+|the\s+)?/);
  const withAcct = after(/\b(using|with|on|via|by|through|paid with|charged to)\s+(my\s+|the\s+|a\s+)?/);
  const others = mentions.map((m) => m.account);
  const cards = accts.filter((a) => a.subtype === 'credit_card');

  switch (type) {
    case 'transfer':
    case 'credit_card_payment':
    case 'loan_payment':
    case 'liability_reduction':
    case 'investment_purchase':
    case 'asset_purchase':
      payment = fromAcct ?? withAcct ?? others.find((a) => a !== toAcct && ['cash', 'bank', 'savings'].includes(a.subtype));
      destination = toAcct ?? others.find((a) => a !== payment);
      if (type === 'credit_card_payment') {
        destination = others.find((a) => a.subtype === 'credit_card') ?? (cards.length === 1 ? cards[0] : undefined);
        payment = others.find((a) => a.type === 'asset') ?? payment;
      }
      if (type === 'loan_payment') {
        destination = others.find((a) => a.type === 'liability' && a.subtype !== 'credit_card') ?? destination;
        payment = others.find((a) => a !== destination && (a.type === 'asset' || a.subtype === 'credit_card')) ?? payment;
      }
      if (type === 'investment_purchase') {
        destination = others.find((a) => ['investment', 'tfsa', 'rrsp', 'other_investment'].includes(a.subtype)) ?? destination;
        payment = others.find((a) => a !== destination) ?? undefined;
      }
      if (type === 'transfer' && payment && destination && payment.id === destination.id) destination = undefined;
      break;
    case 'investment_sale':
    case 'asset_sale':
      payment = fromAcct ?? others.find((a) => !['cash', 'bank', 'savings'].includes(a.subtype) && a.type === 'asset');
      destination = toAcct ?? others.find((a) => a !== payment);
      break;
    case 'income':
    case 'interest':
    case 'dividend':
    case 'loan_proceeds':
    case 'refund':
    case 'reimbursement':
    case 'owner_contribution':
      destination = toAcct ?? others.find((a) => a.type === 'asset' || (type === 'refund' && a.subtype === 'credit_card'));
      payment = fromAcct ?? others.find((a) => a !== destination);
      if (type === 'refund') {
        destination = toAcct ?? others[0];
        payment = destination;
      }
      break;
    case 'opening_balance':
    case 'adjustment':
      destination = others[0];
      break;
    default:
      payment = withAcct ?? fromAcct ?? others[0];
      if (!payment && /\b(credit card|visa|mastercard|amex)\b/.test(t) && cards.length === 1) payment = cards[0];
      if (!payment && /\b(debit|debit card|interac)\b/.test(t)) payment = accts.find((a) => a.subtype === 'bank');
      if (!payment && /\bcash\b/.test(t)) payment = accts.find((a) => a.subtype === 'cash');
  }

  let categoryAcct: Account | undefined;
  if (['expense', 'credit_card_purchase', 'refund', 'liability_increase'].includes(type)) categoryAcct = await findCategory(db, t, accts, ['expense'], merchant);
  if (type === 'reimbursement') categoryAcct = await findCategory(db, t.replace(/\breimburs\w*/g, ''), accts, ['expense'], merchant);
  if (type === 'income') categoryAcct = await findCategory(db, t, accts, ['income'], merchant);
  if (type === 'interest') categoryAcct = accts.find((a) => a.subtype === 'interest' && a.type === 'income');
  if (type === 'dividend') categoryAcct = accts.find((a) => a.subtype === 'dividend' && a.type === 'income');
  if (type === 'asset_purchase') destination = destination && destination.type === 'asset' && !['cash', 'bank', 'savings'].includes(destination.subtype) ? destination : (await findCategory(db, t, accts, ['asset']));
  if (type === 'asset_purchase' && destination && ['cash', 'bank', 'savings'].includes(destination.subtype)) destination = undefined;

  const direction = /\b(decrease|reduce|lower|down)\b/.test(t) ? 'decrease' : /\b(increase|raise|up)\b/.test(t) ? 'increase' : null;

  const paymentMethod = /\bdebit\b/.test(t) ? 'debit card' : /\bcredit card|visa|mastercard|amex\b/.test(t) ? 'credit card' : /\bcash\b/.test(t) ? 'cash' : /\be-?transfer|interac\b/.test(t) ? 'e-transfer' : /\bcheque|check\b/.test(t) ? 'cheque' : null;

  return {
    transactionDate: date,
    amount,
    currency,
    merchant,
    transactionType: type,
    category: categoryAcct?.name ?? null,
    categoryAccountId: categoryAcct?.id ?? null,
    paymentAccount: payment?.name ?? null,
    paymentAccountId: payment?.id ?? null,
    destinationAccount: destination?.name ?? null,
    destinationAccountId: destination?.id ?? null,
    paymentMethod,
    principal,
    interest,
    fees,
    quantity,
    symbol,
    price,
    taxAmount,
    taxType,
    direction,
    description: null,
    notes: null,
    clarifications: [],
  };
}
