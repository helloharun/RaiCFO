import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api, cad, type Account } from '../api';

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function useAccounts() {
  const { data, reload } = useApi<Account[]>('/accounts');
  return { accounts: data ?? [], reload };
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorBox({ error, onClose }: { error: string | null; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div className="mb-4 flex items-start justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      <span>{error}</span>
      {onClose && (
        <button onClick={onClose} className="text-rose-500 hover:text-rose-700">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'success' | 'warn' }) {
  const cls = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
  }[tone];
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function Money({ cents, className = '', colored = false, sign = false }: { cents: number | null | undefined; className?: string; colored?: boolean; sign?: boolean }) {
  const color = colored && cents ? (cents < 0 ? 'text-rose-600' : 'text-emerald-600') : '';
  return <span className={`tabular-nums ${color} ${className}`}>{cad(cents, { sign })}</span>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold tabular-nums md:text-2xl ${tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : ''}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 md:items-start md:overflow-y-auto md:p-4 md:pt-16" onMouseDown={onClose}>
      <div
        className={`card max-h-[92dvh] w-full overflow-y-auto rounded-b-none p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:max-h-none md:overflow-visible md:rounded-xl md:pb-5 ${wide ? 'md:max-w-4xl' : 'md:max-w-lg'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const TYPE_ORDER: Account['type'][] = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_NAMES: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

export function AccountSelect({
  accounts,
  value,
  onChange,
  filter,
  placeholder = 'Select account…',
  className = '',
  allowEmpty,
}: {
  accounts: Account[];
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  filter?: (a: Account) => boolean;
  placeholder?: string;
  className?: string;
  allowEmpty?: boolean;
}) {
  const list = accounts.filter((a) => (a.is_active || a.id === value) && (!filter || filter(a)));
  return (
    <select className={`input ${className}`} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="" disabled={!allowEmpty}>
        {placeholder}
      </option>
      {TYPE_ORDER.map((t) => {
        const group = list.filter((a) => a.type === t);
        if (!group.length) return null;
        return (
          <optgroup key={t} label={TYPE_NAMES[t]}>
            {group.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
                {a.currency !== 'CAD' ? ` (${a.currency})` : ''}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="no-scrollbar mb-5 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 md:flex-wrap">
      {tabs.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${value === k ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{children}</div>;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const RANGE_PRESETS = [
  ['this-month', 'This month'],
  ['last-month', 'Last month'],
  ['last-3', 'Last 3 months'],
  ['ytd', 'Year to date'],
  ['last-12', 'Last 12 months'],
  ['last-year', 'Last year'],
  ['all', 'All time'],
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number][0];

export function presetRange(p: RangePreset, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const to = iso(now);
  switch (p) {
    case 'this-month': return { from: iso(new Date(y, m, 1)), to };
    case 'last-month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'last-3': return { from: iso(new Date(y, m - 2, 1)), to };
    case 'ytd': return { from: `${y}-01-01`, to };
    case 'last-12': return { from: iso(new Date(y, m - 11, 1)), to };
    case 'last-year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'all': return { from: '2000-01-01', to };
  }
}

/** Date range with one-tap presets plus custom from/to. */
export function DateRange({ from, to, onChange, className = '' }: { from: string; to: string; onChange: (r: { from: string; to: string }) => void; className?: string }) {
  const current = RANGE_PRESETS.find(([k]) => {
    const r = presetRange(k);
    return r.from === from && r.to === to;
  })?.[0] ?? 'custom';
  return (
    <div className={`grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center ${className}`}>
      <select className="input col-span-2 sm:w-40" value={current} aria-label="Date range" onChange={(e) => e.target.value !== 'custom' && onChange(presetRange(e.target.value as RangePreset))}>
        {RANGE_PRESETS.map(([k, label]) => (
          <option key={k} value={k}>{label}</option>
        ))}
        <option value="custom">Custom range</option>
      </select>
      <input type="date" className="input sm:w-40" aria-label="From" value={from} max={to} onChange={(e) => e.target.value && onChange({ from: e.target.value, to })} />
      <input type="date" className="input sm:w-40" aria-label="To" value={to} min={from} onChange={(e) => e.target.value && onChange({ from, to: e.target.value })} />
    </div>
  );
}
