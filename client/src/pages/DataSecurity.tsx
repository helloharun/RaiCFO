import { useState } from 'react';
import { CheckCircle2, Download, HardDriveDownload, RefreshCw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { api, download, today, yearStart } from '../api';
import { ErrorBox, Notice, PageHeader, useApi } from '../components/ui';

interface Integrity { status: 'pass' | 'warn' | 'fail'; checkedAt: string; checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }> }
interface Backups { encrypted: boolean; intervalHours: number; retention: number; backups: Array<{ name: string; size: number; createdAt: string; encrypted: boolean }> }
interface SessionRow { current: boolean; createdAt: number; lastSeen: number; expiresAt: number; ip: string | null; userAgent: string | null }

const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export default function DataSecurity() {
  const integrity = useApi<Integrity>('/integrity');
  const backups = useApi<Backups>('/backups');
  const sessions = useApi<SessionRow[]>('/auth/sessions');
  const [range, setRange] = useState({ from: yearStart(), to: today() });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dl = (p: string) => download(p).catch((e) => setError((e as Error).message));
  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setOk(await fn());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const Icon = { pass: CheckCircle2, warn: ShieldAlert, fail: XCircle };
  const color = { pass: 'text-emerald-600', warn: 'text-amber-600', fail: 'text-rose-600' };

  return (
    <div className="space-y-5">
      <PageHeader title="Data & Security" subtitle="Download your ledger, manage backups, verify the integrity of your books and review active sessions." />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {ok && <Notice tone="success">{ok}</Notice>}

      <div className="card p-5">
        <h2 className="mb-1 font-semibold">Download ledger data</h2>
        <p className="mb-4 text-sm text-slate-500">CSV files open in Excel, Numbers or Google Sheets. The JSON export and the SQLite database contain everything and can be kept as an offline archive.</p>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div><label className="label">From</label><input type="date" className="input" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
          <div><label className="label">To / as of</label><input type="date" className="input" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => dl('/export/journal.csv')}><Download size={15} /> Journal (all entries, CSV)</button>
          <button className="btn-secondary" onClick={() => dl(`/export/general-ledger.csv?from=${range.from}&to=${range.to}`)}><Download size={15} /> General ledger (CSV)</button>
          <button className="btn-secondary" onClick={() => dl(`/export/trial-balance.csv?asOf=${range.to}`)}><Download size={15} /> Trial balance (CSV)</button>
          <button className="btn-secondary" onClick={() => dl('/export/accounts.csv')}><Download size={15} /> Chart of accounts (CSV)</button>
          <button className="btn-secondary" onClick={() => dl('/export/ledger.json')}><Download size={15} /> Full ledger (JSON)</button>
          <button className="btn-secondary" onClick={() => dl('/export/database.sqlite')}><HardDriveDownload size={15} /> Database file (SQLite)</button>
        </div>
      </div>

      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold">
            {integrity.data?.status === 'pass' ? <ShieldCheck className="text-emerald-600" size={18} /> : <ShieldAlert className={integrity.data ? color[integrity.data.status] : ''} size={18} />}
            Books integrity check
          </h2>
          <button className="btn-secondary" onClick={() => integrity.reload()} disabled={integrity.loading}><RefreshCw size={15} /> Re-run</button>
        </div>
        <ul className="divide-y divide-slate-100 text-sm">
          {integrity.data?.checks.map((c) => {
            const I = Icon[c.status];
            return (
              <li key={c.name} className="flex items-start gap-2 py-2">
                <I size={16} className={`mt-0.5 shrink-0 ${color[c.status]}`} />
                <div><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">{c.detail}</div></div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Backups</h2>
            {backups.data && (
              <p className="text-xs text-slate-500">
                {backups.data.intervalHours ? `Automatic every ${backups.data.intervalHours}h` : 'Automatic backups disabled'} · keeps {backups.data.retention} · {backups.data.encrypted ? 'AES-256-GCM encrypted' : 'not encrypted (set BACKUP_ENCRYPTION_KEY)'}
              </p>
            )}
          </div>
          <button className="btn-primary" disabled={busy} onClick={() => act(async () => { const b = await api<{ name: string }>('/backups', { method: 'POST' }); backups.reload(); return `Backup ${b.name} created.`; })}>Back up now</button>
        </div>
        {backups.data?.backups.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-1">File</th><th>Created</th><th>Size</th><th /></tr></thead>
            <tbody>
              {backups.data.backups.map((b) => (
                <tr key={b.name} className="border-t border-slate-100">
                  <td className="py-1.5 font-mono text-xs">{b.name}</td>
                  <td className="text-xs">{new Date(b.createdAt).toLocaleString()}</td>
                  <td className="text-xs">{size(b.size)}</td>
                  <td className="text-right"><button className="btn-ghost px-2 py-1" onClick={() => dl(`/backups/${encodeURIComponent(b.name)}/download`)} aria-label={`Download ${b.name}`}><Download size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-slate-500">No backups yet.</p>}
        <p className="mt-3 text-xs text-slate-500">To restore, stop the server and run <code>npm run restore -w server -- &lt;backup file&gt;</code>. The current database is kept as a safety copy.</p>
      </div>

      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Active sessions</h2>
          <button className="btn-secondary" disabled={busy} onClick={() => act(async () => { const r = await api<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' }); sessions.reload(); return `Signed out ${r.revoked} other session(s).`; })}>Sign out other sessions</button>
        </div>
        <ul className="divide-y divide-slate-100 text-sm">
          {sessions.data?.map((s, i) => (
            <li key={i} className="py-2">
              <div className="font-medium">{s.current ? 'This browser' : 'Other session'} · {s.ip ?? 'unknown IP'}</div>
              <div className="truncate text-xs text-slate-500" title={s.userAgent ?? ''}>{s.userAgent} · signed in {new Date(s.createdAt).toLocaleString()} · last active {new Date(s.lastSeen).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
