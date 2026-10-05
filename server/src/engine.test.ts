import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from './db.js';
import { seedIfEmpty } from './seed.js';
import { getAccountByCode, getEntry, postEntry, reverseEntry, setSetting, accountBalances } from './engine/ledger.js';
import { balanceSheet, cashFlowStatement, equityStatement, incomeStatement, trialBalance } from './engine/reports.js';
import { ruleInterpret } from './ai/parser.js';
import { buildProposal } from './ai/proposal.js';
import { seedDemo } from './scripts/demoData.js';
import { todayISO } from './money.js';

const TODAY = '2026-10-05';
let db: DB;
const code = (c: string) => getAccountByCode(db, c)!.id;
const propose = (text: string) => buildProposal(db, ruleInterpret(db, text, TODAY), 'rules', text);
const summary = (text: string) => {
  const p = propose(text);
  return { p, lines: p.entry.lines.map((l) => [getName(l.accountId), l.debit ? 'Dr' : 'Cr', l.debit || l.credit]) };
};
const getName = (id: number) => (db.prepare('SELECT name FROM accounts WHERE id = ?').get(id) as { name: string }).name;

beforeEach(() => {
  db = openDb(':memory:');
  seedIfEmpty(db);
});

describe('ledger engine', () => {
  it('rejects unbalanced entries', () => {
    expect(() =>
      postEntry(db, { date: TODAY, description: 'bad', lines: [{ accountId: code('5100'), debit: 10 }, { accountId: code('1010'), credit: 9 }] }),
    ).toThrow(/does not balance/);
  });

  it('rejects lines with both debit and credit and single-line entries', () => {
    expect(() => postEntry(db, { date: TODAY, description: 'x', lines: [{ accountId: code('5100'), debit: 10 }] })).toThrow();
    expect(() =>
      postEntry(db, { date: TODAY, description: 'x', lines: [{ accountId: code('5100'), debit: 10, credit: 10 }, { accountId: code('1010'), credit: 0 }] }),
    ).toThrow();
  });

  it('reverses entries instead of deleting them', () => {
    const id = postEntry(db, { date: TODAY, description: 'Groceries', lines: [{ accountId: code('5100'), debit: 50 }, { accountId: code('1010'), credit: 50 }] });
    const rev = reverseEntry(db, id);
    expect(getEntry(db, id)!.reversed_by).toBe(rev);
    expect(accountBalances(db).get(code('5100'))!.balance).toBe(0);
    expect(() => reverseEntry(db, id)).toThrow(/already/);
  });

  it('enforces the lock date', () => {
    setSetting(db, 'lock_date', '2026-09-30');
    expect(() =>
      postEntry(db, { date: '2026-09-15', description: 'x', lines: [{ accountId: code('5100'), debit: 1 }, { accountId: code('1010'), credit: 1 }] }),
    ).toThrow(/locked/);
  });
});

