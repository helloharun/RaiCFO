import { Fragment, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Printer } from 'lucide-react';
import { cad, pct, today, yearStart } from '../api';
import { AccountSelect, DateRange, Money, PageHeader, Tabs, useAccounts, useApi } from '../components/ui';

type Tab = 'bs' | 'is' | 'cf' | 'eq' | 'nw' | 'tb' | 'gl';
const TABS: Array<[Tab, string]> = [
  ['bs', 'Balance Sheet'], ['is', 'Income Statement'], ['cf', 'Cash Flow'], ['eq', 'Changes in Equity'], ['nw', 'Net Worth'], ['tb', 'Trial Balance'], ['gl', 'General Ledger'],
];
const POINT_IN_TIME: Tab[] = ['bs', 'nw', 'tb'];

export default function Reports() {
  const [tab, setTab] = useState<Tab>('bs');
  const [asOf, setAsOf] = useState(today());
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [accountId, setAccountId] = useState<number | null>(null);
  const { accounts } = useAccounts();
  const pit = POINT_IN_TIME.includes(tab);
  return (
    <div>
      <PageHeader
        title="Financial statements"
        subtitle="Generated from the general ledger. Choose any historical date to see the books “as of” that day."
        actions={
          <>
            {pit ? (
              <label className="flex items-center gap-2 text-sm">
                As of <input type="date" className="input w-44" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
              </label>
            ) : (
              <DateRange from={from} to={to} onChange={(r) => (setFrom(r.from), setTo(r.to))} />
            )}
            {tab === 'gl' && (
              <div className="w-full sm:w-56">
                <AccountSelect accounts={accounts} value={accountId} allowEmpty placeholder="All accounts" onChange={setAccountId} />
              </div>
            )}
            <button className="btn-secondary" onClick={() => window.print()}>
              <Printer size={15} /> Print
            </button>
          </>
        }
      />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="card overflow-x-auto p-4 md:p-6">
        {tab === 'bs' && <BalanceSheet asOf={asOf} />}
        {tab === 'is' && <IncomeStatement from={from} to={to} />}
        {tab === 'cf' && <CashFlow from={from} to={to} />}
        {tab === 'eq' && <Equity from={from} to={to} />}
        {tab === 'nw' && <NetWorth asOf={asOf} />}
        {tab === 'tb' && <TrialBalance asOf={asOf} />}
        {tab === 'gl' && <GeneralLedger from={from} to={to} accountId={accountId} />}
      </div>
    </div>
  );
}

const Title = ({ name, period }: { name: string; period: string }) => (
  <div className="mb-5 text-center">
    <div className="text-xs uppercase tracking-widest text-slate-500">Personal Finance HQ</div>
    <h2 className="text-xl font-semibold">{name}</h2>
    <div className="text-sm text-slate-500">{period} · CAD</div>
  </div>
);

const Row = ({ label, cents, bold, indent, border }: { label: ReactNode; cents: number; bold?: boolean; indent?: number; border?: boolean }) => (
  <div className={`flex justify-between py-1 text-sm ${bold ? 'font-semibold' : ''} ${border ? 'mt-1 border-t border-slate-300 pt-2' : ''}`} style={{ paddingLeft: (indent ?? 0) * 16 }}>
    <span>{label}</span>
    <Money cents={cents} />
  </div>
);

const Check = ({ ok, label }: { ok: boolean; label: string }) => (
  <div className={`mt-5 flex items-center gap-1.5 text-sm ${ok ? 'text-emerald-700' : 'text-rose-700'}`}>
    {ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {label}
  </div>
);

interface Group { subtype: string; label: string; rows: Array<{ accountId: number; name: string; amount: number; marketValue?: number }>; total: number; marketTotal?: number }

function Groups({ groups }: { groups: Group[] }) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.subtype} className="mb-1">
          <div className="pl-4 pt-1 text-sm font-medium text-slate-600">{g.label}</div>
          {g.rows.map((r) => (
            <Row key={r.accountId} label={r.name} cents={r.amount} indent={2} />
          ))}
        </div>
      ))}
    </>
  );
}

