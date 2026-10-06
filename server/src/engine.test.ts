import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from './db.js';
import { openTestDb } from './testDb.js';
import { seedIfEmpty } from './seed.js';
import { getAccountByCode, getEntry, postEntry, reverseEntry, setSetting, accountBalances } from './engine/ledger.js';
import { balanceSheet, cashFlowStatement, equityStatement, incomeStatement, trialBalance } from './engine/reports.js';
import { ruleInterpret } from './ai/parser.js';
import { buildProposal } from './ai/proposal.js';
import { seedDemo } from './scripts/demoData.js';
import { completeReconciliation, reconciliationDetail, startReconciliation, toggleCleared } from './engine/services.js';
import { todayISO } from './money.js';

const TODAY = '2026-10-05';
let db: DB;
const code = async (c: string) => (await getAccountByCode(db, c))!.id;
const propose = async (text: string) => buildProposal(db, (await ruleInterpret(db, text, TODAY)), 'rules', text);
const summary = async (text: string) => {
  const p = await propose(text);
  const lines = [];
  for (const l of p.entry.lines) lines.push([await getName(l.accountId), l.debit ? 'Dr' : 'Cr', l.debit || l.credit]);
  return { p, lines };
};
const getName = async (id: number) => (await db.prepare('SELECT name FROM accounts WHERE id = ?').get(id) as { name: string }).name;

let drop: () => Promise<void>;
beforeEach(async () => {
  ({ db, drop } = await openTestDb());
  await seedIfEmpty(db);
});
afterEach(async () => {
  await drop();
});

