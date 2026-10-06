import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { amt, type Account, type EntryInput, type LineInput, TYPE_LABELS } from '../api';
import { AccountSelect } from './ui';

const toCents = (n: number | undefined) => Math.round(Number(n || 0) * 100);

export function entryTotals(entry: EntryInput) {
  const d = entry.lines.reduce((s, l) => s + toCents(l.debit), 0);
  const c = entry.lines.reduce((s, l) => s + toCents(l.credit), 0);
  return { debit: d / 100, credit: c / 100, diff: (d - c) / 100, balanced: d === c && d > 0 && entry.lines.length >= 2 };
}

export function blankEntry(date: string): EntryInput {
  return { date, description: '', payee: '', memo: '', currency: 'CAD', transactionType: 'manual', lines: [{ accountId: 0, debit: 0 }, { accountId: 0, credit: 0 }] };
}

export default function EntryEditor({ entry, onChange, accounts, showHeader = true }: { entry: EntryInput; onChange: (e: EntryInput) => void; accounts: Account[]; showHeader?: boolean }) {
  const t = entryTotals(entry);
  const setLine = (i: number, patch: Partial<LineInput>) => onChange({ ...entry, lines: entry.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const showInvest = entry.lines.some((l) => l.symbol || l.quantity) || ['investment_purchase', 'investment_sale'].includes(entry.transactionType ?? '');
  return (
    <div className="space-y-4">
      {showHeader && (
        <div className="grid gap-3 sm:grid-cols-7">
          <div className="sm:col-span-2">
            <label className="label">Date</label>
            <input type="date" className="input" value={entry.date} onChange={(e) => onChange({ ...entry, date: e.target.value })} />
          </div>
          <div className="sm:col-span-3">
            <label className="label">Description</label>
            <input className="input" value={entry.description} onChange={(e) => onChange({ ...entry, description: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Payee / Merchant</label>
            <input className="input" value={entry.payee ?? ''} onChange={(e) => onChange({ ...entry, payee: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Type</label>
            <select className="input" value={entry.transactionType ?? 'manual'} onChange={(e) => onChange({ ...entry, transactionType: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-1">
            <label className="label">Currency</label>
            <input className="input uppercase" maxLength={3} value={entry.currency ?? 'CAD'} onChange={(e) => onChange({ ...entry, currency: e.target.value.toUpperCase(), fxRate: undefined })} />
          </div>
          <div className="sm:col-span-4">
            <label className="label">Notes</label>
            <input className="input" value={entry.memo ?? ''} onChange={(e) => onChange({ ...entry, memo: e.target.value })} />
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="w-[40%]">Account</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              {showInvest && <th>Symbol</th>}
              {showInvest && <th className="num">Qty</th>}
              <th>Memo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <AccountSelect accounts={accounts} value={l.accountId || null} onChange={(id) => setLine(i, { accountId: id ?? 0 })} />
                </td>
                <td>
                  <AmountInput value={l.debit} onChange={(v, raw) => setLine(i, { debit: v, credit: raw ? 0 : l.credit })} />
                </td>
                <td>
                  <AmountInput value={l.credit} onChange={(v, raw) => setLine(i, { credit: v, debit: raw ? 0 : l.debit })} />
                </td>
                {showInvest && (
                  <td>
                    <input className="input w-24 uppercase" value={l.symbol ?? ''} onChange={(e) => setLine(i, { symbol: e.target.value.toUpperCase() || null })} />
                  </td>
                )}
                {showInvest && (
                  <td>
                    <input type="number" className="input w-24 text-right" value={l.quantity ?? ''} onChange={(e) => setLine(i, { quantity: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                )}
                <td>
                  <input className="input" value={l.memo ?? ''} onChange={(e) => setLine(i, { memo: e.target.value })} />
                </td>
                <td>
                  <button className="btn-ghost" disabled={entry.lines.length <= 2} onClick={() => onChange({ ...entry, lines: entry.lines.filter((_, j) => j !== i) })} aria-label="Remove line">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td>
                <button className="btn-ghost" onClick={() => onChange({ ...entry, lines: [...entry.lines, { accountId: 0, debit: t.diff < 0 ? -t.diff : 0, credit: t.diff > 0 ? t.diff : 0 }] })}>
                  <Plus size={15} /> Add line
                </button>
              </td>
              <td className="num">{amt(t.debit)}</td>
              <td className="num">{amt(t.credit)}</td>
              <td colSpan={showInvest ? 4 : 2}>
                {t.balanced ? <span className="badge bg-emerald-100 text-emerald-800">Balanced</span> : <span className="badge bg-rose-100 text-rose-800">Out of balance {amt(t.diff)}</span>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Keeps the typed text locally so partial values like "0." or "0.0" are not wiped while typing. */
function AmountInput({ value, onChange }: { value?: number; onChange: (v: number, raw: string) => void }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => {
    if ((Number(text) || 0) !== (value || 0)) setText(value ? String(value) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="number"
      step="0.01"
      min="0"
      inputMode="decimal"
      className="input text-right"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(Number(e.target.value) || 0, e.target.value);
      }}
    />
  );
}