function BalanceSheet({ asOf }: { asOf: string }) {
  const { data } = useApi<any>(`/reports/balance-sheet?asOf=${asOf}`, [asOf]);
  if (!data) return null;
  return (
    <div className="mx-auto max-w-2xl">
      <Title name="Balance Sheet" period={`As of ${asOf}`} />
      <h3 className="font-semibold">Assets</h3>
      <Groups groups={data.assets} />
      <Row label="Total Assets" cents={data.totalAssets} bold border />
      <h3 className="mt-5 font-semibold">Liabilities</h3>
      <Groups groups={data.liabilities} />
      <Row label="Total Liabilities" cents={data.totalLiabilities} bold border />
      <h3 className="mt-5 font-semibold">Equity</h3>
      {data.equity.map((r: any) => (
        <Row key={r.accountId} label={r.name} cents={r.amount} indent={1} />
      ))}
      <Row label="Total Equity" cents={data.totalEquity} bold border />
      <Row label="Total Liabilities + Equity" cents={data.totalLiabilities + data.totalEquity} bold border />
      <Check ok={data.balanced} label={data.balanced ? 'Assets = Liabilities + Equity' : 'Balance sheet does not balance!'} />
    </div>
  );
}

function IncomeStatement({ from, to }: { from: string; to: string }) {
  const { data } = useApi<any>(`/reports/income-statement?from=${from}&to=${to}`, [from, to]);
  if (!data) return null;
  return (
    <div className="mx-auto max-w-2xl">
      <Title name="Income Statement" period={`${from} to ${to}`} />
      <h3 className="font-semibold">Income</h3>
      {data.income.map((r: any) => (
        <Row key={r.accountId} label={r.name} cents={r.amount} indent={1} />
      ))}
      <Row label="Total Income" cents={data.totalIncome} bold border />
      <h3 className="mt-5 font-semibold">Expenses</h3>
      {data.expenses.map((r: any) => (
        <Row key={r.accountId} label={r.name} cents={r.amount} indent={1} />
      ))}
      <Row label="Total Expenses" cents={data.totalExpenses} bold border />
      <Row label="Net Income (Savings)" cents={data.netIncome} bold border />
      <div className="mt-2 text-sm text-slate-500">Savings rate: {pct(data.savingsRate)}</div>
    </div>
  );
}

function CashFlow({ from, to }: { from: string; to: string }) {
  const { data } = useApi<any>(`/reports/cash-flow?from=${from}&to=${to}`, [from, to]);
  if (!data) return null;
  const names: Record<string, string> = { operating: 'Operating activities', investing: 'Investing activities', financing: 'Financing activities' };
  return (
    <div className="mx-auto max-w-2xl">
      <Title name="Cash Flow Statement" period={`${from} to ${to}`} />
      <p className="mb-4 text-xs text-slate-500">Direct method. Cash = cash, bank and savings accounts. Transfers between cash accounts are excluded; credit-card payments are operating.</p>
      {data.sections.map((s: any) => (
        <div key={s.section} className="mb-4">
          <h3 className="font-semibold">{names[s.section]}</h3>
          {s.rows.map((r: any) => (
            <Row key={r.name} label={r.name} cents={r.amount} indent={1} />
          ))}
          <Row label={`Net cash from ${names[s.section].toLowerCase()}`} cents={s.total} bold border />
        </div>
      ))}
      <Row label="Net change in cash" cents={data.netChange} bold />
      <Row label="Cash at beginning of period" cents={data.beginningCash} />
      <Row label="Cash at end of period" cents={data.endingCash} bold border />
      <Check ok={data.reconciles} label={data.reconciles ? 'Reconciles to ledger cash balances' : 'Does not reconcile'} />
    </div>
  );
}

function Equity({ from, to }: { from: string; to: string }) {
  const { data } = useApi<any>(`/reports/equity?from=${from}&to=${to}`, [from, to]);
  if (!data) return null;
  return (
    <div className="mx-auto max-w-2xl">
      <Title name="Statement of Changes in Equity" period={`${from} to ${to}`} />
      <Row label="Equity at beginning of period" cents={data.opening} bold />
      {data.rows.map((r: any) => (
        <Row key={r.name} label={r.name} cents={r.amount} indent={1} />
      ))}
      <Row label="Equity at end of period" cents={data.closing} bold border />
      <Check ok={data.reconciles} label={data.reconciles ? 'Reconciles to the balance sheet' : 'Does not reconcile'} />
    </div>
  );
}

