import type { DB } from '../db.js';
import { addDays, isValidISODate, parseISO, toISO } from '../money.js';
import { type Account, ValidationError, isDebitNormal } from '../types.js';
import { USER_ID, accountBalances, getAccount, getSetting, setSetting } from './ledger.js';

export type GroupBy = 'day' | 'week' | 'month' | 'year';
export const GROUP_BYS: GroupBy[] = ['day', 'week', 'month', 'year'];

export interface MerchantGroup {
  name: string;
  aliases: string[];
}

/** Common Canadian merchants and their everyday nicknames. User-defined groups take precedence. */
export const BUILTIN_MERCHANT_GROUPS: MerchantGroup[] = [
  { name: 'Tim Hortons', aliases: ['tim hortons', 'tim horton', "tim horton's", 'tims', 'timmies', 'timmys', "timmy's", 'timhortons'] },
  { name: "McDonald's", aliases: ["mcdonald's", 'mcdonalds', 'mcdonald', 'mcd', 'mcds', 'mickey d'] },
  { name: 'Starbucks', aliases: ['starbucks', 'sbux'] },
  { name: 'Second Cup', aliases: ['second cup'] },
  { name: 'A&W', aliases: ['a&w', 'a & w', 'a and w'] },
  { name: 'Subway', aliases: ['subway'] },
  { name: 'KFC', aliases: ['kfc', 'kentucky fried chicken'] },
  { name: 'Popeyes', aliases: ['popeyes', "popeye's"] },
  { name: 'Pizza Pizza', aliases: ['pizza pizza'] },
  { name: "Domino's", aliases: ["domino's", 'dominos'] },
  { name: 'Uber Eats', aliases: ['uber eats', 'ubereats'] },
  { name: 'Uber', aliases: ['uber', 'uber trip', 'uber rides'] },
  { name: 'DoorDash', aliases: ['doordash', 'door dash'] },
  { name: 'SkipTheDishes', aliases: ['skipthedishes', 'skip the dishes'] },
  { name: 'Costco', aliases: ['costco', 'costco wholesale', 'costco gas'] },
  { name: 'Walmart', aliases: ['walmart', 'wal-mart', 'wal mart'] },
  { name: 'Amazon', aliases: ['amazon', 'amzn', 'amazon.ca', 'amazon prime', 'amazon mktp'] },
  { name: 'Loblaws', aliases: ['loblaws', 'loblaw'] },
  { name: 'No Frills', aliases: ['no frills', 'nofrills'] },
  { name: 'Real Canadian Superstore', aliases: ['real canadian superstore', 'superstore', 'rcss'] },
  { name: 'Sobeys', aliases: ['sobeys'] },
  { name: 'Metro', aliases: ['metro'] },
  { name: 'FreshCo', aliases: ['freshco'] },
  { name: 'Save-On-Foods', aliases: ['save-on-foods', 'save on foods', 'saveonfoods'] },
  { name: 'Safeway', aliases: ['safeway'] },
  { name: 'Shoppers Drug Mart', aliases: ['shoppers drug mart', 'shoppers', 'sdm'] },
  { name: 'Dollarama', aliases: ['dollarama'] },
  { name: 'Canadian Tire', aliases: ['canadian tire', 'cdn tire'] },
  { name: 'Home Depot', aliases: ['home depot', 'the home depot'] },
  { name: 'IKEA', aliases: ['ikea'] },
  { name: 'Best Buy', aliases: ['best buy', 'bestbuy'] },
  { name: 'LCBO', aliases: ['lcbo'] },
  { name: 'Petro-Canada', aliases: ['petro-canada', 'petro canada', 'petrocan'] },
  { name: 'Esso', aliases: ['esso'] },
  { name: 'Shell', aliases: ['shell'] },
  { name: 'Netflix', aliases: ['netflix'] },
  { name: 'Spotify', aliases: ['spotify'] },
  { name: 'PRESTO', aliases: ['presto'] },
];

