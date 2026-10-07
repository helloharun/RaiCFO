import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  BarChart3, BookOpen, Bot, Menu, Sparkles, X, CalendarClock, CheckSquare, Database, FileSpreadsheet, Flag, History, LayoutDashboard, Landmark, LineChart, LogOut, MessageSquarePlus, PiggyBank, Settings as SettingsIcon, TrendingDown, Upload,
} from 'lucide-react';
import { api, setCsrfToken, UNAUTHORIZED_EVENT } from './api';
import Login, { type SessionInfo } from './pages/Login';
import Goals from './pages/Goals';
import Planning from './pages/Planning';
import DataSecurity from './pages/DataSecurity';
import Dashboard from './pages/Dashboard';
import Record from './pages/Record';
import Journal from './pages/Journal';
import Accounts from './pages/Accounts';
import Reports from './pages/Reports';
import Budgets from './pages/Budgets';
import Investments from './pages/Investments';
import Reconcile from './pages/Reconcile';
import ImportCsv from './pages/Import';
import Recurring from './pages/Recurring';
import Ask from './pages/Ask';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import Insights from './pages/Insights';
import { useApi } from './components/ui';

const NAV = [
  ['/', 'Dashboard', LayoutDashboard],
  ['/record', 'Record Transaction', MessageSquarePlus],
  ['/journal', 'Journal', BookOpen],
  ['/insights', 'Insights', Sparkles],
  ['/accounts', 'Accounts', Landmark],
  ['/reports', 'Statements', FileSpreadsheet],
  ['/budgets', 'Budgets', PiggyBank],
  ['/goals', 'Goals', Flag],
  ['/planning', 'Cash Flow & Debt', TrendingDown],
  ['/investments', 'Investments', LineChart],
  ['/reconcile', 'Reconcile', CheckSquare],
  ['/import', 'Import CSV', Upload],
  ['/recurring', 'Recurring', CalendarClock],
  ['/ask', 'Ask Finance', Bot],
  ['/audit', 'Audit Trail', History],
  ['/data', 'Data & Security', Database],
  ['/settings', 'Settings', SettingsIcon],
] as const;

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((s: SessionInfo) => {
    setCsrfToken(s.authenticated ? s.csrfToken ?? null : null);
    setSession(s);
  }, []);

  useEffect(() => {
    api<SessionInfo>('/auth/session').then(apply, () => apply({ authenticated: false }));
    const onUnauthorized = () => {
      setNotice('Your session expired. Please sign in again.');
      apply({ authenticated: false });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [apply]);

  if (!session) return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  if (!session.authenticated) return <Login notice={notice} onLogin={(s) => (setNotice(null), apply(s))} />;
  return <Shell username={session.username ?? ''} onLogout={async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setNotice(null);
      apply({ authenticated: false });
    }
  }} />;
}

const TABS = [
  ['/', 'Home', LayoutDashboard],
  ['/record', 'Record', MessageSquarePlus],
  ['/insights', 'Insights', Sparkles],
  ['/ask', 'Ask', Bot],
] as const;

function Shell({ username, onLogout }: { username: string; onLogout: () => void }) {
  const { data: meta } = useApi<{ ai: { enabled: boolean; provider?: string; model?: string } }>('/meta');
  const [more, setMore] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    setMore(false);
    window.scrollTo(0, 0);
  }, [pathname]);
  const current = NAV.find(([to]) => (to === '/' ? pathname === '/' : pathname.startsWith(to)))?.[1] ?? 'Personal Finance HQ';
  const inTabs = TABS.some(([to]) => (to === '/' ? pathname === '/' : pathname.startsWith(to)));
  return (
    <div className="flex min-h-[100dvh]">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <BarChart3 size={20} />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Personal Finance HQ</div>
            <div className="text-xs text-slate-500">Your personal CFO</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map(([to, label, Icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`
              }
            >
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">
          <AiInfo meta={meta} />
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
            <span className="truncate" title={username}>Signed in as <b className="text-slate-700">{username}</b></span>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={onLogout} title="Sign out">
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="pt-safe sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur md:hidden">
          <div className="flex h-12 items-center gap-2 px-4">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-white">
              <BarChart3 size={16} />
            </div>
            <div className="truncate text-base font-semibold">{current}</div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-4 md:px-8 md:py-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/record" element={<Record />} />
            <Route path="/journal" element={<Journal />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/budgets" element={<Budgets />} />
            <Route path="/goals" element={<Goals />} />
            <Route path="/planning" element={<Planning />} />
            <Route path="/data" element={<DataSecurity />} />
            <Route path="/investments" element={<Investments />} />
            <Route path="/reconcile" element={<Reconcile />} />
            <Route path="/import" element={<ImportCsv />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/ask" element={<Ask />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>

      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden" aria-label="Primary">
        <div className="grid grid-cols-5">
          {TABS.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${isActive ? 'text-indigo-600' : 'text-slate-500'}`}>
              <Icon size={22} />
              {label}
            </NavLink>
          ))}
          <button className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${more || !inTabs ? 'text-indigo-600' : 'text-slate-500'}`} onClick={() => setMore(true)} aria-label="More">
            <Menu size={22} />
            More
          </button>
        </div>
      </nav>

      {more && (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-900/40 md:hidden" onClick={() => setMore(false)}>
          <div className="pb-safe max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <div className="text-base font-semibold">All sections</div>
              <button className="btn-ghost p-2" onClick={() => setMore(false)} aria-label="Close"><X size={20} /></button>
            </div>
            <div className="grid grid-cols-3 gap-2 px-4 pb-3">
              {NAV.map(([to, label, Icon]) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-center text-xs font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-50 text-slate-700 active:bg-slate-100'}`}>
                  <Icon size={22} />
                  {label}
                </NavLink>
              ))}
            </div>
            <div className="mx-4 mb-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">
              <AiInfo meta={meta} />
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-200 pt-2">
                <span className="truncate">Signed in as <b className="text-slate-700">{username}</b></span>
                <button className="btn-secondary" onClick={onLogout}><LogOut size={15} /> Sign out</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AiInfo({ meta }: { meta: { ai: { enabled: boolean; provider?: string; model?: string } } | null }) {
  return (
    <>
      AI: {meta?.ai.enabled ? <span className="text-emerald-600">{meta.ai.provider} · {meta.ai.model}</span> : <span>built-in parser (no LLM key)</span>}
      <div>Reporting currency: CAD</div>
    </>
  );
}
