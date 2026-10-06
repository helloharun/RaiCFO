import { useState } from 'react';
import { CheckCircle2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, cad, pct } from '../api';
import { ErrorBox, Empty, Modal, PageHeader, useAccounts, useApi } from '../components/ui';

interface Goal {
  id: number;
  name: string;
  kind: string;
  targetAmount: number;
  targetDate: string | null;
  accountIds: number[];
  manualAmount: number;
  notes: string | null;
  isArchived: boolean;
  current: number;
  remaining: number;
  progress: number;
  monthsLeft: number | null;
  requiredMonthly: number | null;
  avgMonthly: number;
  projectedDate: string | null;
  onTrack: boolean;
  completed: boolean;
}
interface Health {
  liquid: number;
  netWorth: number;
  avgIncome: number;
  avgExpenses: number;
  metrics: Array<{ key: string; label: string; value: number | null; unit: string; status: 'good' | 'ok' | 'poor' | 'na'; hint: string }>;
}

const KINDS: Record<string, string> = {
  savings: 'Savings', emergency_fund: 'Emergency fund', debt_payoff: 'Debt payoff', investment: 'Investment', purchase: 'Big purchase', net_worth: 'Net worth', other: 'Other',
};
const tone = { good: 'text-emerald-600 bg-emerald-50', ok: 'text-amber-700 bg-amber-50', poor: 'text-rose-700 bg-rose-50', na: 'text-slate-500 bg-slate-50' };

const blank = { name: '', kind: 'savings', targetAmount: '', targetDate: '', accountIds: [] as number[], manualAmount: '', notes: '' };

