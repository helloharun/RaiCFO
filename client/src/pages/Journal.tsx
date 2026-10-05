import { useState } from 'react';
import { Download, Pencil, Plus, Repeat, RotateCcw, Search } from 'lucide-react';
import { api, cad, today, type Entry, type EntryInput, typeLabel, TYPE_LABELS } from '../api';
import EntryEditor, { blankEntry, entryTotals } from '../components/EntryEditor';
import { AccountSelect, Empty, ErrorBox, Modal, Money, PageHeader, useAccounts, useApi } from '../components/ui';

export default function Journal() {
  const { accounts } = useAccounts();
  const [filters, setFilters] = useState({ search: '', from: '', to: '', accountId: '', type: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as Array<[string, string]>).toString();
  const { data, reload } = useApi<{ entries: Entry[]; total: number }>(`/journal?limit=300&${qs}`, [qs]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [editing, setEditing] = useState<{ entry: EntryInput; replaceId?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!editing) return;
    try {
      if (editing.replaceId) await api(`/journal/${editing.replaceId}/replace`, { body: editing.entry });
      else await api('/journal', { body: { ...editing.entry, source: 'manual' } });
      setEditing(null);
      setSelected(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toInput = (e: Entry): EntryInput => ({
    date: e.date,
    description: e.description,
    payee: e.payee,
    memo: e.memo,
    transactionType: e.transaction_type,
    currency: e.currency,
    fxRate: e.fx_rate,
    lines: e.lines.map((l) => ({ accountId: l.account_id, debit: l.original_debit / 100, credit: l.original_credit / 100, memo: l.memo, symbol: l.symbol, quantity: l.quantity })),
  });

  return (
    <div>
      <PageHeader
        title="General journal"
        subtitle="Every posted entry. Entries are never deleted — corrections are made by reversal, keeping a full audit trail."
        actions={
          <>
            <a className="btn-secondary" href="/api/export/journal.csv">
              <Download size={15} /> Export CSV
            </a>
            <button className="btn-primary" onClick={() => setEditing({ entry: blankEntry(today()) })}>
              <Plus size={15} /> Manual entry
            </button>
          </>
        }
      />
      <div className="card mb-4 grid gap-2 p-3 md:grid-cols-6">
        <div className="relative md:col-span-2">
          <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input className="input pl-8" placeholder="Search description, payee…" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
        </div>
        <input type="date" className="input" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <input type="date" className="input" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        <AccountSelect accounts={accounts} value={filters.accountId ? Number(filters.accountId) : null} allowEmpty placeholder="All accounts" onChange={(id) => setFilters({ ...filters, accountId: id ? String(id) : '' })} />
        <select className="input" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Description</th>
              <th>Lines</th>
              <th>Type</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((e) => (
              <tr key={e.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelected(e)}>
                <td className="text-slate-400">{e.id}</td>
                <td className="whitespace-nowrap">{e.date}</td>
                <td>
                  <div className="font-medium">
                    {e.description} {e.reversed_by && <span className="badge ml-1 bg-rose-100 text-rose-700">Reversed</span>}
                    {e.reversal_of && <span className="badge ml-1 bg-amber-100 text-amber-800">Reversal</span>}
                  </div>
                  {e.payee && <div className="text-xs text-slate-500">{e.payee}</div>}
                </td>
                <td className="text-xs">
                  {e.lines.map((l) => (
                    <div key={l.id} className={l.credit ? 'pl-4' : ''}>
                      {l.debit ? 'Dr' : 'Cr'} {l.account_name} <span className="text-slate-500">{cad(l.debit || l.credit)}</span>
                    </div>
                  ))}
                </td>
                <td>
                  <span className="badge bg-slate-100 text-slate-700">{typeLabel(e.transaction_type)}</span>
                  <div className="mt-0.5 text-xs text-slate-400">{e.source}</div>
                </td>
                <td className="num">
                  <Money cents={e.lines.reduce((s, l) => s + l.debit, 0)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.entries.length && <Empty>No entries match.</Empty>}
        {data && <div className="px-3 py-2 text-xs text-slate-500">{data.total} entries</div>}
      </div>

      {selected && (
        <EntryDetail
          entry={selected}
          onClose={() => setSelected(null)}
          onEdit={() => setEditing({ entry: toInput(selected), replaceId: selected.id })}
          onChanged={() => {
            setSelected(null);
            reload();
          }}
        />
      )}
      {editing && (
        <Modal title={editing.replaceId ? `Edit entry #${editing.replaceId} (reverses and reposts)` : 'Manual journal entry'} onClose={() => setEditing(null)} wide>
          <ErrorBox error={error} onClose={() => setError(null)} />
          <EntryEditor entry={editing.entry} accounts={accounts} onChange={(entry) => setEditing({ ...editing, entry })} />
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!entryTotals(editing.entry).balanced || !editing.entry.description} onClick={save}>
              Post entry
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EntryDetail({ entry, onClose, onEdit, onChanged }: { entry: Entry; onClose: () => void; onEdit: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [freq, setFreq] = useState('monthly');
  const meta = entry.metadata ? JSON.parse(entry.metadata) : null;
  const reverse = async () => {
    const reason = prompt('Reason for reversal (optional):') ?? undefined;
    try {
      await api(`/journal/${entry.id}/reverse`, { body: { reason } });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const makeRecurring = async () => {
    const d = new Date(entry.date);
    d.setMonth(d.getMonth() + 1);
    try {
      await api('/recurring', {
        body: {
          description: entry.description,
          frequency: freq,
          nextDate: d.toISOString().slice(0, 10),
          autoPost: true,
          template: {
            description: entry.description,
            payee: entry.payee,
            transactionType: entry.transaction_type,
            currency: entry.currency,
            lines: entry.lines.map((l) => ({ accountId: l.account_id, debit: l.original_debit / 100, credit: l.original_credit / 100, memo: l.memo })),
          },
        },
      });
      alert('Recurring transaction created.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Entry #${entry.id}`} onClose={onClose} wide>
      <ErrorBox error={error} />
      <div className="grid gap-2 text-sm sm:grid-cols-4">
        <Info k="Date" v={entry.date} />
        <Info k="Type" v={typeLabel(entry.transaction_type)} />
        <Info k="Source" v={entry.source} />
        <Info k="Currency" v={entry.currency === 'CAD' ? 'CAD' : `${entry.currency} @ ${entry.fx_rate}`} />
        <div className="sm:col-span-4">
          <Info k="Description" v={entry.description} />
        </div>
        {entry.payee && <Info k="Payee" v={entry.payee} />}
        {entry.memo && <Info k="Notes" v={entry.memo} />}
      </div>
      <table className="table mt-4">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th>Memo</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l) => (
            <tr key={l.id}>
              <td className={l.credit ? 'pl-8' : ''}>
                {l.account_code} · {l.account_name}
                {l.symbol && <span className="ml-1 text-xs text-slate-500">({l.quantity} {l.symbol})</span>}
              </td>
              <td className="num">{l.debit ? cad(l.debit) : ''}</td>
              <td className="num">{l.credit ? cad(l.credit) : ''}</td>
              <td className="text-slate-500">
                {l.memo} {l.cleared ? <span className="badge bg-emerald-50 text-emerald-700">cleared</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entry.raw_input && (
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
          <div className="label">Original input</div>“{entry.raw_input}”
        </div>
      )}
      {entry.explanation && (
        <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm">
          <div className="label">Accounting explanation</div>
          <ul className="list-disc pl-5">
            {entry.explanation.split('\n').map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {meta && Object.keys(meta).length > 0 && <div className="mt-2 text-xs text-slate-500">Metadata: {JSON.stringify(meta)}</div>}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <div className="mr-auto flex items-center gap-1">
          <select className="input w-32" value={freq} onChange={(e) => setFreq(e.target.value)}>
            {['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly'].map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <button className="btn-secondary" onClick={makeRecurring}>
            <Repeat size={15} /> Make recurring
          </button>
        </div>
        {!entry.reversed_by && !entry.reversal_of && (
          <>
            <button className="btn-secondary" onClick={onEdit}>
              <Pencil size={15} /> Edit
            </button>
            <button className="btn-danger" onClick={reverse}>
              <RotateCcw size={15} /> Reverse
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

const Info = ({ k, v }: { k: string; v: string }) => (
  <div>
    <div className="label">{k}</div>
    <div>{v}</div>
  </div>
);
