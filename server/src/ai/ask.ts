import type { DB } from '../db.js';
import { addMonths, fromCents, monthEnd, monthStart, todayISO } from '../money.js';
import { accountBalances, listAccounts } from '../engine/ledger.js';
import { balanceSheet, incomeStatement, netWorthStatement } from '../engine/reports.js';
import { budgetStatus } from '../engine/services.js';
import { escapeRe } from './proposal.js';
import { chat, llmConfig } from './llm.js';
import { merchantMentions, merchantSummary, spendingTrend, tagSummary } from '../engine/insights.js';

export interface Period {
  from: string;
  to: string;
  label: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parsePeriod(q: string, today = todayISO()): Period {
  const t = q.toLowerCase();
  let m: RegExpMatchArray | null;
  if (/\blast month\b/.test(t)) {
    const s = addMonths(monthStart(today), -1);
    return { from: s, to: monthEnd(s), label: 'last month' };
  }
  if (/\bthis year\b|\bytd\b|\byear to date\b/.test(t)) return { from: `${today.slice(0, 4)}-01-01`, to: today, label: 'this year' };
  if (/\blast year\b/.test(t)) {
    const y = Number(today.slice(0, 4)) - 1;
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` };
  }
  if ((m = t.match(/\b(?:last|past)\s+(\d+)\s+months?\b/))) {
    const n = Number(m[1]);
    return { from: addMonths(monthStart(today), -(n - 1)), to: today, label: `the last ${n} months` };
  }
  if ((m = t.match(/\b(?:last|past)\s+(\d+)\s+days?\b/))) {
    const d = new Date();
    d.setDate(d.getDate() - Number(m[1]));
    return { from: d.toISOString().slice(0, 10), to: today, label: `the last ${m[1]} days` };
  }
  for (let i = 0; i < 12; i++) {
    if (new RegExp(`\\b(in|during|for)?\\s*${MONTHS[i]}\\b`).test(t) || new RegExp(`\\b${MONTHS[i].slice(0, 3)}\\b`).test(t)) {
      let y = Number(today.slice(0, 4));
      const ym = t.match(/\b(20\d{2})\b/);
      if (ym) y = Number(ym[1]);
      else if (i + 1 > Number(today.slice(5, 7))) y -= 1;
      const s = `${y}-${String(i + 1).padStart(2, '0')}-01`;
      return { from: s, to: monthEnd(s), label: `${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)} ${y}` };
    }
  }
  return { from: monthStart(today), to: today, label: 'this month' };
}

/** True when the question names a period (otherwise parsePeriod falls back to "this month"). */
export function hasExplicitPeriod(q: string, today = todayISO()): boolean {
  const p = parsePeriod(q, today);
  return p.label !== 'this month' || /\bthis month\b/.test(q.toLowerCase());
}

/** Free-text subject of "spend on X" / "spent at X" questions. */
export function spendSubject(q: string): string | null {
  const m = q
    .toLowerCase()
    .match(/\b(?:on|at|for|from)\s+([a-z0-9#][a-z0-9'’&.\- ]{1,60}?)(?=\s+(?:this|last|in|during|over|per|each|every|since|so far|a|an|the past|past|daily|weekly|monthly|yearly|on average)\b|\s*[?.!,]|\s*$)/);
  if (!m) return null;
  const t = m[1].trim().replace(/^(the|my)\s+/, '');
  return t.length >= 2 && !/^(average|me|it|that|this|them|stuff|things|everything)$/.test(t) ? t : null;
}

const money = (c: number) => fromCents(c).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });

export interface AskAnswer {
  answer: string;
  engine: 'rules' | 'llm';
  data?: unknown;
}

async function subjectAnswer(db: DB, subject: string, question: string, today: string): Promise<AskAnswer | null> {
  const isTag = subject.startsWith('#');
  if (hasExplicitPeriod(question, today)) {
    const p = parsePeriod(question, today);
    const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1;
    const tr = await spendingTrend(db, { from: p.from, to: p.to, groupBy: days > 62 ? 'month' : 'week', q: subject });
    if (!tr.count) return null;
    const name = tr.merchant ?? (isTag ? subject : `"${subject}"`);
    const parts = tr.buckets.filter((b) => b.count).map((b) => `${b.label} ${money(b.amount)}`);
    return {
      engine: 'rules',
      answer:
        `You spent ${money(tr.total)} on ${name} in ${p.label} (${p.from} to ${p.to}) across ${tr.count} purchase${tr.count === 1 ? '' : 's'} — ${money(tr.avgPerTransaction)} on average each.` +
        (parts.length > 1 ? ` Breakdown: ${parts.join('; ')}.` : '') +
        (tr.byCategory.length > 1 ? ` Categories: ${tr.byCategory.map((c) => `${c.name} ${money(c.amount)}`).join(', ')}.` : ''),
      data: tr,
    };
  }
  const from = addMonths(monthStart(today), -11);
  const tr = await spendingTrend(db, { from, to: today, groupBy: 'month', q: subject });
  if (!tr.count) return null;
  const name = tr.merchant ?? (isTag ? subject : `"${subject}"`);
  const thisMonth = tr.buckets[tr.buckets.length - 1];
  const weeks = (Date.parse(today) - Date.parse(from)) / (7 * 86_400_000) + 1 / 7;
  const recent = tr.buckets.slice(-4, -1).map((b) => `${b.label} ${money(b.amount)}`);
  return {
    engine: 'rules',
    answer:
      `${name}: ${money(thisMonth.amount)} so far this month (${thisMonth.count} purchase${thisMonth.count === 1 ? '' : 's'}). ` +
      `Over the last 12 months you spent ${money(tr.total)} across ${tr.count} purchases — about ${money(Math.round(tr.total / 12))} a month, ${money(Math.round(tr.total / weeks))} a week, ${money(tr.avgPerTransaction)} per visit.` +
      (recent.length ? ` Previous months: ${recent.join('; ')}.` : '') +
      ` Open Insights and search "${tr.merchant ?? subject}" for the daily/weekly/monthly chart.`,
    data: tr,
  };
}

export async function ruleAsk(db: DB, question: string, today = todayISO()): Promise<AskAnswer> {
  const q = question.toLowerCase();
  const p = parsePeriod(q, today);
  const accts = await listAccounts(db);

  if (/net worth|worth/.test(q)) {
    const nw = await netWorthStatement(db, today);
    return {
      engine: 'rules',
      answer: `Your net worth is ${money(nw.netWorth)} at book value (${money(nw.netWorthMarket)} at market value): assets ${money(nw.totalAssets)} minus liabilities ${money(nw.totalLiabilities)}.`,
      data: nw,
    };
  }
  if (/savings rate|saving rate|how much (did|have) i save/.test(q)) {
    const is = await incomeStatement(db, p.from, p.to);
    const rate = is.savingsRate === null ? 'n/a' : `${(is.savingsRate * 100).toFixed(1)}%`;
    return { engine: 'rules', answer: `For ${p.label} you earned ${money(is.totalIncome)}, spent ${money(is.totalExpenses)} and saved ${money(is.netIncome)} — a savings rate of ${rate}.`, data: is };
  }
  if (/budget/.test(q)) {
    const b = await budgetStatus(db, p.from.slice(0, 7));
    const over = b.rows.filter((r) => r.budget > 0 && r.actual > r.budget);
    return {
      engine: 'rules',
      answer:
        `Budget for ${b.month}: ${money(b.totalActual)} spent of ${money(b.totalBudget)} budgeted.` +
        (over.length ? ` Over budget: ${over.map((r) => `${r.name} (${money(r.actual - r.budget)} over)`).join(', ')}.` : ' No categories are over budget.'),
      data: b,
    };
  }
  if (/\b(debt|owe|liabilit)/.test(q)) {
    const bs = await balanceSheet(db, today);
    const rows = bs.liabilities.flatMap((g) => g.rows);
    return { engine: 'rules', answer: `You owe ${money(bs.totalLiabilities)} in total${rows.length ? `: ${rows.map((r) => `${r.name} ${money(r.amount)}`).join(', ')}` : ''}.`, data: rows };
  }
  if (/top|biggest|largest|most|where/.test(q) && /(merchant|store|shop|place|vendor|where)/.test(q)) {
    const ms = await merchantSummary(db, p.from, p.to, 10);
    return {
      engine: 'rules',
      answer: ms.merchants.length ? `Top merchants for ${p.label}: ${ms.merchants.map((r, i) => `${i + 1}. ${r.name} ${money(r.amount)} (${r.count}×)`).join('; ')}.` : `No merchant spending recorded for ${p.label}.`,
      data: ms,
    };
  }
  const spendIntent = /(spen|spent|cost|pay|paid|expense|buy|bought|purchas|visit|how much|how often|times|go to|went)/.test(q) && !/\b(balance|owe|owing|limit|due)\b/.test(q);
  const mentions = spendIntent ? await merchantMentions(db, question, addMonths(monthStart(today), -23), today) : { merchants: [], tags: [] };
  for (const subject of [...mentions.tags, ...mentions.merchants]) {
    const a = await subjectAnswer(db, subject, question, today);
    if (a) return a;
  }
  if (mentions.merchants.length || mentions.tags.length) {
    const name = mentions.merchants[0] ?? mentions.tags[0];
    return { engine: 'rules', answer: `I couldn't find any spending on ${name} in ${hasExplicitPeriod(question, today) ? p.label : 'the last 12 months'}. Include the merchant when you record a purchase (e.g. "Coffee at Tims $3.50") or add a #tag to the memo so it can be tracked.` };
  }
  if (/top|biggest|largest|most/.test(q) && /(expense|spend|categor)/.test(q)) {
    const is = await incomeStatement(db, p.from, p.to);
    const top = is.expenses.slice(0, 5);
    return { engine: 'rules', answer: top.length ? `Top spending categories for ${p.label}: ${top.map((r, i) => `${i + 1}. ${r.name} ${money(r.amount)}`).join('; ')}.` : `No expenses recorded for ${p.label}.`, data: top };
  }
  const named = accts.filter((a) => {
    const terms = [a.name.toLowerCase(), ...(a.aliases ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2)];
    return terms.some((term) => new RegExp(`\\b${escapeRe(term)}\\b`).test(q));
  });
  const namedFlow = named.filter((a) => a.type === 'expense' || a.type === 'income');
  if (/(spen|spent|cost|pay|paid|expense|earn|income|make|made)/.test(q) && namedFlow.length) {
    const bal = await accountBalances(db, { from: p.from, to: p.to });
    const parts = namedFlow.map((a) => `${a.name}: ${money(bal.get(a.id)?.balance ?? 0)}`);
    const total = namedFlow.reduce((s, a) => s + (bal.get(a.id)?.balance ?? 0), 0);
    return { engine: 'rules', answer: `For ${p.label} (${p.from} to ${p.to}) — ${parts.join(', ')}${namedFlow.length > 1 ? `; total ${money(total)}` : ''}.`, data: { period: p, total } };
  }
  const namedBal = named.filter((a) => a.type === 'asset' || a.type === 'liability');
  if (namedBal.length && /(balance|how much|have|left|owe|in my)/.test(q)) {
    const bal = await accountBalances(db, { to: today });
    return { engine: 'rules', answer: namedBal.map((a) => `${a.name}: ${money(bal.get(a.id)?.balance ?? 0)}${a.type === 'liability' ? ' owing' : ''}`).join('; ') + '.' };
  }
  const subject = /(spen|spent|expense|cost|pay|paid)/.test(q) ? spendSubject(question) : null;
  if (subject) {
    const a = await subjectAnswer(db, subject, question, today);
    if (a) return a;
  }
  if (/(spen|spent|expense|cost)/.test(q)) {
    const is = await incomeStatement(db, p.from, p.to);
    return { engine: 'rules', answer: `You spent ${money(is.totalExpenses)} in ${p.label}. Largest: ${is.expenses.slice(0, 3).map((r) => `${r.name} ${money(r.amount)}`).join(', ') || 'none'}.`, data: is };
  }
  if (/(earn|income|made|make)/.test(q)) {
    const is = await incomeStatement(db, p.from, p.to);
    return { engine: 'rules', answer: `You earned ${money(is.totalIncome)} in ${p.label}${is.income.length ? ` (${is.income.map((r) => `${r.name} ${money(r.amount)}`).join(', ')})` : ''}.`, data: is };
  }
  if (/cash|liquid|bank/.test(q)) {
    const nw = await netWorthStatement(db, today);
    return { engine: 'rules', answer: `You have ${money(nw.liquidAssets)} in cash and bank accounts.` };
  }
  const nw = await netWorthStatement(db, today);
  const is = await incomeStatement(db, monthStart(today), today);
  return {
    engine: 'rules',
    answer: `Here's a snapshot: net worth ${money(nw.netWorth)}, cash ${money(nw.liquidAssets)}, this month income ${money(is.totalIncome)} vs. expenses ${money(is.totalExpenses)}. Try asking "How much did I spend on groceries last month?", "What's my savings rate this year?", "Am I over budget?" or "How much do I owe?".`,
  };
}

