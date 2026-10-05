import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, today } from '../api';
import { AccountSelect, ErrorBox, Notice, PageHeader, useAccounts, useApi } from '../components/ui';

export default function Settings() {
  const { accounts } = useAccounts();
  const { data: settings, reload } = useApi<{ lock_date: string | null; default_payment_account: string | null; owner_name: string | null }>('/settings');
  const { data: fx, reload: reloadFx } = useApi<Array<{ currency: string; date: string; rate: number }>>('/fx-rates');
  const { data: rules, reload: reloadRules } = useApi<Array<{ id: number; pattern: string; account_name: string; hits: number }>>('/merchant-rules');
  const { data: meta } = useApi<{ ai: { enabled: boolean; provider?: string; model?: string } }>('/meta');
  const [s, setS] = useState({ lock_date: '', default_payment_account: '', owner_name: '' });
  const [rate, setRate] = useState({ currency: 'USD', rate: '', date: today() });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => {
    if (settings) setS({ lock_date: settings.lock_date ?? '', default_payment_account: settings.default_payment_account ?? '', owner_name: settings.owner_name ?? '' });
  }, [settings]);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      setOk(msg);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const latest = Object.values((fx ?? []).reduce<Record<string, { currency: string; date: string; rate: number }>>((acc, r) => (acc[r.currency] ? acc : { ...acc, [r.currency]: r }), {}));
  return (
    <div className="space-y-4">
      <PageHeader title="Settings" />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {ok && <Notice tone="success">{ok}</Notice>}
      <div className="card grid gap-4 p-5 md:grid-cols-3">
        <div>
          <label className="label">Your name</label>
          <input className="input" value={s.owner_name} onChange={(e) => setS({ ...s, owner_name: e.target.value })} />
        </div>
        <div>
          <label className="label">Default payment account</label>
          <AccountSelect accounts={accounts} value={s.default_payment_account ? Number(s.default_payment_account) : null} allowEmpty placeholder="First bank account" filter={(a) => ['cash', 'bank', 'savings', 'credit_card'].includes(a.subtype)} onChange={(id) => setS({ ...s, default_payment_account: id ? String(id) : '' })} />
          <p className="mt-1 text-xs text-slate-500">Used when a description doesn’t say how you paid.</p>
        </div>
        <div>
          <label className="label">Lock books through</label>
          <input type="date" className="input" value={s.lock_date} onChange={(e) => setS({ ...s, lock_date: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">Prevents posting on or before this date (period close).</p>
        </div>
        <div className="md:col-span-3">
          <button className="btn-primary" onClick={() => run(async () => { await api('/settings', { method: 'PUT', body: s }); reload(); }, 'Settings saved.')}>Save settings</button>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="mb-1 font-semibold">AI configuration</h2>
        <p className="text-sm text-slate-600">
          {meta?.ai.enabled ? `Using ${meta.ai.provider} (${meta.ai.model}).` : 'No LLM configured — the built-in deterministic parser and analyst are used.'} To enable an LLM, set <code>OPENAI_API_KEY</code> or <code>ANTHROPIC_API_KEY</code> (optionally <code>LLM_MODEL</code>, <code>LLM_BASE_URL</code>) in <code>server/.env</code> and restart. The AI only proposes interpretations; the accounting engine always builds and validates the entries.
        </p>
      </div>

      <div className="card p-5">
        <h2 className="mb-3 font-semibold">Exchange rates (CAD per unit)</h2>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div><label className="label">Currency</label><input className="input w-24 uppercase" maxLength={3} value={rate.currency} onChange={(e) => setRate({ ...rate, currency: e.target.value.toUpperCase() })} /></div>
          <div><label className="label">Rate</label><input className="input w-28" type="number" step="0.0001" value={rate.rate} onChange={(e) => setRate({ ...rate, rate: e.target.value })} /></div>
          <div><label className="label">Effective date</label><input className="input" type="date" value={rate.date} onChange={(e) => setRate({ ...rate, date: e.target.value })} /></div>
          <button className="btn-secondary" onClick={() => run(async () => { await api('/fx-rates', { method: 'PUT', body: { ...rate, rate: Number(rate.rate) } }); reloadFx(); }, 'Rate saved.')}>Save rate</button>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {latest.filter((r) => r.currency !== 'CAD').map((r) => (
            <span key={r.currency} className="badge bg-slate-100 text-slate-700">{r.currency} {r.rate} <span className="ml-1 text-slate-400">{r.date === '1970-01-01' ? 'default' : r.date}</span></span>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="mb-1 font-semibold">Learned merchant rules</h2>
        <p className="mb-3 text-sm text-slate-500">When you post a transaction with a merchant, its category is remembered for next time.</p>
        <table className="table">
          <tbody>
            {rules?.map((r) => (
              <tr key={r.id}>
                <td>{r.pattern}</td>
                <td>→ {r.account_name}</td>
                <td className="text-slate-400">{r.hits}×</td>
                <td className="text-right"><button className="btn-ghost" onClick={() => run(async () => { await api(`/merchant-rules/${r.id}`, { method: 'DELETE' }); reloadRules(); }, 'Rule removed.')}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
