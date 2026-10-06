import type { DB } from '../db.js';
import { addDays, addMonths, monthEnd, todayISO } from '../money.js';
import type { LineInput } from '../types.js';
import { balanceOf, getAccountByCode, postEntry, USER_ID } from '../engine/ledger.js';
import { setBudget, upsertRecurring } from '../engine/services.js';

/** Loads ~6 months of realistic sample activity. Every entry goes through the normal posting engine. */
export async function seedDemo(db: DB, today = todayISO()): Promise<number> {
  const acc = async (code: string) => {
    const a = await getAccountByCode(db, code);
    if (!a) throw new Error(`Missing account ${code}`);
    return a.id;
  };
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const amt = (min: number, max: number) => Math.round((min + rand() * (max - min)) * 100) / 100;
  let n = 0;
  const post = async (date: string, description: string, type: string, lines: LineInput[], payee?: string) => {
    if (date > today) return;
    await postEntry(db, { date, description, payee: payee ?? null, transactionType: type, source: 'demo', lines });
    n++;
  };
  const simple = async (date: string, description: string, type: string, debit: string, credit: string, amount: number, payee?: string, extra: Partial<LineInput> = {}) =>
    post(date, description, type, [{ accountId: (await acc(debit)), debit: amount, ...extra }, { accountId: (await acc(credit)), credit: amount }], payee);

  const start = addMonths(`${today.slice(0, 7)}-01`, -6);
  await db.transaction(async () => {
    await simple(start, 'Opening balance — TD Chequing', 'opening_balance', '1010', '3000', 4500);
    await simple(start, 'Opening balance — TD Savings', 'opening_balance', '1020', '3000', 12000);
    await simple(start, 'Opening balance — TFSA cash', 'opening_balance', '1110', '3000', 8000);
    await simple(start, 'Opening balance — Vehicle', 'opening_balance', '1200', '3000', 18000);
    await simple(start, 'Opening balance — Auto Loan', 'opening_balance', '3000', '2210', 14000);
    await simple(start, 'Opening balance — Student Loan', 'opening_balance', '3000', '2220', 9000);
    await simple(start, 'Opening balance — MBNA Credit Card', 'opening_balance', '3000', '2000', 650);

    const groceries = ['Walmart', 'Costco', 'Loblaws', 'No Frills', 'Farm Boy'];
    const restaurants = ['Tim Hortons', 'Starbucks', 'Pizza Pizza', 'Sushi Shop', 'The Keg'];
    for (let m = 0; m <= 6; m++) {
      const ms = addMonths(start, m);
      const me = monthEnd(ms);
      const d = (day: number) => addDays(ms, day - 1);
      await simple(d(1), 'Monthly rent', 'expense', '5010', '1010', 1650, 'Landlord');
      await simple(d(15), 'Salary', 'income', '1010', '4000', 2450, 'Acme Corp');
      await simple(me, 'Salary', 'income', '1010', '4000', 2450, 'Acme Corp');
      await post(d(5), 'Auto loan payment', 'loan_payment', [
        { accountId: (await acc('2210')), debit: 380, memo: 'Principal' },
        { accountId: (await acc('5710')), debit: 70, memo: 'Interest' },
        { accountId: (await acc('1010')), credit: 450 },
      ], 'TD Auto Finance');
      await simple(d(16), 'Transfer to savings', 'transfer', '1020', '1010', 500);
      await simple(d(3), 'Phone bill', 'credit_card_purchase', '5400', '2000', 65, 'Koodo');
      await simple(d(8), 'Internet', 'expense', '5410', '1010', 75, 'Bell');
      await simple(d(12), 'Netflix', 'credit_card_purchase', '5800', '2000', 16.99, 'Netflix');
      await simple(d(9), 'Hydro bill', 'expense', '5030', '1010', amt(60, 110), 'Toronto Hydro');
      await simple(me, 'Savings interest', 'interest', '1020', '4300', amt(18, 30), 'TD');
      for (const day of [2, 9, 17, 24]) {
        const store = groceries[Math.floor(rand() * groceries.length)];
        await simple(d(day), `Groceries at ${store}`, day % 2 ? 'credit_card_purchase' : 'expense', '5100', day % 2 ? '2000' : '1010', amt(70, 170), store);
      }
      for (const day of [6, 13, 22]) {
        const r = restaurants[Math.floor(rand() * restaurants.length)];
        await simple(d(day), `Dinner at ${r}`, 'credit_card_purchase', '5110', '2000', amt(12, 85), r);
      }
      await simple(d(7), 'Gas', 'credit_card_purchase', '5210', '2000', amt(55, 75), 'Petro-Canada');
      await simple(d(21), 'Gas', 'credit_card_purchase', '5210', '2000', amt(55, 75), 'Esso');
      await simple(d(11), 'Shopping', 'credit_card_purchase', '5510', '2000', amt(20, 140), 'Amazon');
      if (m % 2 === 0) await simple(d(18), 'Movie night', 'credit_card_purchase', '5500', '2000', amt(25, 60), 'Cineplex');
      const price = 30 + m * 0.4;
      await simple(d(2), 'Buy 10 XEQT in TFSA', 'investment_purchase', '1110', '1010', Math.round(price * 10 * 100) / 100, 'Wealthsimple', { symbol: 'XEQT', quantity: 10 });
      if (m % 3 === 2) await simple(d(28), 'XEQT distribution', 'dividend', '1110', '4400', 18.4, 'iShares');
      const statement = await balanceOf(db, (await acc('2000')), addDays(ms, -1));
      if (statement > 0) await simple(d(20), 'MBNA credit card payment', 'credit_card_payment', '2000', '1010', statement / 100, 'MBNA');
    }
    const lastMonth = addMonths(`${today.slice(0, 7)}-01`, -1);
    const sell = addDays(lastMonth, 9);
    await post(sell, 'Sell 5 XEQT', 'investment_sale', [
      { accountId: (await acc('1110')), debit: 165 },
      { accountId: (await acc('1110')), credit: 151, symbol: 'XEQT', quantity: -5, memo: 'Cost basis (average cost)' },
      { accountId: (await acc('4500')), credit: 14, memo: 'Realised capital gain' },
    ], 'Wealthsimple');
  })();

  await db.prepare("UPDATE securities SET name = 'iShares Core Equity ETF Portfolio', last_price = 3310, price_date = ? WHERE symbol = 'XEQT' AND user_id = ?").run(today, USER_ID);
  const budgets: Array<[string, number]> = [['5010', 1650], ['5100', 550], ['5110', 180], ['5210', 140], ['5400', 70], ['5410', 80], ['5800', 25], ['5500', 60], ['5510', 120], ['5030', 100]];
  for (const [code, a] of budgets) await setBudget(db, (await acc(code)), '*', a);
  await upsertRecurring(db, {
    description: 'Monthly rent',
    frequency: 'monthly',
    nextDate: addMonths(`${today.slice(0, 7)}-01`, 1),
    autoPost: true,
    template: { description: 'Monthly rent', payee: 'Landlord', transactionType: 'expense', lines: [{ accountId: (await acc('5010')), debit: 1650 }, { accountId: (await acc('1010')), credit: 1650 }] },
  });
  await upsertRecurring(db, {
    description: 'Netflix',
    frequency: 'monthly',
    nextDate: addDays(addMonths(`${today.slice(0, 7)}-01`, 1), 11),
    autoPost: true,
    template: { description: 'Netflix', payee: 'Netflix', transactionType: 'credit_card_purchase', lines: [{ accountId: (await acc('5800')), debit: 16.99 }, { accountId: (await acc('2000')), credit: 16.99 }] },
  });
  return n;
}