describe('natural language → proposal (spec examples)', () => {
  it('grocery purchase with debit card yesterday', () => {
    const { p, lines } = summary('Bought groceries at Walmart for $86.42 using my TD debit card yesterday.');
    expect(p.interpretation.transactionDate).toBe('2026-10-04');
    expect(p.interpretation.merchant).toBe('Walmart');
    expect(lines).toEqual([['Groceries', 'Dr', 86.42], ['TD Chequing', 'Cr', 86.42]]);
    expect(p.balanced).toBe(true);
  });

  it('salary', () => {
    const { lines } = summary('Received $2,000 salary into TD.');
    expect(lines).toEqual([['TD Chequing', 'Dr', 2000], ['Employment Income', 'Cr', 2000]]);
  });

  it('credit-card purchase', () => {
    const { p, lines } = summary('Dinner at The Keg for $75 on my MBNA credit card');
    expect(p.entry.transactionType).toBe('credit_card_purchase');
    expect(lines).toEqual([['Restaurants', 'Dr', 75], ['MBNA Credit Card', 'Cr', 75]]);
  });

  it('credit-card payment creates no expense', () => {
    const { p, lines } = summary('Paid $75 to my MBNA credit card from TD');
    expect(p.entry.transactionType).toBe('credit_card_payment');
    expect(lines).toEqual([['MBNA Credit Card', 'Dr', 75], ['TD Chequing', 'Cr', 75]]);
  });

  it('bank transfer is not income or expense', () => {
    const { lines } = summary('Transferred $500 from TD to Wealthsimple Cash');
    expect(lines).toEqual([['Wealthsimple Cash', 'Dr', 500], ['TD Chequing', 'Cr', 500]]);
  });

  it('investment purchase and sale with capital gain', () => {
    const buy = propose('Bought 10 shares of XEQT for $300 in my TFSA from TD');
    expect(buy.entry.transactionType).toBe('investment_purchase');
    expect(buy.entry.lines[0]).toMatchObject({ accountId: code('1110'), debit: 300, symbol: 'XEQT', quantity: 10 });
    postEntry(db, buy.entry);
    const { p, lines } = summary('Sold 5 shares of XEQT for $200 from my TFSA');
    expect(p.entry.transactionType).toBe('investment_sale');
    expect(lines).toEqual([['TFSA', 'Dr', 200], ['TFSA', 'Cr', 150], ['Capital Gains', 'Cr', 50]]);
  });

  it('loan proceeds and split loan payment', () => {
    expect(summary('Received a $10,000 personal loan into TD').lines).toEqual([['TD Chequing', 'Dr', 10000], ['Personal Loan', 'Cr', 10000]]);
    expect(summary('Paid $575 auto loan payment from TD, $500 principal and $75 interest').lines).toEqual([
      ['Auto Loan', 'Dr', 500],
      ['Interest Expense', 'Dr', 75],
      ['TD Chequing', 'Cr', 575],
    ]);
  });

  it('asks for clarification when ambiguous', () => {
    const p = propose('Spent $40');
    expect(p.clarifications.length).toBeGreaterThan(0);
    expect(p.balanced).toBe(true);
  });

  it('foreign currency converts to CAD', () => {
    const p = propose('Spent US$50 at Amazon with my MBNA card');
    expect(p.entry.currency).toBe('USD');
    const id = postEntry(db, p.entry);
    const e = getEntry(db, id)!;
    expect(e.lines.find((l) => l.debit)!.debit).toBe(6850);
  });

  it('learns merchant categories', () => {
    const p = propose('Paid $30 at Zorbas Deli with TD');
    p.entry.lines[0].accountId = code('5110');
    postEntry(db, p.entry);
    expect(summary('$12 at Zorbas Deli with TD').lines[0][0]).toBe('Restaurants');
  });
});

describe('investment holdings guard', () => {
  it('rejects selling more units than held', () => {
    postEntry(db, propose('Bought 10 shares of XEQT for $300 in my TFSA from TD').entry);
    const oversell = propose('Sold 10000 shares of XEQT at $40 from my TFSA into TD');
    expect(() => postEntry(db, oversell.entry)).toThrow(/only 10 held/);
    expect(() => postEntry(db, propose('Sold 4 shares of XEQT for $160 from my TFSA').entry)).not.toThrow();
  });
});

describe('financial statements', () => {
  it('stay in balance with demo data', () => {
    const today = todayISO();
    const n = seedDemo(db, today);
    expect(n).toBeGreaterThan(100);
    expect(trialBalance(db, today).balanced).toBe(true);
    const bs = balanceSheet(db, today);
    expect(bs.balanced).toBe(true);
    const from = `${today.slice(0, 4)}-01-01`;
    expect(cashFlowStatement(db, from, today).reconciles).toBe(true);
    expect(equityStatement(db, from, today).reconciles).toBe(true);
    const is = incomeStatement(db, from, today);
    expect(is.totalIncome).toBeGreaterThan(0);
  });
});