function NetWorth({ asOf }: { asOf: string }) {
  const { data } = useApi<any>(`/reports/net-worth?asOf=${asOf}`, [asOf]);
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl">
      <Title name="Net Worth Statement" period={`As of ${asOf}`} />
      <table className="table">
        <thead>
          <tr>
            <th>Assets</th>
            <th className="num">Book value</th>
            <th className="num">Market value</th>
          </tr>
        </thead>
        <tbody>
          {data.assets.map((g: Group) => (
            <Fragment key={g.subtype}>
              <tr>
                <td className="font-medium text-slate-600">{g.label}</td>
                <td />
                <td />
              </tr>
              {g.rows.map((r) => (
                <tr key={r.accountId}>
                  <td className="pl-8">{r.name}</td>
                  <td className="num">{cad(r.amount)}</td>
                  <td className="num">{cad(r.marketValue)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          <tr className="font-semibold">
            <td>Total assets</td>
            <td className="num">{cad(data.totalAssets)}</td>
            <td className="num">{cad(data.totalAssetsMarket)}</td>
          </tr>
          <tr>
            <td className="pt-4 font-semibold" colSpan={3}>
              Liabilities
            </td>
          </tr>
          {data.liabilities.flatMap((g: Group) =>
            g.rows.map((r) => (
              <tr key={r.accountId}>
                <td className="pl-8">{r.name}</td>
                <td className="num">{cad(r.amount)}</td>
                <td className="num">{cad(r.amount)}</td>
              </tr>
            )),
          )}
          <tr className="font-semibold">
            <td>Total liabilities</td>
            <td className="num">{cad(data.totalLiabilities)}</td>
            <td className="num">{cad(data.totalLiabilities)}</td>
          </tr>
          <tr className="text-base font-bold">
            <td>Net worth</td>
            <td className="num">{cad(data.netWorth)}</td>
            <td className="num">{cad(data.netWorthMarket)}</td>
          </tr>
        </tbody>
      </table>
      <h3 className="mt-6 font-semibold">12-month trend (book value)</h3>
      <table className="table">
        <tbody>
          {data.trend.map((t: any) => (
            <tr key={t.month}>
              <td>{t.month}</td>
              <td className="num">{cad(t.assets)}</td>
              <td className="num">{cad(-t.liabilities)}</td>
              <td className="num font-medium">{cad(t.netWorth)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrialBalance({ asOf }: { asOf: string }) {
  const { data } = useApi<any>(`/reports/trial-balance?asOf=${asOf}`, [asOf]);
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl">
      <Title name="Trial Balance" period={`As of ${asOf}`} />
      <table className="table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r: any) => (
            <tr key={r.accountId}>
              <td className="text-slate-400">{r.code}</td>
              <td>{r.name}</td>
              <td className="num">{r.debit ? cad(r.debit) : ''}</td>
              <td className="num">{r.credit ? cad(r.credit) : ''}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td />
            <td>Totals</td>
            <td className="num">{cad(data.totalDebit)}</td>
            <td className="num">{cad(data.totalCredit)}</td>
          </tr>
        </tbody>
      </table>
      <Check ok={data.balanced} label={data.balanced ? 'Total debits = total credits' : 'Trial balance is out of balance!'} />
    </div>
  );
}

function GeneralLedger({ from, to, accountId }: { from: string; to: string; accountId: number | null }) {
  const { data } = useApi<any>(`/reports/general-ledger?from=${from}&to=${to}${accountId ? `&accountId=${accountId}` : ''}`, [from, to, accountId]);
  if (!data) return null;
  return (
    <div>
      <Title name="General Ledger" period={`${from} to ${to}`} />
      {data.accounts.map((a: any) => (
        <div key={a.accountId} className="mb-6">
          <h3 className="font-semibold">
            {a.code} · {a.name}
          </h3>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>#</th>
                <th>Description</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="text-slate-500">
                <td colSpan={5}>Opening balance</td>
                <td className="num">{cad(a.openingBalance)}</td>
              </tr>
              {a.rows.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="whitespace-nowrap">{r.date}</td>
                  <td className="text-slate-400">{r.entry_id}</td>
                  <td>{r.description}</td>
                  <td className="num">{r.debit ? cad(r.debit) : ''}</td>
                  <td className="num">{r.credit ? cad(r.credit) : ''}</td>
                  <td className="num">{cad(r.balance)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={5}>Closing balance</td>
                <td className="num">{cad(a.closingBalance)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