const MERCHANT_GROUPS_KEY = 'merchant_groups';

/** Lower-case, drop apostrophes and punctuation, collapse spaces: "Tim Horton's #123" → "tim hortons 123". */
export function normText(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' & ')
    .replace(/[^a-z0-9&#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordRe = (term: string) => new RegExp(`(^| )${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
const prefixRe = (term: string) => new RegExp(`(^| )${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

export async function getMerchantGroups(db: DB): Promise<MerchantGroup[]> {
  const raw = await getSetting(db, MERCHANT_GROUPS_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((g) => g && typeof g.name === 'string' && Array.isArray(g.aliases)) : [];
  } catch {
    return [];
  }
}

export async function saveMerchantGroups(db: DB, input: unknown): Promise<MerchantGroup[]> {
  if (!Array.isArray(input)) throw new ValidationError('groups must be a list.');
  if (input.length > 300) throw new ValidationError('Too many merchant groups (max 300).');
  const out: MerchantGroup[] = [];
  const seen = new Set<string>();
  for (const g of input) {
    const name = typeof g?.name === 'string' ? g.name.trim() : '';
    if (!name || name.length > 80) throw new ValidationError('Each merchant group needs a name (max 80 characters).');
    if (!Array.isArray(g.aliases) || g.aliases.length > 40) throw new ValidationError(`"${name}": provide up to 40 aliases.`);
    const aliases = [...new Set<string>(g.aliases.map((a: unknown) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean))];
    if (aliases.some((a) => a.length > 80 || normText(a).length < 2)) throw new ValidationError(`"${name}": aliases must be 2–80 characters.`);
    if (seen.has(name.toLowerCase())) throw new ValidationError(`Duplicate merchant group "${name}".`);
    seen.add(name.toLowerCase());
    out.push({ name, aliases });
  }
  await setSetting(db, MERCHANT_GROUPS_KEY, JSON.stringify(out));
  return out;
}

interface CompiledAlias { term: string; re: RegExp; name: string }

/** Merchant matcher: user groups first, then built-ins; longer aliases win ("uber eats" before "uber"). */
export class MerchantMatcher {
  private aliases: CompiledAlias[] = [];
  readonly groups: MerchantGroup[];
  constructor(custom: MerchantGroup[]) {
    const customNames = new Set(custom.map((g) => g.name.toLowerCase()));
    this.groups = [...custom, ...BUILTIN_MERCHANT_GROUPS.filter((g) => !customNames.has(g.name.toLowerCase()))];
    const taken = new Set<string>();
    for (const g of this.groups) {
      for (const a of [g.name, ...g.aliases]) {
        const term = normText(a);
        if (term.length < 2 || taken.has(term)) continue;
        taken.add(term);
        this.aliases.push({ term, re: wordRe(term), name: g.name });
      }
    }
    this.aliases.sort((a, b) => b.term.length - a.term.length);
  }

  /** Group name when any alias appears as whole words in the text. */
  find(text: string | null | undefined): string | null {
    const t = normText(text);
    if (!t) return null;
    for (const a of this.aliases) if (a.re.test(t)) return a.name;
    return null;
  }

  aliasesOf(name: string): string[] {
    return this.aliases.filter((a) => a.name.toLowerCase() === name.toLowerCase()).map((a) => a.term);
  }

  /** Canonical merchant for a payee (store numbers, card-processor prefixes and #tags removed). */
  canonical(payee: string | null | undefined): string | null {
    if (!payee || !payee.trim()) return null;
    const known = this.find(payee);
    if (known) return known;
    const cleaned = payee
      .replace(/#[a-z][\w-]*/gi, ' ')
      .replace(/^\s*(sq|tst|pos|sp|pp|interac|purchase|pre-?auth)\s*\*?\s*/i, '')
      .replace(/#\s*\d+/g, ' ')
      .replace(/\b(store|str|unit|no\.?)\s*\d+\b/gi, ' ')
      .replace(/\b\d{3,}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    if (cleaned.length <= 3) return cleaned.toUpperCase();
    const uniform = cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase();
    return (uniform ? cleaned.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : cleaned).slice(0, 60);
  }
}

export async function merchantMatcher(db: DB): Promise<MerchantMatcher> {
  return new MerchantMatcher(await getMerchantGroups(db));
}

interface LineRow {
  entry_id: number;
  date: string;
  description: string;
  payee: string | null;
  memo: string | null;
  raw_input: string | null;
  line_memo: string | null;
  account_id: number;
  account_name: string;
  account_type: Account['type'];
  debit: number;
  credit: number;
}

async function lineRows(db: DB, from: string, to: string, opts: { accountId?: number; type?: Account['type'] }): Promise<LineRow[]> {
  const where = ['e.user_id = ?', 'e.date >= ?', 'e.date <= ?'];
  const params: unknown[] = [USER_ID, from, to];
  if (opts.accountId) (where.push('l.account_id = ?'), params.push(opts.accountId));
  if (opts.type) (where.push('a.type = ?'), params.push(opts.type));
  return (await db
    .prepare(
      `SELECT e.id AS entry_id, e.date, e.description, e.payee, e.memo, e.raw_input, l.memo AS line_memo, l.account_id,
              a.name AS account_name, a.type AS account_type, l.debit, l.credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE ${where.join(' AND ')} ORDER BY e.date, e.id, l.id`,
    )
    .all(...params)) as LineRow[];
}

/** Merchant attributed to a ledger line: payee first, otherwise a known merchant mentioned in the description/memo. */
function merchantOf(m: MerchantMatcher, r: Pick<LineRow, 'payee' | 'description' | 'memo' | 'raw_input'>): string | null {
  return m.canonical(r.payee) ?? m.find(`${r.description} ${r.memo ?? ''} ${r.raw_input ?? ''}`);
}

const signed = (type: Account['type'], debit: number, credit: number) => (isDebitNormal(type) ? debit - credit : credit - debit);

export function bucketStart(date: string, g: GroupBy): string {
  if (g === 'day') return date;
  if (g === 'month') return `${date.slice(0, 7)}-01`;
  if (g === 'year') return `${date.slice(0, 4)}-01-01`;
  const d = parseISO(date);
  const dow = (d.getDay() + 6) % 7;
  return addDays(date, -dow);
}

function nextBucket(start: string, g: GroupBy): string {
  if (g === 'day') return addDays(start, 1);
  if (g === 'week') return addDays(start, 7);
  const d = parseISO(start);
  if (g === 'month') d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return toISO(d);
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function bucketLabel(start: string, g: GroupBy): string {
  const y = start.slice(0, 4);
  const m = MON[Number(start.slice(5, 7)) - 1];
  const d = Number(start.slice(8, 10));
  if (g === 'year') return y;
  if (g === 'month') return `${m} ${y}`;
  if (g === 'week') return `Wk of ${m} ${d}, ${y}`;
  return `${m} ${d}, ${y}`;
}

export interface TrendQuery {
  from: string;
  to: string;
  groupBy: GroupBy;
  /** Merchant name, nickname, memo word or #tag. */
  q?: string;
  accountId?: number;
}

export interface TrendBucket { start: string; end: string; label: string; amount: number; debit: number; credit: number; count: number; balance?: number }

export async function spendingTrend(db: DB, query: TrendQuery) {
  const { from, to, groupBy } = query;
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ValidationError('Choose a valid date range.');
  if (!GROUP_BYS.includes(groupBy)) throw new ValidationError('groupBy must be day, week, month or year.');
  const q = (query.q ?? '').trim();
  if (q.length > 100) throw new ValidationError('Search is too long.');

  const account = query.accountId ? await getAccount(db, query.accountId) : undefined;
  if (query.accountId && !account) throw new ValidationError('Account not found.');
  const mode: 'spending' | 'account' = account ? 'account' : 'spending';

  const starts: string[] = [];
  for (let s = bucketStart(from, groupBy); s <= to; s = nextBucket(s, groupBy)) {
    starts.push(s);
    if (starts.length > 1500) throw new ValidationError(`That range has too many ${groupBy}s to chart. Pick a shorter range or a larger grouping.`);
  }

  const m = await merchantMatcher(db);
  const group = q && !q.startsWith('#') ? m.find(q) : null;
  const terms = q ? (group ? m.aliasesOf(group) : [normText(q)]).filter(Boolean) : [];
  const tagRe = q.startsWith('#') ? new RegExp(`(^|\\s)${q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`) : null;
  const termRes = terms.map((t) => (group ? wordRe(t) : prefixRe(t)));

  const rows = await lineRows(db, from, to, account ? { accountId: account.id } : { type: 'expense' });
  const matches = (r: LineRow) => {
    if (!q) return true;
    const raw = `${r.payee ?? ''} ${r.description} ${r.memo ?? ''} ${r.raw_input ?? ''} ${r.line_memo ?? ''}`;
    if (tagRe) return tagRe.test(raw.toLowerCase());
    if (group && merchantOf(m, r) === group) return true;
    const t = normText(raw);
    return termRes.some((re) => re.test(t));
  };

  const idx = new Map(starts.map((s, i) => [s, i]));
  const buckets: TrendBucket[] = starts.map((s, i) => ({
    start: s,
    end: i + 1 < starts.length ? addDays(starts[i + 1], -1) : addDays(nextBucket(s, groupBy), -1),
    label: bucketLabel(s, groupBy),
    amount: 0,
    debit: 0,
    credit: 0,
    count: 0,
  }));
  const entryIdsPerBucket = buckets.map(() => new Set<number>());
  const byCategory = new Map<string, number>();
  const byMerchant = new Map<string, { amount: number; entries: Set<number> }>();
  const txns = new Map<number, { id: number; date: string; description: string; payee: string | null; merchant: string | null; memo: string | null; accounts: Set<string>; amount: number }>();

  for (const r of rows) {
    if (!matches(r)) continue;
    const b = buckets[idx.get(bucketStart(r.date, groupBy))!];
    const amt = signed(r.account_type, r.debit, r.credit);
    b.amount += amt;
    b.debit += r.debit;
    b.credit += r.credit;
    entryIdsPerBucket[idx.get(b.start)!].add(r.entry_id);
    byCategory.set(r.account_name, (byCategory.get(r.account_name) ?? 0) + amt);
    const merchant = merchantOf(m, r);
    const mk = merchant ?? '(no merchant recorded)';
    const me = byMerchant.get(mk) ?? { amount: 0, entries: new Set<number>() };
    me.amount += amt;
    me.entries.add(r.entry_id);
    byMerchant.set(mk, me);
    const t = txns.get(r.entry_id) ?? { id: r.entry_id, date: r.date, description: r.description, payee: r.payee, merchant, memo: r.memo, accounts: new Set<string>(), amount: 0 };
    t.amount += amt;
    t.accounts.add(r.account_name);
    txns.set(r.entry_id, t);
  }
  buckets.forEach((b, i) => (b.count = entryIdsPerBucket[i].size));

  let opening: number | undefined;
  if (account && ['asset', 'liability', 'equity'].includes(account.type)) {
    opening = (await accountBalances(db, { to: addDays(from, -1) })).get(account.id)?.balance ?? 0;
    let run = opening;
    for (const b of buckets) b.balance = run += b.amount;
  }

  const total = buckets.reduce((s, b) => s + b.amount, 0);
  const count = txns.size;
  const sorted = [...txns.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return {
    from,
    to,
    groupBy,
    mode,
    q: q || null,
    merchant: group,
    matchedTerms: tagRe ? [q.toLowerCase()] : terms,
    account: account ? { id: account.id, name: account.name, type: account.type } : null,
    total,
    count,
    avgPerPeriod: buckets.length ? Math.round(total / buckets.length) : 0,
    avgPerTransaction: count ? Math.round(total / count) : 0,
    activePeriods: buckets.filter((b) => b.count).length,
    openingBalance: opening ?? null,
    closingBalance: opening === undefined ? null : opening + total,
    buckets,
    byCategory: [...byCategory].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    byMerchant: [...byMerchant].map(([name, v]) => ({ name, amount: v.amount, count: v.entries.size })).sort((a, b) => b.amount - a.amount).slice(0, 50),
    transactions: sorted.slice(0, 300).map((t) => ({ ...t, accounts: [...t.accounts] })),
    truncated: sorted.length > 300,
  };
}

/** Spending per merchant (expense lines only), grouping nicknames and store numbers into one merchant. */
export async function merchantSummary(db: DB, from: string, to: string, limit = 50) {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) throw new ValidationError('Choose a valid date range.');
  const m = await merchantMatcher(db);
  const rows = await lineRows(db, from, to, { type: 'expense' });
  const map = new Map<string, { name: string; amount: number; entries: Set<number>; last: string; categories: Map<string, number> }>();
  let unattributed = 0;
  for (const r of rows) {
    const amt = r.debit - r.credit;
    const name = merchantOf(m, r);
    if (!name) {
      unattributed += amt;
      continue;
    }
    const v = map.get(name) ?? { name, amount: 0, entries: new Set<number>(), last: r.date, categories: new Map<string, number>() };
    v.amount += amt;
    v.entries.add(r.entry_id);
    if (r.date > v.last) v.last = r.date;
    v.categories.set(r.account_name, (v.categories.get(r.account_name) ?? 0) + amt);
    map.set(name, v);
  }
  const merchants = [...map.values()]
    .map((v) => ({
      name: v.name,
      amount: v.amount,
      count: v.entries.size,
      avgPerVisit: v.entries.size ? Math.round(v.amount / v.entries.size) : 0,
      lastDate: v.last,
      categories: [...v.categories].sort((a, b) => b[1] - a[1]).map(([n]) => n),
    }))
    .sort((a, b) => b.amount - a.amount);
  return { from, to, merchants: merchants.slice(0, limit), merchantCount: merchants.length, unattributed };
}

/** #tags used in memos/descriptions, with expense totals. */
export async function tagSummary(db: DB, from: string, to: string) {
  const rows = await lineRows(db, from, to, { type: 'expense' });
  const map = new Map<string, { amount: number; entries: Set<number> }>();
  for (const r of rows) {
    const tags = new Set(`${r.description} ${r.memo ?? ''} ${r.raw_input ?? ''} ${r.line_memo ?? ''}`.toLowerCase().match(/(?<![\w&])#[a-z][\w-]{0,40}/g) ?? []);
    for (const tag of tags) {
      const v = map.get(tag) ?? { amount: 0, entries: new Set<number>() };
      v.amount += r.debit - r.credit;
      v.entries.add(r.entry_id);
      map.set(tag, v);
    }
  }
  return [...map].map(([tag, v]) => ({ tag, amount: v.amount, count: v.entries.size })).sort((a, b) => b.amount - a.amount);
}

/** Known merchants (built-in, custom and ones seen in the ledger) and tags mentioned in a free-text question. */
export async function merchantMentions(db: DB, question: string, since: string, to: string): Promise<{ merchants: string[]; tags: string[] }> {
  const m = await merchantMatcher(db);
  const qn = normText(question);
  const found = new Set<string>();
  const direct = m.find(question);
  if (direct) found.add(direct);
  const seen = await merchantSummary(db, since, to, 1000);
  for (const s of seen.merchants) {
    const t = normText(s.name);
    if (t.length >= 3 && wordRe(t).test(qn)) found.add(s.name);
  }
  const tags = [...new Set(question.toLowerCase().match(/(?<![\w&])#[a-z][\w-]{0,40}/g) ?? [])];
  return { merchants: [...found], tags };
}