describe('ledger engine', () => {
  it('rejects unbalanced entries', async () => {
    await expect(
      postEntry(db, { date: TODAY, description: 'bad', lines: [{ accountId: (await code('5100')), debit: 10 }, { accountId: (await code('1010')), credit: 9 }] }),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects lines with both debit and credit and single-line entries', async () => {
    await expect(postEntry(db, { date: TODAY, description: 'x', lines: [{ accountId: (await code('5100')), debit: 10 }] })).rejects.toThrow();
    await expect(
      postEntry(db, { date: TODAY, description: 'x', lines: [{ accountId: (await code('5100')), debit: 10, credit: 10 }, { accountId: (await code('1010')), credit: 0 }] }),
    ).rejects.toThrow();
  });

  it('reverses entries instead of deleting them', async () => {
    const id = await postEntry(db, { date: TODAY, description: 'Groceries', lines: [{ accountId: (await code('5100')), debit: 50 }, { accountId: (await code('1010')), credit: 50 }] });
    const rev = await reverseEntry(db, id);
    expect((await getEntry(db, id))!.reversed_by).toBe(rev);
    expect((await accountBalances(db)).get((await code('5100')))!.balance).toBe(0);
    await expect(reverseEntry(db, id)).rejects.toThrow(/already/);
  });

  it('enforces the lock date', async () => {
    await setSetting(db, 'lock_date', '2026-09-30');
    await expect(
      postEntry(db, { date: '2026-09-15', description: 'x', lines: [{ accountId: (await code('5100')), debit: 1 }, { accountId: (await code('1010')), credit: 1 }] }),
    ).rejects.toThrow(/locked/);
  });
});

describe('natural language → proposal (spec examples)', () => {
  it('grocery purchase with debit card yesterday', async () => {
    const { p, lines } = await summary('Bought groceries at Walmart for $86.42 using my TD debit card yesterday.');
    expect(p.interpretation.transactionDate).toBe('2026-10-04');
    expect(p.interpretation.merchant).toBe('Walmart');
    expect(lines).toEqual([['Groceries', 'Dr', 86.42], ['TD Chequing', 'Cr', 86.42]]);
    expect(p.balanced).toBe(true);
  });

  it('salary', async () => {
    const { lines } = await summary('Received $2,000 salary into TD.');
    expect(lines).toEqual([['TD Chequing', 'Dr', 2000], ['Employment Income', 'Cr', 2000]]);
  });

  it('credit-card purchase', async () => {
    const { p, lines } = await summary('Dinner at The Keg for $75 on my MBNA credit card');
    expect(p.entry.transactionType).toBe('credit_card_purchase');
    expect(lines).toEqual([['Restaurants', 'Dr', 75], ['MBNA Credit Card', 'Cr', 75]]);
  });

  it('credit-card payment creates no expense', async () => {
    const { p, lines } = await summary('Paid $75 to my MBNA credit card from TD');
    expect(p.entry.transactionType).toBe('credit_card_payment');
    expect(lines).toEqual([['MBNA Credit Card', 'Dr', 75], ['TD Chequing', 'Cr', 75]]);
  });

  it('bank transfer is not income or expense', async () => {
    const { lines } = await summary('Transferred $500 from TD to Wealthsimple Cash');
    expect(lines).toEqual([['Wealthsimple Cash', 'Dr', 500], ['TD Chequing', 'Cr', 500]]);
  });

  it('investment purchase and sale with capital gain', async () => {
    const buy = await propose('Bought 10 shares of XEQT for $300 in my TFSA from TD');
    expect(buy.entry.transactionType).toBe('investment_purchase');
    expect(buy.entry.lines[0]).toMatchObject({ accountId: (await code('1110')), debit: 300, symbol: 'XEQT', quantity: 10 });
    await postEntry(db, buy.entry);
    const { p, lines } = await summary('Sold 5 shares of XEQT for $200 from my TFSA');
    expect(p.entry.transactionType).toBe('investment_sale');
    expect(lines).toEqual([['TFSA', 'Dr', 200], ['TFSA', 'Cr', 150], ['Capital Gains', 'Cr', 50]]);
  });

  it('loan proceeds and split loan payment', async () => {
    expect((await summary('Received a $10,000 personal loan into TD')).lines).toEqual([['TD Chequing', 'Dr', 10000], ['Personal Loan', 'Cr', 10000]]);
    expect((await summary('Paid $575 auto loan payment from TD, $500 principal and $75 interest')).lines).toEqual([
      ['Auto Loan', 'Dr', 500],
      ['Interest Expense', 'Dr', 75],
      ['TD Chequing', 'Cr', 575],
    ]);
  });

  it('asks for clarification when ambiguous', async () => {
    const p = await propose('Spent $40');
    expect(p.clarifications.length).toBeGreaterThan(0);
    expect(p.balanced).toBe(true);
  });

  it('foreign currency converts to CAD', async () => {
    const p = await propose('Spent US$50 at Amazon with my MBNA card');
    expect(p.entry.currency).toBe('USD');
    const id = await postEntry(db, p.entry);
    const e = (await getEntry(db, id))!;
    expect(e.lines.find((l) => l.debit)!.debit).toBe(6850);
  });

  it('learns merchant categories', async () => {
    const p = await propose('Paid $30 at Zorbas Deli with TD');
    p.entry.lines[0].accountId = await code('5110');
    await postEntry(db, p.entry);
    expect((await summary('$12 at Zorbas Deli with TD')).lines[0][0]).toBe('Restaurants');
  });
});

describe('investment holdings guard', () => {
  it('rejects selling more units than held', async () => {
    await postEntry(db, (await propose('Bought 10 shares of XEQT for $300 in my TFSA from TD')).entry);
    const oversell = await propose('Sold 10000 shares of XEQT at $40 from my TFSA into TD');
    await expect(postEntry(db, oversell.entry)).rejects.toThrow(/only 10 held/);
    await expect(postEntry(db, (await propose('Sold 4 shares of XEQT for $160 from my TFSA')).entry)).resolves.toBeGreaterThan(0);
  });
});

describe('reconciliation', () => {
  it('does not double count the current reconciliation once completed', async () => {
    await postEntry(db, (await propose('Received $2,000 salary into TD on 2026-10-01')).entry);
    const id = await startReconciliation(db, (await code('1010')), TODAY, 2000);
    for (const r of (await reconciliationDetail(db, id)).rows) await toggleCleared(db, id, r.id, true);
    expect((await reconciliationDetail(db, id)).difference).toBe(0);
    await completeReconciliation(db, id);
    const after = await reconciliationDetail(db, id);
    expect(after.previouslyReconciled).toBe(0);
    expect(after.clearedBalance).toBe(200000);
    expect(after.difference).toBe(0);
  });
});

describe('financial statements', () => {
  it('stay in balance with demo data', async () => {
    const today = todayISO();
    const n = await seedDemo(db, today);
    expect(n).toBeGreaterThan(100);
    expect((await trialBalance(db, today)).balanced).toBe(true);
    const bs = await balanceSheet(db, today);
    expect(bs.balanced).toBe(true);
    const from = `${today.slice(0, 4)}-01-01`;
    expect((await cashFlowStatement(db, from, today)).reconciles).toBe(true);
    expect((await equityStatement(db, from, today)).reconciles).toBe(true);
    const is = await incomeStatement(db, from, today);
    expect(is.totalIncome).toBeGreaterThan(0);
  });
});
