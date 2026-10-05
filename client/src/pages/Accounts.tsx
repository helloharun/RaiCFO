import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus } from 'lucide-react';
import { api, subtypeLabel, type Account } from '../api';
import { AccountSelect, ErrorBox, Modal, Money, PageHeader, useApi } from '../components/ui';

const TYPES: Account['type'][] = ['asset', 'liability', 'equity', 'income', 'expense'];
const TITLES = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

export default function Accounts() {
  const { data: accounts, reload } = useApi<Account[]>('/accounts');
  const { data: meta } = useApi<{ subtypes: Record<string, string[]> }>('/meta');
  const [editing, setEditing] = useState<Partial<Account> | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const move = (a: Account, dir: -1 | 1) => {
    const group = (accounts ?? []).filter((x) => x.type === a.type).sort((x, y) => x.sort_order - y.sort_order || x.code.localeCompare(y.code));
    const i = group.findIndex((x) => x.id === a.id);
    const j = i + dir;
    if (j < 0 || j >= group.length) return;
    [group[i], group[j]] = [group[j], group[i]];
    act(() => api('/accounts/reorder', { body: { ids: group.map((x) => x.id) } }));
  };

  return (
    <div>
      <PageHeader
        title="Chart of accounts"
        subtitle="Accounts with history can't be deleted — deactivate them instead."
        actions={
          <>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
            </label>
            <button className="btn-primary" onClick={() => setEditing({ type: 'asset', subtype: 'bank', currency: 'CAD' })}>
              <Plus size={15} /> New account
            </button>
          </>
        }
      />
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="grid gap-4 xl:grid-cols-2">
        {TYPES.map((t) => {
          const list = (accounts ?? [])
            .filter((a) => a.type === t && (showInactive || a.is_active))
            .sort((x, y) => x.sort_order - y.sort_order || x.code.localeCompare(y.code));
          const total = list.reduce((s, a) => s + a.balance, 0);
          return (
            <div key={t} className="card">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="font-semibold">{TITLES[t]}</h2>
                <Money cents={total} className="font-semibold" />
              </div>
              <table className="table">
                <tbody>
                  {list.map((a) => (
                    <tr key={a.id} className={a.is_active ? '' : 'opacity-50'}>
                      <td className="w-16 text-slate-400">{a.code}</td>
                      <td>
                        <div className="font-medium">
                          {a.parent_id ? '↳ ' : ''}
                          {a.name} {!a.is_active && <span className="badge bg-slate-200 text-slate-600">inactive</span>}
                          {a.currency !== 'CAD' && <span className="badge ml-1 bg-sky-50 text-sky-700">{a.currency}</span>}
                        </div>
                        <div className="text-xs text-slate-500">{subtypeLabel(a.subtype)}{a.institution ? ` · ${a.institution}` : ''}</div>
                      </td>
                      <td className="num">
                        <Money cents={a.balance} />
                      </td>
                      <td className="w-36 whitespace-nowrap text-right">
                        <button className="btn-ghost px-1" onClick={() => move(a, -1)} aria-label="Move up">
                          <ArrowUp size={14} />
                        </button>
                        <button className="btn-ghost px-1" onClick={() => move(a, 1)} aria-label="Move down">
                          <ArrowDown size={14} />
                        </button>
                        <button className="btn-ghost px-1" onClick={() => setEditing(a)} aria-label="Edit">
                          <Pencil size={14} />
                        </button>
                        {!a.is_system &&
                          (a.is_active ? (
                            <button className="btn-ghost px-1 text-xs" onClick={() => act(() => api(`/accounts/${a.id}/deactivate`, { body: {} }))}>
                              Deactivate
                            </button>
                          ) : (
                            <button className="btn-ghost px-1 text-xs" onClick={() => act(() => api(`/accounts/${a.id}/reactivate`, { body: {} }))}>
                              Reactivate
                            </button>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      {editing && meta && (
        <AccountForm
          account={editing}
          subtypes={meta.subtypes}
          accounts={accounts ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function AccountForm({ account, subtypes, accounts, onClose, onSaved }: { account: Partial<Account>; subtypes: Record<string, string[]>; accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Partial<Account>>(account);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (f.type && !subtypes[f.type].includes(f.subtype ?? '')) setF((x) => ({ ...x, subtype: subtypes[f.type!][0] }));
  }, [f.type, f.subtype, subtypes]);
  const save = async () => {
    try {
      const body = { ...f, parentId: f.parent_id };
      if (f.id) await api(`/accounts/${f.id}`, { method: 'PUT', body });
      else await api('/accounts', { body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm('Delete this account permanently? (Only possible if it has no history.)')) return;
    try {
      await api(`/accounts/${f.id}`, { method: 'DELETE' });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={f.id ? `Edit ${account.name}` : 'New account'} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">Name</label>
          <input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input" value={f.type} disabled={Boolean(f.id && account.hasActivity)} onChange={(e) => setF({ ...f, type: e.target.value as Account['type'] })}>
            {Object.keys(subtypes).map((t) => (
              <option key={t} value={t}>
                {subtypeLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Subtype</label>
          <select className="input" value={f.subtype} onChange={(e) => setF({ ...f, subtype: e.target.value })}>
            {(subtypes[f.type ?? 'asset'] ?? []).map((s) => (
              <option key={s} value={s}>
                {subtypeLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Code</label>
          <input className="input" placeholder="auto" value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </div>
        <div>
          <label className="label">Currency</label>
          <input className="input uppercase" maxLength={3} value={f.currency ?? 'CAD'} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
        </div>
        <div>
          <label className="label">Institution</label>
          <input className="input" value={f.institution ?? ''} onChange={(e) => setF({ ...f, institution: e.target.value })} />
        </div>
        <div>
          <label className="label">Parent account</label>
          <AccountSelect accounts={accounts.filter((a) => a.id !== f.id && a.type === f.type)} value={f.parent_id ?? null} allowEmpty placeholder="None" onChange={(id) => setF({ ...f, parent_id: id })} />
        </div>
        <div className="col-span-2">
          <label className="label">AI keywords / aliases (comma-separated)</label>
          <input className="input" placeholder="e.g. td, debit card, chequing" value={f.aliases ?? ''} onChange={(e) => setF({ ...f, aliases: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">Words that help the transaction interpreter recognise this account or category.</p>
        </div>
        <div className="col-span-2">
          <label className="label">Description</label>
          <input className="input" value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </div>
      </div>
      <div className="mt-4 flex justify-between">
        <div>{f.id && !account.hasActivity && !account.is_system && <button className="btn-danger" onClick={remove}>Delete</button>}</div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