export default function Goals() {
  const { data: goals, reload, error: loadError } = useApi<Goal[]>('/goals');
  const { data: health } = useApi<Health>('/planning/health');
  const { accounts } = useAccounts();
  const [form, setForm] = useState<typeof blank & { id?: number }>(blank);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edit = (g?: Goal) => {
    setForm(g ? { id: g.id, name: g.name, kind: g.kind, targetAmount: String(g.targetAmount / 100), targetDate: g.targetDate ?? '', accountIds: g.accountIds, manualAmount: String(g.manualAmount / 100), notes: g.notes ?? '' } : blank);
    setError(null);
    setOpen(true);
  };
  const save = async () => {
    try {
      const body = { ...form, targetAmount: Number(form.targetAmount), manualAmount: Number(form.manualAmount || 0), targetDate: form.targetDate || null };
      await api(form.id ? `/goals/${form.id}` : '/goals', { method: form.id ? 'PUT' : 'POST', body });
      setOpen(false);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (g: Goal) => {
    if (!confirm(`Delete goal "${g.name}"? This does not affect the ledger.`)) return;
    await api(`/goals/${g.id}`, { method: 'DELETE' }).catch((e) => setError((e as Error).message));
    reload();
  };
  const linkable = accounts.filter((a) => a.is_active && (form.kind === 'debt_payoff' ? a.type === 'liability' : a.type === 'asset'));
  const fmt = (m: Health['metrics'][number]) => (m.value === null ? '—' : m.unit === 'months' ? `${m.value.toFixed(1)} mo` : m.unit === 'ratio' ? pct(m.value) : cad(m.value));

  return (
    <div className="space-y-5">
      <PageHeader title="Goals & Financial Health" subtitle="Track savings, debt-payoff and net-worth goals directly from your ledger balances." actions={<button className="btn-primary" onClick={() => edit()}><Plus size={16} /> New goal</button>} />
      <ErrorBox error={loadError} />
      {health && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {health.metrics.map((m) => (
            <div key={m.key} className="card p-4" title={m.hint}>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{m.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{fmt(m)}</div>
              <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone[m.status]}`}>{m.status === 'na' ? 'Not enough data' : m.status === 'good' ? 'Healthy' : m.status === 'ok' ? 'Fair' : 'Needs attention'}</span>
              <p className="mt-2 text-xs text-slate-500">{m.hint}</p>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {goals?.length === 0 && <div className="card md:col-span-2"><Empty>No goals yet. Create one, e.g. “Emergency fund: $15,000 by Dec 2027”, linked to your savings account.</Empty></div>}
        {goals?.map((g) => (
          <div key={g.id} className="card p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2 font-semibold">{g.name} {g.completed && <CheckCircle2 size={16} className="text-emerald-600" />}</div>
                <div className="text-xs text-slate-500">{KINDS[g.kind] ?? g.kind}{g.targetDate ? ` · by ${g.targetDate}` : ''}{g.accountIds.length ? ` · linked to ${g.accountIds.map((id) => accounts.find((a) => a.id === id)?.name ?? '#' + id).join(', ')}` : g.kind === 'net_worth' ? ' · from net worth' : ' · manual'}</div>
              </div>
              <div className="flex gap-1">
                <button className="btn-ghost p-1.5" onClick={() => edit(g)} aria-label="Edit goal"><Pencil size={15} /></button>
                <button className="btn-ghost p-1.5 text-rose-600" onClick={() => remove(g)} aria-label="Delete goal"><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="mt-4 flex items-baseline justify-between text-sm">
              <span className="text-lg font-semibold tabular-nums">{cad(g.current)}</span>
              <span className="text-slate-500">of {cad(g.targetAmount)} · {pct(g.progress)}</span>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${g.completed ? 'bg-emerald-500' : g.onTrack ? 'bg-indigo-500' : 'bg-amber-500'}`} style={{ width: `${Math.round(g.progress * 100)}%` }} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-600">
              <div><dt className="text-slate-400">Remaining</dt><dd className="font-medium tabular-nums">{cad(g.remaining)}</dd></div>
              <div><dt className="text-slate-400">Needed / month</dt><dd className="font-medium tabular-nums">{g.requiredMonthly === null ? '—' : cad(g.requiredMonthly)}</dd></div>
              <div><dt className="text-slate-400">Your pace (3-mo avg)</dt><dd className="font-medium tabular-nums">{cad(g.avgMonthly)}/mo</dd></div>
              <div><dt className="text-slate-400">Projected</dt><dd className="font-medium">{g.completed ? 'Reached' : g.projectedDate ?? 'Not at current pace'}</dd></div>
            </dl>
            {!g.completed && <div className={`mt-3 text-xs font-medium ${g.onTrack ? 'text-emerald-600' : 'text-amber-700'}`}>{g.onTrack ? 'On track' : 'Behind schedule: increase contributions to reach this on time.'}</div>}
          </div>
        ))}
      </div>

      {open && (
        <Modal title={form.id ? 'Edit goal' : 'New goal'} onClose={() => setOpen(false)}>
          <ErrorBox error={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><label className="label">Name</label><input className="input" maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="label">Type</label><select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, accountIds: [] })}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div><label className="label">{form.kind === 'debt_payoff' ? 'Starting debt (CAD)' : 'Target (CAD)'}</label><input className="input" type="number" min="0" step="0.01" value={form.targetAmount} onChange={(e) => setForm({ ...form, targetAmount: e.target.value })} /></div>
            <div><label className="label">Target date</label><input className="input" type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} /></div>
            {form.kind !== 'net_worth' && (
              <div className="sm:col-span-2">
                <label className="label">Track balance of accounts (optional)</label>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 text-sm">
                  {linkable.map((a) => (
                    <label key={a.id} className="flex items-center gap-2">
                      <input type="checkbox" checked={form.accountIds.includes(a.id)} onChange={(e) => setForm({ ...form, accountIds: e.target.checked ? [...form.accountIds, a.id] : form.accountIds.filter((x) => x !== a.id) })} />
                      {a.name} <span className="ml-auto text-xs tabular-nums text-slate-500">{cad(a.balance)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {!form.accountIds.length && form.kind !== 'net_worth' && form.kind !== 'debt_payoff' && (
              <div><label className="label">Saved so far (manual)</label><input className="input" type="number" min="0" step="0.01" value={form.manualAmount} onChange={(e) => setForm({ ...form, manualAmount: e.target.value })} /></div>
            )}
            <div className="sm:col-span-2"><label className="label">Notes</label><textarea className="input" rows={2} maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={!form.name || !(Number(form.targetAmount) > 0)}>Save goal</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
