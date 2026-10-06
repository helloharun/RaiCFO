import type { DB } from '../db.js';
import { addMonths, monthEnd, monthStart, todayISO } from '../money.js';
import { USER_ID, listEntries } from './ledger.js';
import { balanceSheet, incomeStatement, netWorthStatement, netWorthTrend, trialBalance } from './reports.js';
import { budgetStatus } from './services.js';

export async function dashboard(db: DB, today = todayISO()) {
  const nw = await netWorthStatement(db, today);
  const ms = monthStart(today);
  const thisMonth = await incomeStatement(db, ms, today);
  const lastStart = addMonths(ms, -1);
  const lastMonth = await incomeStatement(db, lastStart, monthEnd(lastStart));
  const ytd = await incomeStatement(db, `${today.slice(0, 4)}-01-01`, today);
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const s = addMonths(ms, -i);
    const is = await incomeStatement(db, s, i === 0 ? today : monthEnd(s));
    monthly.push({ month: s.slice(0, 7), income: is.totalIncome, expenses: is.totalExpenses, net: is.netIncome });
  }
  const bs = await balanceSheet(db, today);
  const tb = await trialBalance(db, today);
  const budget = await budgetStatus(db, today.slice(0, 7));
  const upcoming = (await db
    .prepare('SELECT id, description, next_date, frequency, template FROM recurring_transactions WHERE user_id = ? AND is_active = 1 ORDER BY next_date LIMIT 5')
    .all(USER_ID)) as Array<{ id: number; description: string; next_date: string; frequency: string; template: string }>;
  const topMerchants = (await db
    .prepare(
      `SELECT MIN(e.payee) AS payee, SUM(l.debit) AS total, COUNT(DISTINCT e.id) AS n FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE e.user_id = ? AND a.type = 'expense' AND e.payee IS NOT NULL AND e.date >= ? AND e.reversed_by IS NULL AND e.reversal_of IS NULL
       GROUP BY lower(e.payee) ORDER BY total DESC LIMIT 5`,
    )
    .all(USER_ID, addMonths(ms, -2))) as Array<{ payee: string; total: number; n: number }>;
  const avgExpenses = monthly.slice(0, 11).filter((m) => m.expenses).reduce((s, m, _i, arr) => s + m.expenses / arr.length, 0);
  return {
    asOf: today,
    netWorth: nw.netWorth,
    netWorthMarket: nw.netWorthMarket,
    totalAssets: nw.totalAssets,
    totalLiabilities: nw.totalLiabilities,
    liquidAssets: nw.liquidAssets,
    emergencyFundMonths: avgExpenses ? nw.liquidAssets / avgExpenses : null,
    thisMonth: { income: thisMonth.totalIncome, expenses: thisMonth.totalExpenses, net: thisMonth.netIncome, savingsRate: thisMonth.savingsRate },
    lastMonth: { income: lastMonth.totalIncome, expenses: lastMonth.totalExpenses, net: lastMonth.netIncome, savingsRate: lastMonth.savingsRate },
    ytd: { income: ytd.totalIncome, expenses: ytd.totalExpenses, net: ytd.netIncome, savingsRate: ytd.savingsRate },
    monthly,
    netWorthTrend: (await netWorthTrend(db, 12, today)),
    categoryBreakdown: thisMonth.expenses.map((r) => ({ name: r.name, amount: r.amount })),
    lastMonthBreakdown: lastMonth.expenses.map((r) => ({ name: r.name, amount: r.amount })),
    assetAllocation: nw.assets.map((g) => ({ name: g.label, amount: g.marketTotal })),
    budget: { totalBudget: budget.totalBudget, budgetedActual: budget.budgetedActual, over: budget.rows.filter((r) => r.budget && r.actual > r.budget).map((r) => r.name), elapsedFraction: budget.elapsedFraction },
    recent: (await listEntries(db, { limit: 8 })).entries,
    upcoming: upcoming.map((u) => ({ ...u, template: JSON.parse(u.template) })),
    topMerchants,
    integrity: { trialBalanceBalanced: tb.balanced, accountingEquationHolds: bs.balanced, totalDebits: tb.totalDebit, totalCredits: tb.totalCredit },
  };
}
