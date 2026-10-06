import type { DB } from '../db.js';
import { addDays, addMonths, monthEnd, monthStart, todayISO } from '../money.js';
import { type Account, CASH_SUBTYPES, INVESTMENT_SUBTYPES, isDebitNormal } from '../types.js';
import { USER_ID, accountBalances, listAccounts } from './ledger.js';
import { marketAdjustments } from './investments.js';

export interface ReportRow {
  accountId: number;
  code: string;
  name: string;
  subtype: string;
  amount: number;
}

const SUBTYPE_LABELS: Record<string, string> = {
  cash: 'Cash', bank: 'Bank Accounts', savings: 'Savings', investment: 'Investments', tfsa: 'TFSA', rrsp: 'RRSP',
  other_investment: 'Other Investments', vehicle: 'Vehicles', property: 'Property', personal_asset: 'Personal Assets',
  accounts_receivable: 'Receivables', other_asset: 'Other Assets', credit_card: 'Credit Cards', line_of_credit: 'Lines of Credit',
  personal_loan: 'Personal Loans', auto_loan: 'Auto Loans', student_loan: 'Student Loans', mortgage: 'Mortgages',
  accounts_payable: 'Payables', other_liability: 'Other Liabilities',
};

export const subtypeLabel = (s: string) => SUBTYPE_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function rowsFor(accounts: Account[], bal: Map<number, { balance: number }>, type: Account['type'], includeZero = false): ReportRow[] {
  return accounts
    .filter((a) => a.type === type)
    .map((a) => ({ accountId: a.id, code: a.code, name: a.name, subtype: a.subtype, amount: bal.get(a.id)?.balance ?? 0 }))
    .filter((r) => includeZero || r.amount !== 0);
}

const sum = (rows: Array<{ amount: number }>) => rows.reduce((s, r) => s + r.amount, 0);

function groupBySubtype(rows: ReportRow[]) {
  const groups = new Map<string, ReportRow[]>();
  for (const r of rows) {
    if (!groups.has(r.subtype)) groups.set(r.subtype, []);
    groups.get(r.subtype)!.push(r);
  }
  return [...groups.entries()].map(([subtype, rs]) => ({ subtype, label: subtypeLabel(subtype), rows: rs, total: sum(rs) }));
}

export async function netIncome(db: DB, from: string | undefined, to: string): Promise<number> {
  const bal = await accountBalances(db, { from, to });
  const accts = await listAccounts(db);
  return sum(rowsFor(accts, bal, 'income')) - sum(rowsFor(accts, bal, 'expense'));
}

