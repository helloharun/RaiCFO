import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api, cad, today } from '../api';
import { AccountSelect, Empty, ErrorBox, Money, PageHeader, useAccounts, useApi } from '../components/ui';

interface Detail {
  id: number; account_id: number; statement_date: string; statement_balance: number; status: string;
  account: { name: string }; previouslyReconciled: number; clearedBalance: number; bookBalance: number; difference: number;
  rows: Array<{ id: number; entry_id: number; date: string; description: string; amount: number; isCleared: boolean }>;
}

export default function Reconcile() {
  const { accounts } = useAccounts();
  const { data: list, reload: reloadList } = useApi<Array<{ id: number; account_name: string; statement_date: string; statement_balance: number; status: string; completed_at: string | null }>>('/reconciliations');
  const [form, setForm] = useState({ accountId: null as number | null, statementDate: today(), statementBalance: '' });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<Detail | unknown>) => {
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'rows' in (r as object)) setDetail(r as Detail);
      setError(null);
      reloadList();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader title="Reconciliation" subtitle="Match your ledger to bank and credit-card statements. Tick each transaction that appears on the statement until the difference is zero." />
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="card mb-4 grid items-end gap-3 p-4 md:grid-cols-4">
        <div>
          <label className="label">Account</label>
          <AccountSelect accounts={accounts} value={form.accountId} filter={(a) => ['cash', 'bank', 'savings', 'credit_card', 'line_of_credit', 'tfsa', 'rrsp', 'investment'].includes(a.subtype)} onChange={(id) => setForm({ ...form, accountId: id })} />
        </div>
        <div>
          <label className="label">Statement date</label>
          <input type="date" className="input" value={form.statementDate} onChange={(e) => setForm({ ...form, statementDate: e.target.value })} />
        </div>
        <div>
          <label className="label">Statement ending balance</label>
          <input type="number" step="0.01" className="input" value={form.statementBalance} onChange={(e) => setForm({ ...form, statementBalance: e.target.value })} />
        </div>
        <button className="btn-primary" disabled={!form.accountId || form.statementBalance === ''} onClick={() => run(() => api('/reconciliations', { body: { ...form, statementBalance: Number(form.statementBalance) } }))}>
          Start / resume
        </button>
      </div>

      {detail && (
        <div className="card mb-6 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">
              {detail.account.name} · statement {detail.statement_date} {detail.status === 'completed' && <span className="badge bg-emerald-100 text-emerald-800">Completed</span>}
            </h2>
            <div className="flex gap-2">
              {detail.status === 'in_progress' && (
                <>
                  <button className="btn-secondary" onClick={() => run(() => api(`/reconciliations/${detail.id}/toggle`, { body: { lineIds: detail.rows.map((r) => r.id), cleared: true } }))}>Clear all</button>
                  <button className="btn-danger" onClick={() => run(async () => { await api(`/reconciliations/${detail.id}`, { method: 'DELETE' }); setDetail(null); })}>Cancel</button>
                  <button className="btn-primary" disabled={detail.difference !== 0} onClick={() => run(() => api(`/reconciliations/${detail.id}/complete`, { body: {} }))}>
                    <CheckCircle2 size={15} /> Finish
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="mb-3 grid gap-3 text-sm sm:grid-cols-5">
            <Kv k="Statement balance" v={<Money cents={detail.statement_balance} />} />
            <Kv k="Previously reconciled" v={<Money cents={detail.previouslyReconciled} />} />
            <Kv k="Cleared balance" v={<Money cents={detail.clearedBalance} />} />
            <Kv k="Ledger balance" v={<Money cents={detail.bookBalance} />} />
            <Kv k="Difference" v={<span className={detail.difference === 0 ? 'font-semibold text-emerald-600' : 'font-semibold text-rose-600'}>{cad(detail.difference)}</span>} />
          </div>
          <table className="table">
            <thead>
              <tr>
                <th className="w-10" />
                <th>Date</th>
                <th>Description</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((r) => (
                <tr key={r.id} className={r.isCleared ? 'bg-emerald-50/50' : ''}>
                  <td>
                    <input type="checkbox" checked={r.isCleared} disabled={detail.status !== 'in_progress'} onChange={() => run(() => api(`/reconciliations/${detail.id}/toggle`, { body: { lineId: r.id } }))} />
                  </td>
                  <td>{r.date}</td>
                  <td>{r.description} <span className="text-xs text-slate-400">#{r.entry_id}</span></td>
                  <td className="num"><Money cents={r.amount} colored /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!detail.rows.length && <Empty>No unreconciled transactions up to this date.</Empty>}
        </div>
      )}

      <div className="card">
        <h2 className="px-4 pt-4 font-semibold">History</h2>
        <table className="table">
          <tbody>
            {list?.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => run(() => api(`/reconciliations/${r.id}`))}>
                <td>{r.account_name}</td>
                <td>{r.statement_date}</td>
                <td className="num"><Money cents={r.statement_balance} /></td>
                <td><span className={`badge ${r.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list?.length && <Empty>No reconciliations yet.</Empty>}
      </div>
    </div>
  );
}

const Kv = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="rounded-lg bg-slate-50 p-2">
    <div className="label">{k}</div>
    <div>{v}</div>
  </div>
);
