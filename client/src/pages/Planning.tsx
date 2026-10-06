import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, cad } from '../api';
import { ErrorBox, Empty, Money, Notice, PageHeader, Stat, Tabs, useApi } from '../components/ui';

interface Forecast {
  from: string;
  to: string;
  startBalance: number;
  endBalance: number;
  lowest: { date: string; balance: number };
  goesNegative: boolean;
  totalBills: number;
  totalIncome: number;
  events: Array<{ date: string; recurringId: number; description: string; frequency: string; amount: number; cashEffect: number; kind: string; accounts: string[] }>;
  series: Array<{ date: string; balance: number }>;
}
interface Debt { accountId: number; name: string; balance: number; apr: number; minPayment: number; configured: boolean }
interface PlanResult { strategy: string; months: number | null; totalInterest: number | null; payoffNever: boolean; payoffDate: string | null; debts: Array<{ accountId: number; name: string; paidOffMonth: number | null; payoffDate: string | null; interest: number }>; timeline: Array<{ month: number; totalBalance: number }> }
interface Plan { debts: Debt[]; totalDebt: number; extraMonthly: number; results: PlanResult[] }

const k = (c: number) => `$${Math.round(c / 100).toLocaleString('en-CA')}`;

export default function Planning() {
  const [tab, setTab] = useState<'forecast' | 'debt'>('forecast');
  return (
    <div>
      <PageHeader title="Cash Flow & Debt" subtitle="Project your cash from recurring bills and income, and plan the fastest way out of debt." />
      <Tabs tabs={[['forecast', 'Cash-flow forecast & bills'], ['debt', 'Debt payoff planner']]} value={tab} onChange={setTab} />
      {tab === 'forecast' ? <ForecastView /> : <DebtView />}
    </div>
  );
}

