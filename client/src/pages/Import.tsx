import { useState } from 'react';
import { Upload } from 'lucide-react';
import { api, amt } from '../api';
import { AccountSelect, ErrorBox, Notice, PageHeader, useAccounts } from '../components/ui';

interface Row { rowNumber: number; date: string | null; description: string; amount: number; counterAccountId: number | null; importHash: string; duplicate: boolean; error?: string; include?: boolean }
interface Mapping { date?: string; description?: string; amount?: string; debit?: string; credit?: string; dateFormat: 'auto' | 'YMD' | 'MDY' | 'DMY'; invert: boolean }

export default function ImportCsv() {
  const { accounts } = useAccounts();
  const [csv, setCsv] = useState('');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>({ dateFormat: 'auto', invert: false });
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const preview = async (m: Mapping = mapping) => {
    setError(null);
    setResult(null);
    try {
      const r = await api<{ headers: string[]; guessed: Partial<Mapping>; rows: Row[] }>('/import/preview', { body: { csv, accountId, mapping: m } });
      setHeaders(r.headers);
      if (!r.rows.length && r.headers.length) {
        const next = { ...m, ...Object.fromEntries(Object.entries(r.guessed).filter(([, v]) => v)) } as Mapping;
        if (next.amount) {
          delete next.debit;
          delete next.credit;
        }
        setMapping(next);
        if (next.date && next.description && (next.amount || next.debit || next.credit)) return preview(next);
      }
      setRows(r.rows.map((x) => ({ ...x, include: !x.duplicate && !x.error })));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const commit = async () => {
    try {
      const sel = rows.filter((r) => r.include && r.counterAccountId && r.date);
      const r = await api<{ posted: number[]; errors: Array<{ index: number; error: string }> }>('/import/commit', {
        body: { accountId, rows: sel.map((x) => ({ date: x.date, description: x.description, amount: x.amount, counterAccountId: x.counterAccountId, importHash: x.importHash })) },
      });
      setResult(`Posted ${r.posted.length} transactions${r.errors.length ? `; ${r.errors.length} failed: ${r.errors.map((e) => e.error).join('; ')}` : ''}.`);
      setRows([]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const col = (k: keyof Mapping, label: string) => (
    <div>
      <label className="label">{label}</label>
      <select className="input" value={(mapping[k] as string) ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value || undefined })}>
        <option value="">—</option>
        {headers.map((h) => (
          <option key={h}>{h}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div>
      <PageHeader title="Import CSV" subtitle="Import bank or credit-card statements. Each row becomes a balanced journal entry against the chosen category. Duplicates are detected automatically." />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {result && <div className="mb-4"><Notice tone="success">{result}</Notice></div>}
      <div className="card space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="label">Statement account</label>
            <AccountSelect accounts={accounts} value={accountId} filter={(a) => a.type === 'asset' || a.type === 'liability'} onChange={setAccountId} />
          </div>
          <div>
            <label className="label">CSV file</label>
            <input type="file" accept=".csv,text/csv" className="input" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
          </div>
          <div className="flex items-end">
            <button className="btn-primary" disabled={!csv || !accountId} onClick={() => preview()}>
              <Upload size={15} /> Preview
            </button>
          </div>
        </div>
        <textarea className="input h-28 font-mono text-xs" placeholder={'Or paste CSV here, e.g.\nDate,Description,Amount\n2026-10-01,WALMART #123,-86.42\n2026-10-02,PAYROLL ACME,2000'} value={csv} onChange={(e) => setCsv(e.target.value)} />
        {headers.length > 0 && (
          <div className="grid gap-3 md:grid-cols-7">
            {col('date', 'Date column')}
            {col('description', 'Description column')}
            {col('amount', 'Amount (signed)')}
            {col('debit', 'or Withdrawal col')}
            {col('credit', 'and Deposit col')}
            <div>
              <label className="label">Date format</label>
              <select className="input" value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as Mapping['dateFormat'] })}>
                <option value="auto">Auto</option>
                <option value="YMD">YYYY-MM-DD</option>
                <option value="MDY">MM/DD/YYYY</option>
                <option value="DMY">DD/MM/YYYY</option>
              </select>
            </div>
            <div className="flex flex-col justify-end gap-1">
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={mapping.invert} onChange={(e) => setMapping({ ...mapping, invert: e.target.checked })} /> Flip signs</label>
              <button className="btn-secondary" onClick={() => preview()}>Apply</button>
            </div>
          </div>
        )}
        <p className="text-xs text-slate-500">Sign convention: positive = money into the account (deposit / card payment), negative = money out (purchase). Use “Flip signs” if your bank exports the opposite.</p>
      </div>
      {rows.length > 0 && (
        <div className="card mt-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Date</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th>Category / counter-account</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.rowNumber} className={r.include ? '' : 'opacity-50'}>
                  <td><input type="checkbox" checked={!!r.include} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} /></td>
                  <td>{r.date ?? '?'}</td>
                  <td>{r.description}</td>
                  <td className={`num ${r.amount < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{amt(r.amount)}</td>
                  <td className="w-72">
                    <AccountSelect accounts={accounts} value={r.counterAccountId} filter={(a) => a.id !== accountId} onChange={(id) => setRows(rows.map((x, j) => (j === i ? { ...x, counterAccountId: id } : x)))} />
                  </td>
                  <td>
                    {r.duplicate && <span className="badge bg-amber-100 text-amber-800">Duplicate</span>}
                    {r.error && <span className="badge bg-rose-100 text-rose-800">{r.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end gap-2 p-3">
            <span className="self-center text-sm text-slate-500">{rows.filter((r) => r.include).length} selected</span>
            <button className="btn-primary" onClick={commit} disabled={!rows.some((r) => r.include)}>Post selected</button>
          </div>
        </div>
      )}
    </div>
  );
}
