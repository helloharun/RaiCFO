import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react';
import { api, cad } from '../api';
import { ErrorBox, Modal, useAccounts, useApi } from './ui';

type Rule = 'restore_next_year' | 'no_restore' | 'lifetime_cap';
interface Flow { entryId: number; date: string; description: string; payee: string | null; kind: 'contribution' | 'withdrawal'; amount: number }
interface Plan {
  id: number; name: string; rule: Rule; accountIds: number[]; annualLimit: number; yearLimits: Record<string, number>; room: Record<string, number>;
  lifetimeCap: number | null; carryCap: number | null; lifetimePrior: number; incomePct: number | null; notes: string | null;
  result: { year: number; contributed: number; withdrawn: number; transactions: Flow[]; anchorYear: number | null; estimated: boolean; roomJan1: number | null; remaining: number | null; newRoom: number | null; lifetimeLeft: number | null; first60: number };
}

export const RULES: Record<Rule, string> = {
  restore_next_year: 'Withdrawals add room back next year (TFSA-style)',
  no_restore: 'Withdrawals never add room back (RRSP-style)',
  lifetime_cap: 'Annual room with a lifetime cap (FHSA-style)',
};
const dollars = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(c / 100));

export default function ContributionRoom() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const { data, reload } = useApi<{ plans: Plan[] }>(`/contribution-plans?year=${year}`, [year]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Partial<Plan> | null>(null);
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });

  return (
    <div className="card mb-4 overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="text-sm font-semibold">Contribution room</div>
        <div className="flex items-center gap-2">
          <select className="input w-auto py-1" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
            {Array.from({ length: thisYear - 2009 + 2 }, (_, i) => thisYear + 1 - i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn-secondary py-1 text-sm" onClick={() => setEditing({ rule: 'restore_next_year', accountIds: [], room: {}, yearLimits: {} })}><Plus size={14} /> Plan</button>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr><th>Plan</th><th className="num">Room Jan 1</th><th className="num">Contributed</th><th className="num">Withdrawn</th><th className="num">Remaining</th><th /></tr>
        </thead>
        <tbody>
          {data?.plans.map((p) => {
            const r = p.result;
            const isOpen = open.has(p.id);
            return [
              <tr key={p.id}>
                <td>
                  <button className="flex items-center gap-1 text-left font-medium hover:text-indigo-600" onClick={() => toggle(p.id)} aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{p.name}
                  </button>
                  <div className="text-xs text-slate-500">
                    {!p.accountIds.length ? <span className="text-amber-700">No accounts linked</span> : r.roomJan1 === null ? <span className="text-amber-700">Enter your CRA room for {year} (pencil)</span> : r.estimated ? `Estimated from your ${r.anchorYear} CRA figure` : `From CRA figure for ${year}`}
                  </div>
                </td>
                <td className="num">{r.roomJan1 === null ? '—' : cad(r.roomJan1)}</td>
                <td className="num">{cad(r.contributed)}</td>
                <td className="num">{cad(r.withdrawn)}</td>
                <td className={`num font-semibold ${r.remaining !== null && r.remaining < 0 ? 'text-rose-600' : ''}`}>{r.remaining === null ? '—' : cad(r.remaining)}</td>
                <td className="w-10 text-right"><button className="btn-ghost px-1" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><Pencil size={14} /></button></td>
              </tr>,
              (isOpen || (r.remaining !== null && r.remaining < 0)) && (
                <tr key={`${p.id}-d`} className="bg-slate-50/60">
                  <td colSpan={6} className="space-y-1 text-xs text-slate-600">
                    {r.remaining !== null && r.remaining < 0 && <div className="font-medium text-rose-600">Over the limit by {cad(-r.remaining)}. CRA charges 1% per month on excess contributions.</div>}
                    {isOpen && (
                      <>
                        {p.rule === 'restore_next_year' && r.withdrawn > 0 && <div>{cad(r.withdrawn)} withdrawn this year comes back as room on Jan 1, {year + 1}.</div>}
                        {p.rule === 'no_restore' && r.first60 > 0 && <div>{cad(r.first60)} contributed Jan 1–Mar 1 can be deducted for {year - 1} instead.</div>}
                        {p.rule === 'lifetime_cap' && r.lifetimeLeft !== null && <div>Lifetime room left: {cad(r.lifetimeLeft)}.</div>}
                        {r.estimated && r.newRoom !== null && <div>New room added for {year}: {cad(r.newRoom)}. Enter the CRA figure to replace the estimate.</div>}
                        {r.transactions.length ? (
                          <ul className="divide-y rounded border bg-white">
                            {r.transactions.map((f) => (
                              <li key={`${f.entryId}-${f.kind}`} className="flex items-center gap-2 px-2 py-1.5">
                                <span className="w-20 shrink-0 text-slate-500">{f.date}</span>
                                <Link to={`/journal?entry=${f.entryId}`} className="min-w-0 flex-1 truncate hover:text-indigo-600 hover:underline">{f.description}</Link>
                                <span className={`tabular-nums ${f.kind === 'withdrawal' ? 'text-rose-600' : 'text-emerald-700'}`}>{f.kind === 'withdrawal' ? '−' : '+'}{cad(f.amount)}</span>
                              </li>
                            ))}
                          </ul>
                        ) : <div>No contributions or withdrawals in {year}.</div>}
                      </>
                    )}
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      <div className="px-4 py-2 text-[11px] text-slate-400">Counts money moved between a plan’s accounts and your other accounts. Growth, opening balances and moves between the plan’s own accounts aren’t counted.</div>
      {editing && <PlanForm plan={editing} year={year} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function PlanForm({ plan, year, onClose, onSaved }: { plan: Partial<Plan>; year: number; onClose: () => void; onSaved: () => void }) {
  const { accounts } = useAccounts();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    name: plan.name ?? '', rule: plan.rule ?? 'restore_next_year', accountIds: plan.accountIds ?? [], annualLimit: dollars(plan.annualLimit ?? 0), notes: plan.notes ?? '',
    lifetimeCap: dollars(plan.lifetimeCap), carryCap: dollars(plan.carryCap), lifetimePrior: dollars(plan.lifetimePrior ?? 0), incomePct: plan.incomePct === null || plan.incomePct === undefined ? '' : String(plan.incomePct),
    roomYear: dollars(plan.room?.[year]), limitYear: dollars(plan.yearLimits?.[year]),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const linkable = accounts.filter((a) => a.type === 'asset' && (a.is_active || f.accountIds.includes(a.id)));
  const save = async () => {
    try {
      const body = {
        ...f,
        room: { ...Object.fromEntries(Object.entries(plan.room ?? {}).map(([y, c]) => [y, c / 100])), [year]: f.roomYear === '' ? null : Number(f.roomYear) },
        yearLimits: { ...Object.fromEntries(Object.entries(plan.yearLimits ?? {}).map(([y, c]) => [y, c / 100])), [year]: f.limitYear === '' ? null : Number(f.limitYear) },
      };
      if (plan.id) await api(`/contribution-plans/${plan.id}`, { method: 'PUT', body });
      else await api('/contribution-plans', { body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!plan.id || !confirm(`Delete plan "${plan.name}"? Your ledger is not affected.`)) return;
    try {
      await api(`/contribution-plans/${plan.id}`, { method: 'DELETE' });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={plan.id ? `Edit ${plan.name}` : 'New plan'} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Name</label><input className="input" maxLength={80} value={f.name} onChange={set('name')} placeholder="e.g. Spousal RRSP" /></div>
        <div><label className="label">How room works</label><select className="input" value={f.rule} onChange={set('rule')}>{Object.entries(RULES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3 sm:col-span-2">
          <div className="mb-2 text-xs font-semibold text-indigo-900">For {year}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">Room on Jan 1 (from CRA)</label><input className="input" type="number" min="0" step="0.01" value={f.roomYear} onChange={set('roomYear')} placeholder="blank = roll forward" /></div>
            <div><label className="label">New room for {year}</label><input className="input" type="number" min="0" step="0.01" value={f.limitYear} onChange={set('limitYear')} placeholder={`blank = default ${f.annualLimit || 0}`} /></div>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">TFSA room: CRA My Account. RRSP: “deduction limit” on your Notice of Assessment. Leave blank in later years to estimate.</div>
        </div>
        <div><label className="label">Default yearly limit (CAD)</label><input className="input" type="number" min="0" step="0.01" value={f.annualLimit} onChange={set('annualLimit')} /></div>
        {f.rule === 'no_restore' && <div><label className="label">% of last year’s earned income (optional)</label><input className="input" type="number" min="0" max="100" step="0.1" value={f.incomePct} onChange={set('incomePct')} placeholder="e.g. 18" /></div>}
        {f.rule === 'lifetime_cap' && (
          <>
            <div><label className="label">Lifetime cap</label><input className="input" type="number" min="0" step="0.01" value={f.lifetimeCap} onChange={set('lifetimeCap')} /></div>
            <div><label className="label">Max unused room carried forward</label><input className="input" type="number" min="0" step="0.01" value={f.carryCap} onChange={set('carryCap')} /></div>
            <div><label className="label">Contributed before using this app</label><input className="input" type="number" min="0" step="0.01" value={f.lifetimePrior} onChange={set('lifetimePrior')} /></div>
          </>
        )}
        <div className="sm:col-span-2">
          <label className="label">Accounts in this plan</label>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 text-sm">
            {linkable.map((a) => (
              <label key={a.id} className="flex items-center gap-2">
                <input type="checkbox" checked={f.accountIds.includes(a.id)} onChange={(e) => setF({ ...f, accountIds: e.target.checked ? [...f.accountIds, a.id] : f.accountIds.filter((x) => x !== a.id) })} />
                {a.name} <span className="ml-auto text-xs tabular-nums text-slate-500">{cad(a.balance)}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="sm:col-span-2"><label className="label">Notes</label><textarea className="input" rows={2} maxLength={1000} value={f.notes} onChange={set('notes')} /></div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        {plan.id ? <button className="btn-ghost text-sm text-rose-600" onClick={remove}>Delete plan</button> : <span />}
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={!f.name}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