function ForecastView() {
  const [days, setDays] = useState(60);
  const { data, error } = useApi<Forecast>(`/planning/forecast?days=${days}`, [days]);
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <div className="flex items-center gap-2 text-sm">
        Horizon:
        {[30, 60, 90, 180, 365].map((d) => (
          <button key={d} className={d === days ? 'btn-primary px-2 py-1' : 'btn-secondary px-2 py-1'} onClick={() => setDays(d)}>{d} days</button>
        ))}
      </div>
      {data && (
        <>
          {data.goesNegative && <Notice tone="warn"><AlertTriangle size={14} className="mr-1 inline" />Cash is projected to drop below zero ({cad(data.lowest.balance)}) on {data.lowest.date}. Move money or adjust bills before then.</Notice>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Cash today" value={cad(data.startBalance)} sub="Cash, bank and savings accounts" />
            <Stat label={`Projected on ${data.to}`} value={cad(data.endBalance)} tone={data.endBalance >= data.startBalance ? 'good' : 'bad'} />
            <Stat label="Lowest point" value={cad(data.lowest.balance)} sub={data.lowest.date} tone={data.lowest.balance < 0 ? 'bad' : undefined} />
            <Stat label="Bills due" value={cad(data.totalBills)} sub={`Income expected ${cad(data.totalIncome)}`} />
          </div>
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Projected cash balance</h2>
            <div className="h-64">
              <ResponsiveContainer>
                <AreaChart data={data.series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={30} />
                  <YAxis tickFormatter={k} tick={{ fontSize: 11 }} width={70} />
                  <Tooltip formatter={(v) => cad(Number(v))} />
                  <ReferenceLine y={0} stroke="#e11d48" />
                  <Area type="stepAfter" dataKey="balance" stroke="#4f46e5" fill="#e0e7ff" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs text-slate-500">Based on active recurring transactions only. Add bills, paycheques and subscriptions under Recurring to improve the forecast.</p>
          </div>
          <div className="card overflow-hidden">
            <h2 className="border-b border-slate-100 px-4 py-3 font-semibold">Upcoming bills & income</h2>
            {data.events.length === 0 ? <Empty>No recurring transactions scheduled in this period.</Empty> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Description</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Accounts</th><th className="px-4 py-2 text-right">Cash effect</th></tr></thead>
                <tbody>
                  {data.events.map((e, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-4 py-2 tabular-nums">{e.date}</td>
                      <td className="px-4 py-2">{e.description} <span className="text-xs text-slate-400">({e.frequency})</span></td>
                      <td className="px-4 py-2 capitalize">{e.kind}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{e.accounts.join(' → ')}</td>
                      <td className="px-4 py-2 text-right"><Money cents={e.cashEffect} colored sign /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DebtView() {
  const [extra, setExtra] = useState('200');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [terms, setTerms] = useState<Record<number, { apr: string; min: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const run = async (t = terms) => {
    try {
      const overrides = Object.fromEntries(Object.entries(t).map(([id, v]) => [id, { apr: v.apr === '' ? undefined : Number(v.apr), minPayment: v.min === '' ? undefined : Number(v.min) }]));
      const p = await api<Plan>('/planning/debt', { body: { extraMonthly: Number(extra || 0), overrides } });
      setPlan(p);
      setError(null);
      setTerms((cur) => Object.keys(cur).length ? cur : Object.fromEntries(p.debts.map((d) => [d.accountId, { apr: String(d.apr), min: String(d.minPayment / 100) }])));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveTerms = async () => {
    try {
      for (const [id, v] of Object.entries(terms)) await api(`/accounts/${id}/debt-terms`, { method: 'PUT', body: { interestRate: v.apr, minPayment: v.min } });
      setSaved('Interest rates and minimum payments saved to the accounts.');
      run();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const names: Record<string, string> = { avalanche: 'Avalanche (highest rate first)', snowball: 'Snowball (smallest balance first)', minimum: 'Minimum payments only' };
  const balanceAt = (r: PlanResult, m: number) => {
    let v: number | undefined;
    for (const p of r.timeline) if (p.month <= m) v = p.totalBalance;
    const last = r.timeline[r.timeline.length - 1];
    return last && m > last.month ? (r.payoffNever ? undefined : 0) : v;
  };
  const chart = plan
    ? [...new Set(plan.results.flatMap((r) => r.timeline.map((p) => p.month)))]
        .sort((x, y) => x - y)
        .map((m) => ({ month: m, avalanche: balanceAt(plan.results[0], m), snowball: balanceAt(plan.results[1], m), minimum: balanceAt(plan.results[2], m) }))
    : [];

  return (
    <div className="space-y-4">
      <ErrorBox error={error} onClose={() => setError(null)} />
      {saved && <Notice tone="success">{saved}</Notice>}
      {plan && plan.debts.length === 0 ? <div className="card"><Empty>No outstanding debts in your ledger. Nice work!</Empty></div> : plan && (
        <>
          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-4 py-3">
              <h2 className="font-semibold">Your debts ({cad(plan.totalDebt)})</h2>
              <div className="flex items-end gap-2">
                <div><label className="label">Extra per month</label><input className="input w-32" type="number" min="0" step="10" value={extra} onChange={(e) => setExtra(e.target.value)} /></div>
                <button className="btn-primary" onClick={() => run()}>Recalculate</button>
                <button className="btn-secondary" onClick={saveTerms}>Save rates</button>
              </div>
            </div>
            <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Account</th><th className="px-4 py-2 text-right">Balance</th><th className="px-4 py-2">APR %</th><th className="px-4 py-2">Min payment</th></tr></thead>
              <tbody>
                {plan.debts.map((d) => (
                  <tr key={d.accountId} className="border-t border-slate-100">
                    <td className="px-4 py-2">{d.name} {!d.configured && <span className="text-xs text-amber-600">(rate not set)</span>}</td>
                    <td className="px-4 py-2 text-right"><Money cents={d.balance} /></td>
                    <td className="px-4 py-2"><input className="input w-24" type="number" min="0" max="100" step="0.01" value={terms[d.accountId]?.apr ?? ''} onChange={(e) => setTerms({ ...terms, [d.accountId]: { ...terms[d.accountId], apr: e.target.value } })} /></td>
                    <td className="px-4 py-2"><input className="input w-28" type="number" min="0" step="1" value={terms[d.accountId]?.min ?? ''} onChange={(e) => setTerms({ ...terms, [d.accountId]: { ...terms[d.accountId], min: e.target.value } })} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {plan.results.map((r) => (
              <div key={r.strategy} className="card p-4">
                <div className="text-sm font-semibold">{names[r.strategy]}</div>
                {r.payoffNever ? <p className="mt-2 text-sm text-rose-600">Payments don’t cover interest; this debt never gets paid off.</p> : (
                  <>
                    <div className="mt-2 text-2xl font-semibold">{r.months} months</div>
                    <div className="text-xs text-slate-500">Debt-free by {r.payoffDate}</div>
                    <div className="mt-2 text-sm">Total interest: <b>{cad(r.totalInterest)}</b></div>
                    <ul className="mt-2 space-y-0.5 text-xs text-slate-600">{r.debts.map((d) => <li key={d.accountId}>{d.name}: {d.payoffDate ?? '—'}</li>)}</ul>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Total debt over time</h2>
            <div className="h-64">
              <ResponsiveContainer>
                <LineChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} label={{ value: 'months', position: 'insideBottomRight', offset: -4, fontSize: 11 }} />
                  <YAxis tickFormatter={k} tick={{ fontSize: 11 }} width={70} />
                  <Tooltip formatter={(v) => cad(Number(v))} />
                  <Line dataKey="avalanche" stroke="#4f46e5" dot={false} />
                  <Line dataKey="snowball" stroke="#059669" dot={false} />
                  <Line dataKey="minimum" stroke="#e11d48" dot={false} strokeDasharray="4 4" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
