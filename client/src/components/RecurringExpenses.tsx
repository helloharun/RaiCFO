import { useState } from 'react';
import { EyeOff } from 'lucide-react';
import { api, cad } from '../api';
import { Empty, ErrorBox, Tabs, useApi } from './ui';

interface Item { key: string; label: string; kind: 'fixed' | 'habit'; detail: string; monthly: number; annual: number; lastDate: string }
interface Data {
  monthsAnalyzed: number; incomeMonthly: number; fixed: Item[]; habit: Item[];
  fixedMonthly: number; habitMonthly: number; debtMonthly: number; totalMonthly: number; leftoverMonthly: number; hiddenCount: number;
}

/** "What a normal month costs" — recurring expenses detected from the ledger. */
export default function RecurringExpenses() {
  const { data, reload, error } = useApi<Data>('/planning/recurring-expenses');
  const [annual, setAnnual] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const amt = (m: number) => cad(annual ? m * 12 : m);
  const hide = async (key: string) => {
    try {
      await api('/planning/recurring-expenses/hidden', { method: 'PUT', body: { key, hidden: true } });
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const restoreAll = async () => {
    try {
      await api('/planning/recurring-expenses/hidden', { method: 'PUT', body: { key: '*', hidden: false } });
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const rows = (list: Item[]) =>
    list.map((i) => (
      <tr key={i.key}>
        <td>
          <div className="font-medium">{i.label}</div>
          <div className="text-xs text-slate-500">{i.detail}{i.kind === 'fixed' ? ` · last ${i.lastDate}` : ''}</div>
        </td>
        <td className="num">{amt(i.monthly)}</td>
        <td className="w-8 text-right">
          <button className="btn-ghost px-1 text-slate-400" onClick={() => hide(i.key)} title="Hide this item" aria-label={`Hide ${i.label}`}>
            <EyeOff size={14} />
          </button>
        </td>
      </tr>
    ));
  return (
    <div className="card overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="text-sm font-semibold">What a normal month costs</div>
        <Tabs tabs={[['m', 'Monthly'], ['a', 'Annual']]} value={annual ? 'a' : 'm'} onChange={(v) => setAnnual(v === 'a')} />
      </div>
      <ErrorBox error={err || error} onClose={() => setErr(null)} />
      {data && (
        <>
          <table className="table">
            <tbody>
              {data.fixed.length > 0 && (
                <>
                  <tr className="bg-slate-50"><td colSpan={2} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Fixed payments</td><td /></tr>
                  {rows(data.fixed)}
                </>
              )}
              {data.habit.length > 0 && (
                <>
                  <tr className="bg-slate-50"><td colSpan={2} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Everyday spending (averages)</td><td /></tr>
                  {rows(data.habit)}
                </>
              )}
              {data.debtMonthly > 0 && (
                <tr>
                  <td>
                    <div className="font-medium">Debt payments</div>
                    <div className="text-xs text-slate-500">average paid into loan & card accounts</div>
                  </td>
                  <td className="num">{amt(data.debtMonthly)}</td>
                  <td />
                </tr>
              )}
              {!data.fixed.length && !data.habit.length && !data.debtMonthly && (
                <tr><td colSpan={3}><Empty>Not enough history yet — recurring payments appear after ~3 steady occurrences.</Empty></td></tr>
              )}
            </tbody>
          </table>
          <div className="space-y-1 border-t px-4 py-3 text-sm">
            <div className="flex justify-between font-semibold"><span>Total typical {annual ? 'year' : 'month'}</span><span className="tabular-nums">{amt(data.totalMonthly)}</span></div>
            <div className="flex justify-between text-slate-600"><span>Average income ({data.monthsAnalyzed} months)</span><span className="tabular-nums">{amt(data.incomeMonthly)}</span></div>
            <div className={`flex justify-between font-semibold ${data.leftoverMonthly < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
              <span>{data.leftoverMonthly < 0 ? 'Shortfall — break-even needs more income' : 'Left over after typical spending'}</span>
              <span className="tabular-nums">{cad(Math.abs(annual ? data.leftoverMonthly * 12 : data.leftoverMonthly))}</span>
            </div>
            <div className="pt-1 text-[11px] text-slate-400">
              Detected from your ledger over the last {Math.round(data.monthsAnalyzed)} months — nothing entered by hand.
              {data.hiddenCount > 0 && <button className="ml-1 text-indigo-600 underline" onClick={restoreAll}>{data.hiddenCount} hidden — restore</button>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
