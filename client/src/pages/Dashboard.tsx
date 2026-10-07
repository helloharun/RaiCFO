import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, cad, pct, type Entry, typeLabel } from '../api';
import { Empty, Money, PageHeader, Stat, useApi } from '../components/ui';
import { useState } from 'react';

const COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b', '#84cc16'];
const k = (c: number) => `${(c / 100000).toFixed(0)}k`;

interface Dash {
  netWorth: number;
  netWorthMarket: number;
  totalAssets: number;
  totalLiabilities: number;
  liquidAssets: number;
  emergencyFundMonths: number | null;
  thisMonth: { income: number; expenses: number; net: number; savingsRate: number | null };
  lastMonth: { income: number; expenses: number; net: number; savingsRate: number | null };
  ytd: { income: number; expenses: number; net: number; savingsRate: number | null };
  monthly: Array<{ month: string; income: number; expenses: number; net: number }>;
  netWorthTrend: Array<{ month: string; netWorth: number; assets: number; liabilities: number }>;
  categoryBreakdown: Array<{ name: string; amount: number }>;
  assetAllocation: Array<{ name: string; amount: number }>;
  budget: { totalBudget: number; budgetedActual: number; over: string[]; elapsedFraction: number };
  recent: Entry[];
  upcoming: Array<{ id: number; description: string; next_date: string; frequency: string }>;
  topMerchants: Array<{ payee: string; total: number; n: number }>;
  integrity: { trialBalanceBalanced: boolean; accountingEquationHolds: boolean; totalDebits: number };
}

