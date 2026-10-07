import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Plus, Search, Tags, Trash2, X } from 'lucide-react';
import { api, cad } from '../api';
import { AccountSelect, DateRange, Empty, ErrorBox, Modal, Money, PageHeader, Stat, presetRange, useAccounts, useApi } from '../components/ui';

type GroupBy = 'day' | 'week' | 'month' | 'year';
interface Bucket { start: string; end: string; label: string; amount: number; debit: number; credit: number; count: number; balance?: number }
interface Trend {
  from: string; to: string; groupBy: GroupBy; mode: 'spending' | 'account'; q: string | null; merchant: string | null; matchedTerms: string[];
  account: { id: number; name: string; type: string } | null;
  total: number; count: number; avgPerPeriod: number; avgPerTransaction: number; activePeriods: number;
  openingBalance: number | null; closingBalance: number | null;
  buckets: Bucket[];
  byCategory: Array<{ name: string; amount: number }>;
  byMerchant: Array<{ name: string; amount: number; count: number }>;
  transactions: Array<{ id: number; date: string; description: string; payee: string | null; merchant: string | null; memo: string | null; accounts: string[]; amount: number }>;
  truncated: boolean;
}
interface Merchants {
  merchants: Array<{ name: string; amount: number; count: number; avgPerVisit: number; lastDate: string; categories: string[] }>;
  merchantCount: number; unattributed: number;
  tags: Array<{ tag: string; amount: number; count: number }>;
}
interface Group { name: string; aliases: string[] }

const GROUPS: Array<[GroupBy, string]> = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const PER: Record<GroupBy, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };

