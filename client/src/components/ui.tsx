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
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : ''}`}>{value}</div>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16" onMouseDown={onClose}>
      <div className={`card w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} p-5`} onMouseDown={(e) => e.stopPropagation()}>
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
    <div className="mb-5 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
      {tabs.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} className={`rounded-md px-3 py-1.5 text-sm font-medium ${value === k ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{children}</div>;
}
