import { useState } from 'react';
import { Pause, Play, Plus, Send } from 'lucide-react';
import { api, cad, today, type EntryInput } from '../api';
import EntryEditor, { blankEntry, entryTotals } from '../components/EntryEditor';
import { Empty, ErrorBox, Modal, Notice, PageHeader, useAccounts, useApi } from '../components/ui';

interface Rec { id: number; description: string; frequency: string; next_date: string; end_date: string | null; auto_post: number; is_active: number; template: EntryInput }
const FREQS = ['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'];

export default function Recurring() {
  const { accounts } = useAccounts();
  const { data, reload } = useApi<Rec[]>('/recurring');
  const [edit, setEdit] = useState<{ id?: number; description: string; frequency: string; nextDate: string; endDate: string; autoPost: boolean; entry: EntryInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, m?: string) => {
    try {
      await fn();
      setError(null);
      if (m) setMsg(m);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = () =>
    edit &&
    run(async () => {
      const { date: _d, ...template } = edit.entry;
      const body = { description: edit.description, frequency: edit.frequency, nextDate: edit.nextDate, endDate: edit.endDate || null, autoPost: edit.autoPost, template: { ...template, description: edit.entry.description || edit.description } };
      if (edit.id) await api(`/recurring/${edit.id}`, { method: 'PUT', body });
      else await api('/recurring', { body });
      setEdit(null);
    });
  return (
    <div>
      <PageHeader
        title="Recurring transactions"
        subtitle="Templates that post automatically on their schedule (checked at startup and hourly). Every posting goes through the same validation engine."
        actions={
          <>
            <button className="btn-secondary" onClick={() => run(async () => { const r = await api<{ posted: number[] }>('/recurring/run', { body: {} }); setMsg(`Posted ${r.posted.length} due transaction(s).`); })}>Run due now</button>
            <button className="btn-primary" onClick={() => setEdit({ description: '', frequency: 'monthly', nextDate: today(), endDate: '', autoPost: true, entry: blankEntry(today()) })}>
              <Plus size={15} /> New
            </button>
          </>
        }
      />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {msg && <div className="mb-4"><Notice tone="success">{msg}</Notice></div>}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Frequency</th>
              <th>Next date</th>
              <th>Entry</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className={r.is_active ? '' : 'opacity-50'}>
                <td className="cursor-pointer font-medium text-indigo-700" onClick={() => setEdit({ id: r.id, description: r.description, frequency: r.frequency, nextDate: r.next_date, endDate: r.end_date ?? '', autoPost: !!r.auto_post, entry: { ...r.template, date: r.next_date } })}>{r.description}</td>
                <td>{r.frequency}{!r.auto_post && <span className="badge ml-1 bg-slate-100">manual</span>}</td>
                <td>{r.next_date}{r.end_date && <div className="text-xs text-slate-400">until {r.end_date}</div>}</td>
                <td className="text-xs">{r.template.lines.map((l, i) => <div key={i}>{l.debit ? 'Dr' : 'Cr'} {accounts.find((a) => a.id === l.accountId)?.name}</div>)}</td>
                <td className="num">{cad(Math.round(r.template.lines.reduce((s, l) => s + Number(l.debit || 0), 0) * 100))}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn-ghost" title="Post one now" onClick={() => run(() => api(`/recurring/${r.id}/post-now`, { body: { date: today() } }), 'Posted.')}><Send size={14} /></button>
                  <button className="btn-ghost" title={r.is_active ? 'Pause' : 'Resume'} onClick={() => run(() => api(`/recurring/${r.id}/${r.is_active ? 'pause' : 'resume'}`, { body: {} }))}>{r.is_active ? <Pause size={14} /> : <Play size={14} />}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.length && <Empty>No recurring transactions. You can also create one from any journal entry.</Empty>}
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit recurring transaction' : 'New recurring transaction'} onClose={() => setEdit(null)} wide>
          <div className="mb-4 grid gap-3 sm:grid-cols-5">
            <div className="sm:col-span-2">
              <label className="label">Name</label>
              <input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </div>
            <div>
              <label className="label">Frequency</label>
              <select className="input" value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value })}>
                {FREQS.map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Next date</label>
              <input type="date" className="input" value={edit.nextDate} onChange={(e) => setEdit({ ...edit, nextDate: e.target.value })} />
            </div>
            <div>
              <label className="label">End date</label>
              <input type="date" className="input" value={edit.endDate} onChange={(e) => setEdit({ ...edit, endDate: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-5"><input type="checkbox" checked={edit.autoPost} onChange={(e) => setEdit({ ...edit, autoPost: e.target.checked })} /> Post automatically when due</label>
          </div>
          <EntryEditor entry={edit.entry} accounts={accounts} onChange={(entry) => setEdit({ ...edit, entry })} />
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn-primary" disabled={!entryTotals(edit.entry).balanced || !edit.description} onClick={save}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
