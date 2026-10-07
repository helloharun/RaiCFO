import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from './db.js';
import { openTestDb } from './testDb.js';
import { seedIfEmpty } from './seed.js';
import { getAccountByCode, postEntry } from './engine/ledger.js';
import { MerchantMatcher, bucketStart, merchantSummary, saveMerchantGroups, spendingTrend, tagSummary } from './engine/insights.js';
import { ruleAsk, spendSubject } from './ai/ask.js';

const TODAY = '2026-10-05';
let db: DB;
let drop: () => Promise<void>;
const code = async (c: string) => (await getAccountByCode(db, c))!.id;
const spend = async (date: string, payee: string | null, amount: number, opts: { cat?: string; description?: string; memo?: string } = {}) =>
  postEntry(db, {
    date,
    description: opts.description ?? `Purchase${payee ? ` at ${payee}` : ''}`,
    payee,
    memo: opts.memo ?? null,
    lines: [
      { accountId: await code(opts.cat ?? '5110'), debit: amount },
      { accountId: await code('1010'), credit: amount },
    ],
  });

beforeEach(async () => {
  ({ db, drop } = await openTestDb());
  await seedIfEmpty(db);
  await postEntry(db, { date: '2026-01-02', description: 'Opening', source: 'opening', lines: [{ accountId: await code('1010'), debit: 1000 }, { accountId: await code('3000'), credit: 1000 }] });
  await spend('2026-09-28', 'TIM HORTONS #1234', 3.5);
  await spend('2026-09-30', 'Tims', 4.25);
  await spend('2026-10-01', null, 2.75, { description: 'Coffee at timmies' });
  await spend('2026-10-02', "Joe's Diner", 20, { memo: 'team lunch #worktrip' });
  await spend('2026-10-03', 'Costco Wholesale #555', 120, { cat: '5100' });
  await spend('2026-08-15', 'Time Out Bar', 30);
});
afterEach(async () => {
  await drop();
});

describe('merchant matching', () => {
  it('groups nicknames, store numbers and processor prefixes', () => {
    const m = new MerchantMatcher([]);
    expect(m.canonical('TIM HORTONS #1234')).toBe('Tim Hortons');
    expect(m.canonical("Tim Horton's")).toBe('Tim Hortons');
    expect(m.canonical('timmies')).toBe('Tim Hortons');
    expect(m.canonical('Uber Eats')).toBe('Uber Eats');
    expect(m.canonical('UBER TRIP')).toBe('Uber');
    expect(m.canonical('SQ *JOES DINER 00123')).toBe('Joes Diner');
    expect(m.canonical('TD Auto Finance')).toBe('TD Auto Finance');
    expect(m.find('time out bar')).toBeNull();
  });
  it('weeks start on Monday', () => {
    expect(bucketStart('2026-10-04', 'week')).toBe('2026-09-28');
    expect(bucketStart('2026-10-05', 'week')).toBe('2026-10-05');
  });
});

