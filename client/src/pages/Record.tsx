import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { api, type Entry, type Proposal, typeLabel, TYPE_LABELS } from '../api';
import EntryEditor, { entryTotals } from '../components/EntryEditor';
import { AccountSelect, ErrorBox, Notice, PageHeader, useAccounts } from '../components/ui';

const EXAMPLES = [
  'Bought groceries at Walmart for $86.42 using my TD debit card yesterday.',
  'Received $2,000 salary into TD.',
  'Dinner at The Keg for $75 on my MBNA credit card',
  'Paid $900 to my MBNA credit card from TD',
  'Transferred $500 from TD to Wealthsimple Cash',
  'Bought 10 shares of XEQT at $33 in my TFSA from TD',
  'Paid $575 auto loan payment from TD, $500 principal and $75 interest',
  'Spent US$45 on Amazon with my MBNA card',
];

export default function Record() {
  const { accounts } = useAccounts();
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<Entry | null>(null);

  const interpret = async (input = text) => {
    if (!input.trim()) return;
    setBusy(true);
    setError(null);
    setPosted(null);
    try {
      setProposal(await api<Proposal>('/ai/interpret', { body: { text: input } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async (patch: Record<string, unknown>) => {
    if (!proposal) return;
    try {
      setProposal(await api<Proposal>('/ai/rebuild', { body: { interpretation: { ...proposal.interpretation, ...patch }, engine: proposal.engine, rawInput: text } }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const post = async () => {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      const e = await api<Entry>('/journal', { body: proposal.entry });
      setPosted(e);
      setProposal(null);
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const interp = proposal?.interpretation ?? {};
  const totals = proposal ? entryTotals(proposal.entry) : null;

  return (
    <div>
      <PageHeader title="Record a transaction" subtitle="Describe it in plain English. AI interprets it; the accounting engine builds and validates the journal entry; you approve it." />
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row">
          <textarea
            className="input min-h-[72px] flex-1 text-base"
            placeholder='e.g. "Bought groceries at Walmart for $86.42 using my TD debit card yesterday"'
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                interpret();
              }
            }}
          />
          <button className="btn-primary h-fit self-end px-4 py-2" disabled={busy || !text.trim()} onClick={() => interpret()}>
            {busy ? <Loader2 className="animate-spin" size={16} /> : <Sparkles size={16} />} Interpret
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
              onClick={() => {
                setText(ex);
                interpret(ex);
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <ErrorBox error={error} onClose={() => setError(null)} />
        {posted && (
          <Notice tone="success">
            <CheckCircle2 className="mr-1 inline" size={16} /> Posted entry #{posted.id} — {posted.description} ({posted.lines.length} lines).{' '}
            <Link className="underline" to="/journal">
              View journal
            </Link>
          </Notice>
        )}
      </div>

      {proposal && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="card p-5 lg:col-span-1">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Interpretation</h2>
              <span className="badge bg-indigo-50 text-indigo-700">
                <Wand2 size={12} className="mr-1" />
                {proposal.engine === 'llm' ? 'LLM' : 'Built-in parser'} · {(proposal.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <dl className="space-y-2 text-sm">
              <Field label="Type">
                <select className="input" value={interp.transactionType} onChange={(e) => rebuild({ transactionType: e.target.value })}>
                  {Object.entries(TYPE_LABELS)
                    .filter(([k]) => k !== 'manual')
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Date">
                <input type="date" className="input" value={interp.transactionDate ?? ''} onChange={(e) => rebuild({ transactionDate: e.target.value })} />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Field label="Amount">
                    <input type="number" step="0.01" className="input" defaultValue={interp.amount} key={`amt-${interp.amount}`} onBlur={(e) => Number(e.target.value) !== interp.amount && rebuild({ amount: Number(e.target.value) })} />
                  </Field>
                </div>
                <Field label="Currency">
                  <input className="input uppercase" defaultValue={interp.currency} key={`cur-${interp.currency}`} maxLength={3} onBlur={(e) => e.target.value.toUpperCase() !== interp.currency && rebuild({ currency: e.target.value.toUpperCase() })} />
                </Field>
              </div>
              <Field label="Merchant / Payee">
                <input className="input" defaultValue={interp.merchant ?? ''} key={`m-${interp.merchant}`} onBlur={(e) => e.target.value !== (interp.merchant ?? '') && rebuild({ merchant: e.target.value })} />
              </Field>
              {proposal.entry.lines.length > 0 && (
                <p className="pt-1 text-xs text-slate-500">Change any field above to re-run the accounting rules, or edit the journal lines directly.</p>
              )}
              {interp.paymentMethod && <Field label="Payment method"><span>{interp.paymentMethod}</span></Field>}
              {interp.taxAmount ? <Field label="Tax"><span>{interp.taxType} {interp.taxAmount}</span></Field> : null}
              {interp.symbol && (
                <Field label="Security">
                  <span>
                    {interp.quantity ?? '?'} × {interp.symbol} {interp.price ? `@ ${interp.price}` : ''}
                  </span>
                </Field>
              )}
            </dl>
            {proposal.clarifications.length > 0 && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="mb-1 flex items-center gap-1 font-medium">
                  <HelpCircle size={15} /> Please confirm
                </div>
                <ul className="list-disc space-y-1 pl-5">
                  {proposal.clarifications.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {proposal.warnings.length > 0 && (
              <div className="mt-3 space-y-1 text-xs text-slate-600">
                {proposal.warnings.map((w) => (
                  <div key={w} className="flex gap-1">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" /> {w}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-5 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Proposed journal entry · {typeLabel(proposal.entry.transactionType ?? '')}</h2>
              <QuickAccount proposal={proposal} accounts={accounts} onPick={(patch) => rebuild(patch)} />
            </div>
            <EntryEditor entry={proposal.entry} accounts={accounts} onChange={(entry) => setProposal({ ...proposal, entry })} />
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              <div className="mb-1 font-medium">Why this treatment</div>
              <ul className="list-disc space-y-0.5 pl-5">
                {proposal.explanation.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="btn-secondary" onClick={() => setProposal(null)}>
                Discard
              </button>
              <button className="btn-primary" disabled={busy || !totals?.balanced} onClick={post}>
                <CheckCircle2 size={16} /> Approve &amp; post
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function QuickAccount({ proposal, accounts, onPick }: { proposal: Proposal; accounts: ReturnType<typeof useAccounts>['accounts']; onPick: (p: Record<string, unknown>) => void }) {
  const t = proposal.entry.transactionType;
  if (t === 'expense' || t === 'credit_card_purchase' || t === 'refund') {
    return (
      <div className="w-56">
        <AccountSelect accounts={accounts} value={proposal.interpretation.categoryAccountId ?? null} filter={(a) => a.type === 'expense'} placeholder="Change category…" onChange={(id) => onPick({ categoryAccountId: id, category: null })} />
      </div>
    );
  }
  if (t === 'income') {
    return (
      <div className="w-56">
        <AccountSelect accounts={accounts} value={proposal.interpretation.categoryAccountId ?? null} filter={(a) => a.type === 'income'} placeholder="Change category…" onChange={(id) => onPick({ categoryAccountId: id, category: null })} />
      </div>
    );
  }
  return null;
}