export default function Insights() {
  const [params, setParams] = useSearchParams();
  const def = presetRange('last-12');
  const q = params.get('q') ?? '';
  const accountId = params.get('accountId') ? Number(params.get('accountId')) : null;
  const groupBy = (params.get('groupBy') as GroupBy) || 'month';
  const from = params.get('from') ?? def.from;
  const to = params.get('to') ?? def.to;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    const t = setTimeout(() => text !== q && set({ q: text.trim() || null }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const { accounts } = useAccounts();
  const qs = new URLSearchParams({ from, to, groupBy, ...(q ? { q } : {}), ...(accountId ? { accountId: String(accountId) } : {}) }).toString();
  const { data: tr, error } = useApi<Trend>(`/insights/trend?${qs}`, [qs]);
  const { data: ms } = useApi<Merchants>(`/insights/merchants?from=${from}&to=${to}`, [from, to]);
  const [editGroups, setEditGroups] = useState(false);

  const filtered = Boolean(q || accountId);
  const isBalance = tr?.mode === 'account' && tr.openingBalance !== null;
  const title = tr?.merchant ?? (q ? `“${q}”` : tr?.account?.name ?? 'All spending');
  const chartData = useMemo(() => (tr?.buckets ?? []).map((b) => ({ label: b.label, amount: b.amount / 100, balance: b.balance === undefined ? undefined : b.balance / 100 })), [tr]);

  return (
    <div>
      <PageHeader
        title="Insights"
        subtitle="Explore spending by merchant, memo keyword, #tag or account — daily, weekly, monthly or yearly."
        actions={<button className="btn-secondary" onClick={() => setEditGroups(true)}><Tags size={15} /> Merchant groups</button>}
      />
      <ErrorBox error={error} />
      <div className="card mb-4 grid gap-2 p-3 md:grid-cols-12">
        <div className="relative md:col-span-4">
          <Search size={15} className="absolute left-2.5 top-3 text-slate-400 md:top-2.5" />
          <input className="input pl-8 pr-8" list="pfhq-merchants" placeholder="Merchant, memo word or #tag (e.g. Tims)" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="search" />
          {text && <button className="absolute right-2 top-2.5 text-slate-400 md:top-2" aria-label="Clear" onClick={() => (setText(''), set({ q: null }))}><X size={16} /></button>}
          <datalist id="pfhq-merchants">
            {ms?.merchants.map((m) => <option key={m.name} value={m.name} />)}
            {ms?.tags.map((t) => <option key={t.tag} value={t.tag} />)}
          </datalist>
        </div>
        <div className="md:col-span-3">
          <AccountSelect accounts={accounts} value={accountId} allowEmpty placeholder="All expense accounts" onChange={(id) => set({ accountId: id ? String(id) : null })} />
        </div>
        <div className="seg md:col-span-5" role="group" aria-label="Group by">
          {GROUPS.map(([k, label]) => <button key={k} aria-pressed={groupBy === k} onClick={() => set({ groupBy: k })}>{label}</button>)}
        </div>
        <div className="md:col-span-12">
          <DateRange from={from} to={to} onChange={(r) => set({ from: r.from, to: r.to })} />
        </div>
      </div>

      {tr && (
        <>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{title}</h2>
            <div className="text-xs text-slate-500">
              {tr.from} → {tr.to}
              {tr.merchant && tr.matchedTerms.length > 1 && <> · also matches {tr.matchedTerms.filter((t) => t !== tr.merchant!.toLowerCase()).slice(0, 6).join(', ')}</>}
            </div>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {isBalance ? (
              <>
                <Stat label="Opening balance" value={cad(tr.openingBalance)} />
                <Stat label="Closing balance" value={cad(tr.closingBalance)} />
                <Stat label="Net change" value={cad(tr.total, { sign: true })} />
                <Stat label="Transactions" value={tr.count} sub={`${tr.activePeriods} active ${PER[groupBy]}s`} />
              </>
            ) : (
              <>
                <Stat label={tr.mode === 'account' && tr.account?.type === 'income' ? 'Total earned' : 'Total spent'} value={cad(tr.total)} />
                <Stat label={`Average per ${PER[groupBy]}`} value={cad(tr.avgPerPeriod)} sub={`${tr.buckets.length} ${PER[groupBy]}s in range`} />
                <Stat label="Transactions" value={tr.count} sub={`${tr.activePeriods} active ${PER[groupBy]}s`} />
                <Stat label="Average per transaction" value={cad(tr.avgPerTransaction)} />
              </>
            )}
          </div>

          <div className="card mb-4 p-3 md:p-5">
            <div className="h-64 md:h-72">
              <ResponsiveContainer>
                <ComposedChart data={chartData} margin={{ left: -10, right: 4, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={18} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v).toLocaleString()}`} />
                  <Tooltip formatter={(v) => cad(Math.round(Number(v) * 100))} />
                  <Bar dataKey="amount" name={isBalance ? 'Net change' : 'Amount'} fill="#6366f1" radius={[4, 4, 0, 0]} />
                  {isBalance && <Line dataKey="balance" name="Balance" stroke="#059669" strokeWidth={2} dot={false} />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-3">
            <div className="card lg:col-span-1">
              <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">By {PER[groupBy]}</div>
              <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm">
                {[...tr.buckets].reverse().filter((b) => b.count).map((b) => (
                  <li key={b.start} className="flex justify-between px-4 py-2">
                    <span>{b.label} <span className="text-xs text-slate-400">×{b.count}</span></span>
                    <span className="text-right"><Money cents={b.amount} />{b.balance !== undefined && <div className="text-xs text-slate-400">bal {cad(b.balance)}</div>}</span>
                  </li>
                ))}
              </ul>
              {!tr.activePeriods && <Empty>No matching activity.</Empty>}
            </div>
            <div className="card">
              <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">By merchant</div>
              <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm">
                {tr.byMerchant.map((m) => (
                  <li key={m.name}>
                    <button className="flex w-full justify-between px-4 py-2 text-left hover:bg-slate-50 disabled:cursor-default" disabled={m.name.startsWith('(')} onClick={() => set({ q: m.name })}>
                      <span className={m.name.startsWith('(') ? 'text-slate-400' : ''}>{m.name} <span className="text-xs text-slate-400">×{m.count}</span></span>
                      <Money cents={m.amount} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">By category</div>
              <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm">
                {tr.byCategory.map((c) => (
                  <li key={c.name} className="flex justify-between px-4 py-2"><span>{c.name}</span><Money cents={c.amount} /></li>
                ))}
              </ul>
            </div>
          </div>

          {filtered ? (
            <div className="card">
              <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Transactions{tr.truncated ? ' (latest 300)' : ''}</div>
              <ul className="divide-y divide-slate-100 text-sm">
                {tr.transactions.map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{t.description}</div>
                      <div className="truncate text-xs text-slate-500">{t.date}{t.merchant ? ` · ${t.merchant}` : ''} · {t.accounts.join(', ')}{t.memo ? ` · ${t.memo}` : ''}</div>
                    </div>
                    <Money cents={t.amount} className="shrink-0" />
                  </li>
                ))}
              </ul>
              {!tr.count && <Empty>No transactions match. Tip: record the merchant (“Coffee at Tims $3.50”) or add a #tag in the memo.</Empty>}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="card lg:col-span-2">
                <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
                  <span className="text-sm font-semibold">Top merchants</span>
                  {ms && <span className="text-xs text-slate-500">{ms.merchantCount} merchants · {cad(ms.unattributed)} with no merchant</span>}
                </div>
                <ul className="divide-y divide-slate-100 text-sm">
                  {ms?.merchants.slice(0, 25).map((m) => (
                    <li key={m.name}>
                      <button className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-50" onClick={() => set({ q: m.name })}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{m.name}</span>
                          <span className="block truncate text-xs text-slate-500">{m.count} visits · {cad(m.avgPerVisit)} avg · {m.categories[0]} · last {m.lastDate}</span>
                        </span>
                        <Money cents={m.amount} className="shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
                {ms && !ms.merchants.length && <Empty>No merchant data yet.</Empty>}
              </div>
              <div className="card">
                <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">#Tags</div>
                <ul className="divide-y divide-slate-100 text-sm">
                  {ms?.tags.map((t) => (
                    <li key={t.tag}>
                      <button className="flex w-full justify-between px-4 py-2.5 text-left hover:bg-slate-50" onClick={() => set({ q: t.tag })}>
                        <span>{t.tag} <span className="text-xs text-slate-400">×{t.count}</span></span>
                        <Money cents={t.amount} />
                      </button>
                    </li>
                  ))}
                </ul>
                {ms && !ms.tags.length && <Empty>Add #tags to a memo (e.g. #coffee, #work-trip) to track them here.</Empty>}
              </div>
            </div>
          )}
        </>
      )}
      {editGroups && <GroupsEditor onClose={() => setEditGroups(false)} />}
    </div>
  );
}

function GroupsEditor({ onClose }: { onClose: () => void }) {
  const { data, setData } = useApi<{ custom: Group[]; builtin: Group[] }>('/insights/merchant-groups');
  const [rows, setRows] = useState<Array<{ name: string; aliases: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setRows(data.custom.map((g) => ({ name: g.name, aliases: g.aliases.join(', ') })));
  }, [data]);
  const save = async () => {
    setError(null);
    try {
      const groups = rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), aliases: r.aliases.split(',').map((a) => a.trim()).filter(Boolean) }));
      setData(await api('/insights/merchant-groups', { method: 'PUT', body: { groups } }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Merchant groups" onClose={onClose} wide>
      <p className="mb-3 text-sm text-slate-500">
        Group nicknames and spellings so they count as one merchant everywhere (Insights, Ask Finance). Matching is on whole words in the payee, description and memo. Your groups override the built-in ones.
      </p>
      <ErrorBox error={error} onClose={() => setError(null)} />
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] gap-2 md:grid-cols-[14rem_1fr_auto]">
            <input className="input" placeholder="Merchant name (e.g. Joe's Diner)" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <button className="btn-ghost md:order-last" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
            <input className="input col-span-2 md:col-span-1" placeholder="Aliases, comma-separated (e.g. joes, the usual spot)" value={r.aliases} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, aliases: e.target.value } : x)))} />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-secondary" onClick={() => setRows([...rows, { name: '', aliases: '' }])}><Plus size={15} /> Add group</button>
        <button className="btn-primary" onClick={save}>Save groups</button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
      <details className="mt-5 text-sm">
        <summary className="cursor-pointer text-slate-600">Built-in groups ({data?.builtin.length ?? 0})</summary>
        <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto text-xs text-slate-500">
          {data?.builtin.map((g) => <li key={g.name}><b className="text-slate-700">{g.name}</b>: {g.aliases.join(', ')}</li>)}
        </ul>
      </details>
    </Modal>
  );
}
