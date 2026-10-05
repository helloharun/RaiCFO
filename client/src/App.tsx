import { NavLink, Route, Routes } from 'react-router-dom';
import {
  BarChart3, BookOpen, Bot, CalendarClock, CheckSquare, FileSpreadsheet, History, LayoutDashboard, Landmark, LineChart, MessageSquarePlus, PiggyBank, Settings as SettingsIcon, Upload,
} from 'lucide-react';
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
import { useApi } from './components/ui';

const NAV = [
  ['/', 'Dashboard', LayoutDashboard],
  ['/record', 'Record Transaction', MessageSquarePlus],
  ['/journal', 'Journal', BookOpen],
  ['/accounts', 'Accounts', Landmark],
  ['/reports', 'Statements', FileSpreadsheet],
  ['/budgets', 'Budgets', PiggyBank],
  ['/investments', 'Investments', LineChart],
  ['/reconcile', 'Reconcile', CheckSquare],
  ['/import', 'Import CSV', Upload],
  ['/recurring', 'Recurring', CalendarClock],
  ['/ask', 'Ask Finance', Bot],
  ['/audit', 'Audit Trail', History],
  ['/settings', 'Settings', SettingsIcon],
] as const;

export default function App() {
  const { data: meta } = useApi<{ ai: { enabled: boolean; provider?: string; model?: string } }>('/meta');
  return (
    <div className="flex min-h-screen">
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
          AI: {meta?.ai.enabled ? <span className="text-emerald-600">{meta.ai.provider} · {meta.ai.model}</span> : <span>built-in parser (no LLM key)</span>}
          <div>Reporting currency: CAD</div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:hidden">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `whitespace-nowrap rounded px-2 py-1 text-xs ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600'}`}>
              {label}
            </NavLink>
          ))}
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/record" element={<Record />} />
            <Route path="/journal" element={<Journal />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/budgets" element={<Budgets />} />
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
    </div>
  );
}
