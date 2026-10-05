import { useState } from 'react';
import { Copy } from 'lucide-react';
import { api, cad, pct, today } from '../api';
import { ErrorBox, Money, PageHeader, Stat, useApi } from '../components/ui';

interface BudgetRow { accountId: number; code: string; name: string; budget: number; isDefault: boolean; actual: number; remaining: number; pct: number | null; projected: number }

const shift = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function Budgets() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data, reload } = useApi<{ rows: BudgetRow[]; totalBudget: number; totalActual: number; budgetedActual: number; elapsedFraction: number }>(`/budgets?month=${month}`, [month]);
  const [error, setError] = useState<string | null>(null);
  const save = async (accountId: number, value: string, scope: 'month' | 'default') => {
    try {
      await api('/budgets', { method: 'PUT', body: { accountId, month: scope === 'default' ? '*' : month, amount: Number(value || 0) } });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader
        title="Budgets"
        subtitle="Set a default monthly budget per category, or override a specific month. Actuals come from posted expenses."
        actions={
          <>
            <button className="btn-secondary" onClick={() => setMonth(shift(month, -1))}>‹</button>
            <input type="month" className="input w-40" value={month} onChange={(e) => setMonth(e.target.value)} />
            <button className="btn-secondary" onClick={() => setMonth(shift(month, 1))}>›</button>
            <button className="btn-secondary" onClick={async () => { await api('/budgets/copy', { body: { fromMonth: shift(month, -1), toMonth: month } }); reload(); }}>
              <Copy size={15} /> Copy last month
            </button>
          </>
        }
      />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {data && (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Stat label="Budgeted" value={cad(data.totalBudget)} />
            <Stat label="Spent (budgeted categories)" value={cad(data.budgetedActual)} sub={`${pct(data.totalBudget ? data.budgetedActual / data.totalBudget : null)} used · ${pct(data.elapsedFraction)} of month elapsed`} tone={data.budgetedActual > data.totalBudget ? 'bad' : undefined} />
            <Stat label="Total spending" value={cad(data.totalActual)} />
          </div>
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Default / month</th>
                  <th className="num">This month</th>
                  <th className="num">Actual</th>
                  <th className="w-1/4">Progress</th>
                  <th className="num">Remaining</th>
                  <th className="num">Projected</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const p = r.budget ? Math.min(100, (r.actual / r.budget) * 100) : 0;
                  const over = r.budget > 0 && r.actual > r.budget;
                  return (
                    <tr key={r.accountId}>
                      <td>{r.name}</td>
                      <td className="num">
                        <input className="input w-24 text-right" type="number" defaultValue={r.isDefault ? r.budget / 100 : ''} key={`d${r.accountId}${r.budget}${month}`} placeholder="—" onBlur={(e) => e.target.value !== (r.isDefault ? String(r.budget / 100) : '') && save(r.accountId, e.target.value, 'default')} />
                      </td>
                      <td className="num">
                        <input className="input w-24 text-right" type="number" defaultValue={!r.isDefault && r.budget ? r.budget / 100 : ''} key={`m${r.accountId}${r.budget}${month}`} placeholder={r.isDefault ? String(r.budget / 100) : '—'} onBlur={(e) => e.target.value !== (!r.isDefault && r.budget ? String(r.budget / 100) : '') && save(r.accountId, e.target.value, 'month')} />
                      </td>
                      <td className="num"><Money cents={r.actual} /></td>
                      <td>
                        {r.budget > 0 && (
                          <div className="h-2 rounded-full bg-slate-100">
                            <div className={`h-2 rounded-full ${over ? 'bg-rose-500' : p > 80 ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${p}%` }} />
                          </div>
                        )}
                      </td>
                      <td className={`num ${over ? 'text-rose-600' : ''}`}>{r.budget ? cad(r.remaining) : ''}</td>
                      <td className={`num ${r.budget && r.projected > r.budget ? 'text-amber-600' : 'text-slate-500'}`}>{r.budget ? cad(r.projected) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