async function financialContext(db: DB, today: string, question = ''): Promise<string> {
  const nw = await netWorthStatement(db, today);
  const months: unknown[] = [];
  for (let i = 5; i >= 0; i--) {
    const s = addMonths(monthStart(today), -i);
    const is = await incomeStatement(db, s, i === 0 ? today : monthEnd(s));
    months.push({
      month: s.slice(0, 7),
      income: fromCents(is.totalIncome),
      expenses: fromCents(is.totalExpenses),
      byCategory: Object.fromEntries(is.expenses.map((r) => [r.name, fromCents(r.amount)])),
      incomeBySource: Object.fromEntries(is.income.map((r) => [r.name, fromCents(r.amount)])),
    });
  }
  const balances = [...nw.assets.flatMap((g) => g.rows), ...nw.liabilities.flatMap((g) => g.rows)].map((r) => ({ account: r.name, balance: fromCents(r.amount) }));
  const b = await budgetStatus(db, today.slice(0, 7));
  const sixAgo = addMonths(monthStart(today), -5);
  const ms = await merchantSummary(db, sixAgo, today, 40);
  const tags = (await tagSummary(db, sixAgo, today)).slice(0, 20);
  const mentions = question ? await merchantMentions(db, question, addMonths(monthStart(today), -23), today) : { merchants: [], tags: [] };
  const subjects = [...mentions.tags, ...mentions.merchants];
  const free = !subjects.length && question ? spendSubject(question) : null;
  if (free) subjects.push(free);
  const focus = [];
  for (const subj of subjects.slice(0, 3)) {
    const tr = await spendingTrend(db, { from: addMonths(monthStart(today), -11), to: today, groupBy: 'month', q: subj });
    focus.push({
      searchedFor: subj,
      merchant: tr.merchant,
      matchedTerms: tr.matchedTerms,
      last12MonthsTotal: fromCents(tr.total),
      purchases: tr.count,
      avgPerPurchase: fromCents(tr.avgPerTransaction),
      monthly: tr.buckets.map((x) => ({ month: x.start.slice(0, 7), amount: fromCents(x.amount), purchases: x.count })),
      byCategory: tr.byCategory.map((c) => ({ category: c.name, amount: fromCents(c.amount) })),
      recentTransactions: tr.transactions.slice(0, 15).map((x) => ({ date: x.date, description: x.description, payee: x.payee, memo: x.memo, amount: fromCents(x.amount) })),
    });
  }
  return JSON.stringify({
    today,
    currency: 'CAD',
    netWorth: fromCents(nw.netWorth),
    netWorthMarket: fromCents(nw.netWorthMarket),
    totalAssets: fromCents(nw.totalAssets),
    totalLiabilities: fromCents(nw.totalLiabilities),
    balances,
    last6Months: months,
    budgetThisMonth: b.rows.filter((r) => r.budget).map((r) => ({ category: r.name, budget: fromCents(r.budget), actual: fromCents(r.actual) })),
    topMerchantsLast6Months: ms.merchants.map((r) => ({ merchant: r.name, amount: fromCents(r.amount), purchases: r.count, avgPerPurchase: fromCents(r.avgPerVisit), lastDate: r.lastDate, category: r.categories[0] })),
    spendingWithoutMerchantLast6Months: fromCents(ms.unattributed),
    memoTagsLast6Months: tags.map((t) => ({ tag: t.tag, amount: fromCents(t.amount), purchases: t.count })),
    questionFocus: focus,
  });
}

export async function ask(db: DB, question: string, today = todayISO()): Promise<AskAnswer> {
  if (!llmConfig()) return ruleAsk(db, question, today);
  try {
    const answer = await chat(
      'You are a careful personal CFO and financial analyst. Answer ONLY from the ledger-derived data provided (amounts in CAD). ' +
        'Categories (byCategory) are expense accounts; merchants come from the payee/memo of each transaction, with nicknames and store numbers merged (e.g. "Tims" = Tim Hortons). ' +
        'When questionFocus is present it holds the exact ledger matches for the merchant, #tag or keyword in the question — use it for merchant-level answers (totals, per-month, per-purchase averages, trends). ' +
        'If the data is insufficient, say so and suggest recording the merchant in the payee or a #tag in the memo. Be concise, use specific numbers, and give practical observations. Do not give regulated investment advice.',
      `Ledger data: ${await financialContext(db, today, question)}\n\nQuestion: ${question}`,
      false,
    );
    return { answer, engine: 'llm' };
  } catch (e) {
    const r = await ruleAsk(db, question, today);
    return { ...r, answer: `${r.answer}\n\n(AI unavailable: ${(e as Error).message})` };
  }
}