export default function Dashboard() {
  const { data: d, reload } = useApi<Dash>('/dashboard');
  const [seeding, setSeeding] = useState(false);
  if (!d) return <PageHeader title="Dashboard" subtitle="Loading…" />;
  const empty = d.integrity.totalDebits === 0;
  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`All figures derive from the general ledger · CAD`}
        actions={
          <>
            <span className={`badge ${d.integrity.trialBalanceBalanced && d.integrity.accountingEquationHolds ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
              {d.integrity.trialBalanceBalanced && d.integrity.accountingEquationHolds ? <CheckCircle2 size={13} className="mr-1" /> : <AlertTriangle size={13} className="mr-1" />}
              Books balanced: Assets = Liabilities + Equity
            </span>
            <Link to="/record" className="btn-primary">
              + Record transaction
            </Link>
          </>
        }
      />
      {empty && (
        <div className="card mb-6 flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <div className="font-semibold">Your ledger is empty</div>
            <div className="text-sm text-slate-500">Start by recording opening balances for your accounts (e.g. “Opening balance of $4,500 in TD Chequing”), or load sample data to explore.</div>
          </div>
          <button
            className="btn-secondary"
            disabled={seeding}
            onClick={async () => {
              setSeeding(true);
              await api('/demo/seed', { body: {} });
              setSeeding(false);
              reload();
            }}
          >
            Load demo data
          </button>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Net worth" value={cad(d.netWorth)} sub={`Market value ${cad(d.netWorthMarket)}`} />
        <Stat label="Cash & bank" value={cad(d.liquidAssets)} sub={d.emergencyFundMonths !== null ? `${d.emergencyFundMonths.toFixed(1)} months of expenses` : undefined} />
        <Stat label="This month net" value={cad(d.thisMonth.net)} tone={d.thisMonth.net >= 0 ? 'good' : 'bad'} sub={`Income ${cad(d.thisMonth.income)} · Spent ${cad(d.thisMonth.expenses)}`} />
        <Stat label="Savings rate (YTD)" value={pct(d.ytd.savingsRate)} sub={`Last month ${pct(d.lastMonth.savingsRate)}`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-3 font-semibold">Income vs. expenses (12 months)</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={d.monthly}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" fontSize={11} />
                <YAxis tickFormatter={k} fontSize={11} />
                <Tooltip formatter={(v) => cad(Number(v))} />
                <Legend />
                <Bar dataKey="income" name="Income" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="#f43f5e" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card p-5">
          <h2 className="mb-3 font-semibold">Spending this month</h2>
          {d.categoryBreakdown.length ? (
            <div className="h-64">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={d.categoryBreakdown} dataKey="amount" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                    {d.categoryBreakdown.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => cad(Number(v))} />
                  <Legend layout="vertical" align="right" verticalAlign="middle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty>No spending yet this month.</Empty>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-3 font-semibold">Net worth trend</h2>
          <div className="h-56">
            <ResponsiveContainer>
              <AreaChart data={d.netWorthTrend}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" fontSize={11} />
                <YAxis tickFormatter={k} fontSize={11} />
                <Tooltip formatter={(v) => cad(Number(v))} />
                <Area type="monotone" dataKey="netWorth" name="Net worth" stroke="#4f46e5" fill="#c7d2fe" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card p-5">
          <h2 className="mb-3 font-semibold">Budget this month</h2>
          {d.budget.totalBudget ? (
            <>
              <div className="flex justify-between text-sm">
                <span>
                  <Money cents={d.budget.budgetedActual} /> of <Money cents={d.budget.totalBudget} />
                </span>
                <span className="text-slate-500">{pct(d.budget.budgetedActual / d.budget.totalBudget)}</span>
              </div>
              <div className="relative mt-2 h-2.5 rounded-full bg-slate-100">
                <div className={`h-2.5 rounded-full ${d.budget.budgetedActual > d.budget.totalBudget ? 'bg-rose-500' : 'bg-indigo-500'}`} style={{ width: `${Math.min(100, (d.budget.budgetedActual / d.budget.totalBudget) * 100)}%` }} />
                <div className="absolute top-[-3px] h-4 w-0.5 bg-slate-500" style={{ left: `${d.budget.elapsedFraction * 100}%` }} title="Month elapsed" />
              </div>
              {d.budget.over.length > 0 && <p className="mt-2 text-sm text-rose-600">Over budget: {d.budget.over.join(', ')}</p>}
            </>
          ) : (
            <Empty>
              No budgets yet. <Link to="/budgets" className="text-indigo-600 underline">Set budgets</Link>
            </Empty>
          )}
          <h3 className="mb-2 mt-5 text-sm font-semibold">Upcoming recurring</h3>
          {d.upcoming.length ? (
            <ul className="space-y-1 text-sm">
              {d.upcoming.map((u) => (
                <li key={u.id} className="flex justify-between">
                  <span>{u.description}</span>
                  <span className="text-slate-500">{u.next_date}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">None scheduled.</p>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between px-5 pt-4">
            <h2 className="font-semibold">Recent activity</h2>
            <Link to="/journal" className="text-sm text-indigo-600">
              View all
            </Link>
          </div>
          <table className="table mt-2">
            <tbody>
              {d.recent.map((e) => {
                const total = e.lines.reduce((s, l) => s + l.debit, 0);
                return (
                  <tr key={e.id}>
                    <td className="w-24 text-slate-500">{e.date}</td>
                    <td>
                      <div className="font-medium">{e.description}</div>
                      <div className="text-xs text-slate-500">{e.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account_name}`).join(' · ')}</div>
                    </td>
                    <td>
                      <span className="badge bg-slate-100 text-slate-700">{typeLabel(e.transaction_type)}</span>
                    </td>
                    <td className="num">
                      <Money cents={total} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!d.recent.length && <Empty>No transactions yet.</Empty>}
        </div>
        <div className="card p-5">
          <h2 className="mb-3 font-semibold">Asset allocation</h2>
          <ul className="space-y-2 text-sm">
            {d.assetAllocation.map((a, i) => (
              <li key={a.name} className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} /> {a.name}
                </span>
                <Money cents={a.amount} />
              </li>
            ))}
            <li className="flex justify-between border-t pt-2 font-medium">
              <span>Liabilities</span>
              <Money cents={-d.totalLiabilities} />
            </li>
          </ul>
          <h3 className="mb-2 mt-5 text-sm font-semibold">Top merchants (3 months)</h3>
          <ul className="space-y-1 text-sm">
            {d.topMerchants.map((m) => (
              <li key={m.payee} className="flex justify-between">
                <Link to={`/insights?q=${encodeURIComponent(m.payee)}`} className="hover:text-indigo-700 hover:underline">
                  {m.payee} <span className="text-xs text-slate-400">×{m.n}</span>
                </Link>
                <Money cents={m.total} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