export async function trialBalance(db: DB, asOf = todayISO()) {
  const bal = await accountBalances(db, { to: asOf });
  const rows = (await listAccounts(db))
    .map((a) => {
      const b = bal.get(a.id);
      const net = b ? b.debit - b.credit : 0;
      return { accountId: a.id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
    .filter((r) => r.debit || r.credit);
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { asOf, rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export async function incomeStatement(db: DB, from: string, to: string) {
  const bal = await accountBalances(db, { from, to });
  const accts = await listAccounts(db);
  const income = rowsFor(accts, bal, 'income').sort((a, b) => b.amount - a.amount);
  const expenses = rowsFor(accts, bal, 'expense').sort((a, b) => b.amount - a.amount);
  const totalIncome = sum(income);
  const totalExpenses = sum(expenses);
  const net = totalIncome - totalExpenses;
  return { from, to, income, expenses, totalIncome, totalExpenses, netIncome: net, savingsRate: totalIncome > 0 ? net / totalIncome : null };
}

export function fiscalYearStart(asOf: string): string {
  return `${asOf.slice(0, 4)}-01-01`;
}

export async function balanceSheet(db: DB, asOf = todayISO()) {
  const bal = await accountBalances(db, { to: asOf });
  const accts = await listAccounts(db);
  const assets = rowsFor(accts, bal, 'asset');
  const liabilities = rowsFor(accts, bal, 'liability');
  const equityAccts = rowsFor(accts, bal, 'equity');
  const fy = fiscalYearStart(asOf);
  const priorEarnings = await netIncome(db, undefined, addDays(fy, -1));
  const currentEarnings = await netIncome(db, fy, asOf);
  const equity = [
    ...equityAccts,
    { accountId: -1, code: '', name: 'Accumulated Earnings (prior years)', subtype: 'accumulated_equity', amount: priorEarnings },
    { accountId: -2, code: '', name: 'Current-Period Earnings (YTD)', subtype: 'current_earnings', amount: currentEarnings },
  ].filter((r) => r.amount !== 0 || r.accountId < 0);
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity);
  return {
    asOf,
    assets: groupBySubtype(assets),
    liabilities: groupBySubtype(liabilities),
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

type CFSection = 'operating' | 'investing' | 'financing';

function cashFlowSection(a: Account): CFSection {
  if (a.type === 'income' || a.type === 'expense') return 'operating';
  if (a.type === 'equity') return 'financing';
  if (a.type === 'asset') return a.subtype === 'accounts_receivable' ? 'operating' : 'investing';
  return a.subtype === 'credit_card' || a.subtype === 'accounts_payable' ? 'operating' : 'financing';
}

export function isCashAccount(a: Account): boolean {
  return a.type === 'asset' && CASH_SUBTYPES.includes(a.subtype);
}

export async function cashFlowStatement(db: DB, from: string, to: string) {
  const accts = await listAccounts(db);
  const byId = new Map(accts.map((a) => [a.id, a]));
  const rows = (await db
    .prepare(
      `SELECT l.entry_id, l.account_id, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.user_id = ? AND e.date >= ? AND e.date <= ? ORDER BY l.entry_id`,
    )
    .all(USER_ID, from, to)) as Array<{ entry_id: number; account_id: number; debit: number; credit: number }>;
  const entries = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!entries.has(r.entry_id)) entries.set(r.entry_id, []);
    entries.get(r.entry_id)!.push(r);
  }
  const items: Record<CFSection, Map<string, number>> = { operating: new Map(), investing: new Map(), financing: new Map() };
  for (const lines of entries.values()) {
    const cashLines = lines.filter((l) => isCashAccount(byId.get(l.account_id)!));
    if (!cashLines.length || cashLines.length === lines.length) continue;
    for (const l of lines) {
      const a = byId.get(l.account_id)!;
      if (isCashAccount(a)) continue;
      const section = cashFlowSection(a);
      const label = a.subtype === 'credit_card' ? `Credit card payments / advances — ${a.name}` : a.name;
      items[section].set(label, (items[section].get(label) ?? 0) + (l.credit - l.debit));
    }
  }
  const toRows = (m: Map<string, number>) =>
    [...m.entries()].filter(([, v]) => v !== 0).map(([name, amount]) => ({ name, amount })).sort((a, b) => a.amount - b.amount);
  const sections = (['operating', 'investing', 'financing'] as CFSection[]).map((s) => {
    const r = toRows(items[s]);
    return { section: s, rows: r, total: sum(r) };
  });
  const cashIds = accts.filter(isCashAccount).map((a) => a.id);
  const cashAt = async (d: string) => {
    const b = await accountBalances(db, { to: d });
    return cashIds.reduce((s, id) => s + (b.get(id)?.balance ?? 0), 0);
  };
  const beginningCash = await cashAt(addDays(from, -1));
  const endingCash = await cashAt(to);
  const netChange = sections.reduce((s, x) => s + x.total, 0);
  return { from, to, sections, netChange, beginningCash, endingCash, reconciles: beginningCash + netChange === endingCash };
}

async function equityTotal(db: DB, asOf: string): Promise<number> {
  const bal = await accountBalances(db, { to: asOf });
  const accts = await listAccounts(db);
  return sum(rowsFor(accts, bal, 'asset')) - sum(rowsFor(accts, bal, 'liability'));
}

export async function equityStatement(db: DB, from: string, to: string) {
  const bal = await accountBalances(db, { from, to });
  const accts = await listAccounts(db);
  const change = (subtypes: string[]) =>
    accts.filter((a) => a.type === 'equity' && subtypes.includes(a.subtype)).reduce((s, a) => s + (bal.get(a.id)?.balance ?? 0), 0);
  const opening = await equityTotal(db, addDays(from, -1));
  const ni = await netIncome(db, from, to);
  const contributions = change(['owner_contribution']);
  const withdrawals = change(['owner_withdrawal']);
  const openingBalances = change(['opening_balance_equity']);
  const other = change(['accumulated_equity', 'current_earnings']);
  const closing = await equityTotal(db, to);
  const rows = [
    { name: 'Opening balances recorded', amount: openingBalances },
    { name: 'Net income for the period', amount: ni },
    { name: 'Owner contributions', amount: contributions },
    { name: 'Owner withdrawals', amount: withdrawals },
    { name: 'Other equity adjustments', amount: other },
  ];
  return { from, to, opening, rows, closing, reconciles: opening + sum(rows) === closing };
}

export async function netWorthStatement(db: DB, asOf = todayISO()) {
  const bal = await accountBalances(db, { to: asOf });
  const accts = await listAccounts(db);
  const adj = await marketAdjustments(db, asOf);
  const assets = rowsFor(accts, bal, 'asset').map((r) => ({
    ...r,
    marketValue: r.amount + (INVESTMENT_SUBTYPES.includes(r.subtype) ? adj.get(r.accountId) ?? 0 : 0),
  }));
  const liabilities = rowsFor(accts, bal, 'liability');
  const totalAssets = sum(assets);
  const totalAssetsMarket = assets.reduce((s, r) => s + r.marketValue, 0);
  const totalLiabilities = sum(liabilities);
  const groups = (rows: typeof assets) => {
    const g = new Map<string, typeof assets>();
    rows.forEach((r) => (g.has(r.subtype) ? g.get(r.subtype)!.push(r) : g.set(r.subtype, [r])));
    return [...g.entries()].map(([subtype, rs]) => ({
      subtype,
      label: subtypeLabel(subtype),
      rows: rs,
      total: sum(rs),
      marketTotal: rs.reduce((s, r) => s + r.marketValue, 0),
    }));
  };
  return {
    asOf,
    assets: groups(assets),
    liabilities: groupBySubtype(liabilities),
    totalAssets,
    totalAssetsMarket,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    netWorthMarket: totalAssetsMarket - totalLiabilities,
    liquidAssets: assets.filter((r) => CASH_SUBTYPES.includes(r.subtype)).reduce((s, r) => s + r.amount, 0),
  };
}

export async function netWorthTrend(db: DB, months = 12, asOf = todayISO()) {
  const out: Array<{ month: string; assets: number; liabilities: number; netWorth: number }> = [];
  const accts = await listAccounts(db);
  for (let i = months - 1; i >= 0; i--) {
    const end = i === 0 ? asOf : monthEnd(addMonths(monthStart(asOf), -i));
    const bal = await accountBalances(db, { to: end });
    const a = sum(rowsFor(accts, bal, 'asset'));
    const l = sum(rowsFor(accts, bal, 'liability'));
    out.push({ month: end.slice(0, 7), assets: a, liabilities: l, netWorth: a - l });
  }
  return out;
}

export async function generalLedger(db: DB, from: string, to: string, accountId?: number) {
  const accts = (await listAccounts(db)).filter((a) => !accountId || a.id === accountId);
  const opening = await accountBalances(db, { to: addDays(from, -1) });
  const lines = (await db
    .prepare(
      `SELECT l.account_id, l.debit, l.credit, l.memo, e.id AS entry_id, e.date, e.description, e.payee
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.user_id = ? AND e.date >= ? AND e.date <= ? ${accountId ? 'AND l.account_id = ?' : ''}
       ORDER BY e.date, e.id, l.id`,
    )
    .all(USER_ID, from, to, ...(accountId ? [accountId] : []))) as Array<{
    account_id: number;
    debit: number;
    credit: number;
    memo: string | null;
    entry_id: number;
    date: string;
    description: string;
    payee: string | null;
  }>;
  const result = accts.map((a) => {
    const sign = isDebitNormal(a.type) ? 1 : -1;
    const open = opening.get(a.id)?.balance ?? 0;
    let running = open;
    const rows = lines
      .filter((l) => l.account_id === a.id)
      .map((l) => {
        running += sign * (l.debit - l.credit);
        return { ...l, balance: running };
      });
    return { accountId: a.id, code: a.code, name: a.name, type: a.type, openingBalance: open, rows, closingBalance: running };
  });
  return { from, to, accounts: result.filter((r) => r.rows.length || r.openingBalance !== 0) };
}
