import { useState } from 'react';
import { Bot, Loader2, Send, User } from 'lucide-react';
import { api } from '../api';
import { PageHeader, useApi } from '../components/ui';

const SUGGESTIONS = [
  'What is my net worth?',
  'How much did I spend on groceries last month?',
  'What are my top expenses this year?',
  'What is my savings rate this year?',
  'Am I over budget this month?',
  'How much do I owe?',
  'How much did I spend on restaurants in the last 3 months?',
];

export default function Ask() {
  const { data: meta } = useApi<{ ai: { enabled: boolean } }>('/meta');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Array<{ role: 'user' | 'ai'; text: string; engine?: string }>>([]);
  const send = async (question = q) => {
    if (!question.trim()) return;
    setMsgs((m) => [...m, { role: 'user', text: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api<{ answer: string; engine: string }>('/ask', { body: { question } });
      setMsgs((m) => [...m, { role: 'ai', text: r.answer, engine: r.engine }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'ai', text: `Error: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="Ask Finance" subtitle={`Your AI financial analyst — answers are computed from the ledger. ${meta?.ai.enabled ? 'Using LLM.' : 'Using built-in analyst (add an LLM key for open-ended questions).'}`} />
      <div className="card flex h-[65vh] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {!msgs.length && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm hover:border-indigo-300" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {m.role === 'ai' && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
                  <Bot size={16} />
                </div>
              )}
              <div className={`max-w-[75%] whitespace-pre-wrap rounded-xl px-4 py-2.5 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-slate-100'}`}>{m.text}</div>
              {m.role === 'user' && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200">
                  <User size={16} />
                </div>
              )}
            </div>
          ))}
          {busy && <Loader2 className="animate-spin text-slate-400" />}
        </div>
        <div className="flex gap-2 border-t p-3">
          <input className="input" placeholder="Ask about your finances…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button className="btn-primary" disabled={busy || !q.trim()} onClick={() => send()}>
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