describe('spending explorer', () => {
  it('finds all Tim Hortons spending by nickname, without matching unrelated words', async () => {
    const tr = await spendingTrend(db, { from: '2026-08-01', to: TODAY, groupBy: 'week', q: 'Tims' });
    expect(tr.merchant).toBe('Tim Hortons');
    expect(tr.count).toBe(3);
    expect(tr.total).toBe(1050);
    expect(tr.transactions.map((t) => t.description)).not.toContain('Purchase at Time Out Bar');
    const wk = tr.buckets.find((b) => b.start === '2026-09-28')!;
    expect(wk.amount).toBe(1050);
    expect(wk.count).toBe(3);
  });
  it('groups by day, month and year and fills empty periods', async () => {
    const d = await spendingTrend(db, { from: '2026-09-28', to: '2026-10-03', groupBy: 'day', q: 'tim hortons' });
    expect(d.buckets).toHaveLength(6);
    expect(d.buckets.filter((b) => b.count).map((b) => b.start)).toEqual(['2026-09-28', '2026-09-30', '2026-10-01']);
    const m = await spendingTrend(db, { from: '2026-01-01', to: TODAY, groupBy: 'month' });
    expect(m.buckets).toHaveLength(10);
    expect(m.total).toBe(18050);
    const y = await spendingTrend(db, { from: '2026-01-01', to: TODAY, groupBy: 'year' });
    expect(y.buckets).toHaveLength(1);
  });
  it('supports #tags and free-text memo search', async () => {
    const tag = await spendingTrend(db, { from: '2026-01-01', to: TODAY, groupBy: 'month', q: '#worktrip' });
    expect(tag.total).toBe(2000);
    const word = await spendingTrend(db, { from: '2026-01-01', to: TODAY, groupBy: 'month', q: 'team lunch' });
    expect(word.count).toBe(1);
    expect((await tagSummary(db, '2026-01-01', TODAY))[0]).toMatchObject({ tag: '#worktrip', amount: 2000, count: 1 });
  });
  it('tracks asset accounts with a running balance', async () => {
    const tr = await spendingTrend(db, { from: '2026-09-01', to: TODAY, groupBy: 'month', accountId: await code('1010') });
    expect(tr.mode).toBe('account');
    expect(tr.openingBalance).toBe(100000 - 3000);
    expect(tr.closingBalance).toBe(100000 - 18050);
    expect(tr.buckets.at(-1)!.balance).toBe(tr.closingBalance);
  });
  it('rejects bad input', async () => {
    await expect(spendingTrend(db, { from: TODAY, to: '2026-01-01', groupBy: 'month' })).rejects.toThrow(/date range/);
    await expect(spendingTrend(db, { from: '2026-01-01', to: TODAY, groupBy: 'hour' as never })).rejects.toThrow(/groupBy/);
    await expect(spendingTrend(db, { from: '2000-01-01', to: TODAY, groupBy: 'day' })).rejects.toThrow(/too many/);
  });
  it('merchant summary merges variants; custom groups extend matching', async () => {
    const s = await merchantSummary(db, '2026-01-01', TODAY);
    expect(s.merchants.find((m) => m.name === 'Tim Hortons')).toMatchObject({ amount: 1050, count: 3 });
    expect(s.merchants.find((m) => m.name === 'Costco')).toMatchObject({ amount: 12000, count: 1 });
    await saveMerchantGroups(db, [{ name: "Joe's Diner", aliases: ['joes', 'the usual spot'] }]);
    const tr = await spendingTrend(db, { from: '2026-01-01', to: TODAY, groupBy: 'month', q: 'the usual spot' });
    expect(tr.merchant).toBe("Joe's Diner");
    expect(tr.total).toBe(2000);
    await expect(saveMerchantGroups(db, [{ name: '', aliases: [] }])).rejects.toThrow();
  });
});

describe('Ask Finance at merchant level', () => {
  it('answers "How much am I spending on Tims?" from merchant data', async () => {
    const a = await ruleAsk(db, 'How much am I spending on Tims?', TODAY);
    expect(a.answer).toContain('Tim Hortons');
    expect(a.answer).toContain('$10.50');
    expect(a.answer).toContain('$2.75 so far this month');
  });
  it('respects an explicit period and #tags', async () => {
    expect((await ruleAsk(db, 'How much did I spend at Tim Hortons last month?', TODAY)).answer).toContain('$7.75');
    expect((await ruleAsk(db, 'How much did I spend on #worktrip this year?', TODAY)).answer).toContain('$20.00');
    expect((await ruleAsk(db, "What did I spend at Joe's Diner this month?", TODAY)).answer).toContain('$20.00');
  });
  it('lists top merchants and keeps category questions working', async () => {
    expect((await ruleAsk(db, 'Where do I spend the most this year?', TODAY)).answer).toMatch(/1\. Costco/);
    expect((await ruleAsk(db, 'How much did I spend on groceries this month?', TODAY)).answer).toContain('Groceries: $120.00');
  });
  it('extracts the spend subject', () => {
    expect(spendSubject('how much did I spend on the corner bakery last month?')).toBe('corner bakery');
    expect(spendSubject('what did I spend at Joe’s Diner')).toBe('joe’s diner');
  });
});
