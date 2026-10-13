import { Fragment } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChevronRight, List, Paperclip } from 'lucide-react';
import { cad, subtypeLabel, type Account } from '../api';
import { DateRange, Empty, ErrorBox, Money, PageHeader, Stat, presetRange, useAccounts, useApi } from '../components/ui';

const TITLES: Record<Account['type'], string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };
const BALANCE_TYPES: Account['type'][] = ['asset', 'liability', 'equity'];
const NO_MERCHANT = '(no merchant recorded)';

interface Trend {
  total: number;
  count: number;
  avgPerTransaction: number;
  byMerchant: Array<{ name: string; amount: number; count: number }>;
  balanceByMerchant: Array<{ name: string; balance: number; count: number; lastDate: string }> | null;
  transactions: Array<{ id: number; date: string; description: string; payee: string | null; merchant: string | null; memo: string | null; accounts: string[]; otherAccounts: string[]; attachments: number; amount: number }>;
  truncated: boolean;
}

function Crumbs({ items }: { items: Array<[string, string | null]> }) {
  return (
    <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm text-slate-500">
      {items.map(([label, to], i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight size={14} className="text-slate-300" />}
          {to ? <Link to={to} className="hover:text-indigo-600 hover:underline">{label}</Link> : <span className="font-medium text-slate-700">{label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

function Row({ to, title, sub, cents, muted = false }: { to: string; title: string; sub?: string; cents: number; muted?: boolean }) {
  return (
    <li>
      <Link to={to} className="flex min-h-[3.25rem] items-center justify-between gap-3 px-4 py-2.5 hover:bg-slate-50 active:bg-slate-100">
        <span className="min-w-0">
          <span className={`block truncate ${muted ? 'text-slate-400' : 'font-medium'}`}>{title}</span>
          {sub && <span className="block truncate text-xs text-slate-500">{sub}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Money cents={cents} className="font-semibold" />
          <ChevronRight size={16} className="text-slate-300" />
        </span>
      </Link>
    </li>
  );
}

const sortAccounts = (list: Account[]) => list.sort((x, y) => x.sort_order - y.sort_order || x.code.localeCompare(y.code));

/** Level 1: every account of one type with its current balance. */
export function AccountTypeView() {
  const { type } = useParams();
  const { accounts } = useAccounts();
  const t = type as Account['type'];
  if (!TITLES[t]) return <Empty>Unknown account type.</Empty>;
  const list = sortAccounts(accounts.filter((a) => a.type === t && (a.is_active || a.balance !== 0)));
  const total = list.reduce((s, a) => s + a.balance, 0);
  return (
    <div>
      <Crumbs items={[['Accounts', '/accounts'], [TITLES[t], null]]} />
      <PageHeader title={TITLES[t]} subtitle={`Total ${cad(total)} · tap an account to see where the money went.`} />
      <div className="card">
        <ul className="divide-y divide-slate-100 text-sm">
          {list.map((a) => (
            <Row key={a.id} to={`/accounts/${a.id}`} title={`${a.parent_id ? '↳ ' : ''}${a.name}`} sub={`${a.code} · ${subtypeLabel(a.subtype)}${a.institution ? ` · ${a.institution}` : ''}`} cents={a.balance} muted={!a.is_active} />
          ))}
        </ul>
        {!list.length && <Empty>No accounts of this type.</Empty>}
      </div>
    </div>
  );
}

/** Level 2 (payees/merchants of one account) and level 3 (transactions of one payee). */
export function AccountView() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { accounts } = useAccounts();
  const account = accounts.find((a) => a.id === Number(id));
  const all = presetRange('all');
  const from = params.get('from') ?? all.from;
  const to = params.get('to') ?? all.to;
  const merchant = params.get('merchant');
  const showAll = params.get('view') === 'all';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v !== null ? next.set(k, v) : next.delete(k));
    setParams(next);
  };
  const qs = new URLSearchParams({ accountId: String(Number(id)), from, to, groupBy: 'year', ...(merchant !== null ? { merchant } : {}) }).toString();
  const { data: tr, error } = useApi<Trend>(`/insights/trend?${qs}`, [qs]);

  if (!account) return accounts.length ? <Empty>Account not found.</Empty> : null;
  const isBal = BALANCE_TYPES.includes(account.type);
  const isAllTime = from === all.from && to === all.to;
  const children = sortAccounts(accounts.filter((a) => a.parent_id === account.id));
  const groups = (isBal ? tr?.balanceByMerchant?.map((m) => ({ name: m.name, amount: m.balance, count: m.count, last: m.lastDate as string | undefined })) : tr?.byMerchant.map((m) => ({ ...m, last: undefined as string | undefined }))) ?? [];
  const label = (n: string) => (n === NO_MERCHANT ? 'No payee / merchant recorded' : n);
  const groupHeading = account.type === 'liability' ? 'Owed to (by lender / payee)' : account.type === 'expense' ? 'Where you spent (by merchant)' : account.type === 'income' ? 'Received from' : 'By payee';
  const listing = merchant !== null || showAll;
  const outstanding = merchant !== null && isBal ? tr?.balanceByMerchant?.[0]?.balance ?? 0 : null;
  const linkFor = (name: string) => {
    const n = new URLSearchParams(params);
    n.set('merchant', name);
    n.delete('view');
    return `/accounts/${account.id}?${n.toString()}`;
  };

  return (
    <div>
      <Crumbs
        items={[
          ['Accounts', '/accounts'],
          [TITLES[account.type], `/accounts/type/${account.type}`],
          [account.name, listing ? `/accounts/${account.id}${from !== all.from || to !== all.to ? `?from=${from}&to=${to}` : ''}` : null],
          ...(listing ? ([[merchant !== null ? label(merchant) : 'All transactions', null]] as Array<[string, string | null]>) : []),
        ]}
      />
      <PageHeader
        title={merchant !== null ? label(merchant) : account.name}
        subtitle={merchant !== null ? `${account.name} · ${account.code}` : `${account.code} · ${subtypeLabel(account.subtype)}${account.institution ? ` · ${account.institution}` : ''}`}
        actions={<DateRange from={from} to={to} onChange={(r) => set({ from: r.from, to: r.to })} />}
      />
      <ErrorBox error={error} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {merchant === null && <Stat label="Current balance" value={cad(account.balance)} />}
        {outstanding !== null && <Stat label={account.type === 'liability' ? `Still owed (as of ${to})` : `Balance (as of ${to})`} value={cad(outstanding)} />}
        {tr && <Stat label={isAllTime ? (isBal ? 'Net change, all time' : 'Total, all time') : isBal ? 'Net change in range' : 'Total in range'} value={cad(tr.total)} />}
        {tr && <Stat label="Transactions" value={String(tr.count)} />}
        {tr && merchant !== null && <Stat label="Average per transaction" value={cad(tr.avgPerTransaction)} />}
      </div>

      {!listing && children.length > 0 && (
        <div className="card mb-4">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Sub-accounts</div>
          <ul className="divide-y divide-slate-100 text-sm">
            {children.map((c) => <Row key={c.id} to={`/accounts/${c.id}`} title={c.name} sub={c.code} cents={c.balance} muted={!c.is_active} />)}
          </ul>
        </div>
      )}

      {!listing && tr && (
        <div className="card">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-semibold">{groupHeading}{isBal ? ` · as of ${to}` : ''}</span>
            <button className="btn-ghost text-xs" onClick={() => set({ view: 'all', merchant: null })}><List size={14} /> All transactions</button>
          </div>
          <ul className="divide-y divide-slate-100 text-sm">
            {groups.map((g) => (
              <Row key={g.name} to={linkFor(g.name)} title={label(g.name)} muted={g.name === NO_MERCHANT} sub={`${g.count} transaction${g.count === 1 ? '' : 's'}${g.last ? ` · last ${g.last}` : ''}`} cents={g.amount} />
            ))}
          </ul>
          {!groups.length && <Empty>{isBal ? 'Nothing outstanding on this account.' : 'No activity in this range.'}</Empty>}
          {groups.some((g) => g.name === NO_MERCHANT) && <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">To attribute these, open the entries and fill in Payee / merchant (Edit in the Journal).</div>}
        </div>
      )}

      {listing && tr && (
        <div className="card">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Transactions{tr.truncated ? ' (latest 300)' : ''}</div>
          <ul className="divide-y divide-slate-100 text-sm">
            {tr.transactions.map((t) => (
              <li key={t.id}>
                <Link to={`/journal?entry=${t.id}`} className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-slate-50 active:bg-slate-100">
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {t.attachments > 0 && <Paperclip size={13} className="mr-1 inline text-slate-400" aria-label={`${t.attachments} attachments`} />}
                      {t.description}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {t.date} · #{t.id}{t.payee ? ` · ${t.payee}` : ''}
                    </span>
                    {t.memo && <span className="block text-xs text-slate-600">{t.memo}</span>}
                    {t.otherAccounts.length > 0 && <span className="block truncate text-xs text-slate-400">{account.type === 'expense' ? 'Paid with' : 'Other side'}: {t.otherAccounts.join(', ')}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Money cents={t.amount} className="font-semibold" />
                    <ChevronRight size={16} className="text-slate-300" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {!tr.count && <Empty>No transactions in this range.</Empty>}
        </div>
      )}
    </div>
  );
}
