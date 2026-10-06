import type { DB } from '../db.js';
import { todayISO } from '../money.js';
import { TRANSACTION_TYPES } from '../types.js';
import { listAccounts } from '../engine/ledger.js';
import type { Interpretation } from './proposal.js';

export interface LlmConfig {
  provider: 'groq' | 'openai' | 'anthropic';
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

/** Resolves the LLM provider from environment variables (server/.env). Groq is preferred when GROQ_API_KEY is set. */
export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const explicit = env.LLM_PROVIDER?.toLowerCase().trim();
  if (explicit === 'none') return null;
  const timeoutMs = Math.min(Math.max(Number(env.LLM_TIMEOUT_SECONDS) || 30, 5), 300) * 1000;
  const keys = { groq: env.GROQ_API_KEY?.trim(), openai: env.OPENAI_API_KEY?.trim(), anthropic: env.ANTHROPIC_API_KEY?.trim() };
  const provider = (explicit && explicit in keys ? explicit : keys.groq ? 'groq' : keys.openai ? 'openai' : keys.anthropic ? 'anthropic' : null) as LlmConfig['provider'] | null;
  if (!provider || !keys[provider]) return null;
  const defaults = {
    groq: { model: env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile', baseUrl: env.GROQ_BASE_URL?.trim() || 'https://api.groq.com/openai/v1' },
    openai: { model: env.LLM_MODEL?.trim() || 'gpt-4o-mini', baseUrl: env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1' },
    anthropic: { model: env.LLM_MODEL?.trim() || 'claude-3-5-sonnet-latest', baseUrl: env.LLM_BASE_URL?.trim() || 'https://api.anthropic.com' },
  }[provider];
  return { provider, apiKey: keys[provider]!, timeoutMs, ...defaults };
}

/** Strips anything that looks like a credential from upstream error text before it is surfaced. */
function scrub(s: string) {
  return s.replace(/(gsk_|sk-|sk-ant-)[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 200);
}

export async function chat(system: string, user: string, json: boolean): Promise<string> {
  const cfg = llmConfig();
  if (!cfg) throw new Error('No LLM configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    if (cfg.provider === 'anthropic') {
      const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: 1500, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`LLM error ${res.status}: ${scrub(await res.text())}`);
      const data = (await res.json()) as { content: Array<{ text?: string }> };
      return data.content.map((c) => c.text ?? '').join('');
    }
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${scrub(await res.text())}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(s: string): unknown {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('LLM did not return JSON');
  return JSON.parse(s.slice(start, end + 1));
}

/** Asks the LLM to interpret text into a structured Interpretation. The LLM never produces journal lines. */
export async function llmInterpret(db: DB, text: string, today = todayISO()): Promise<Interpretation> {
  const accounts = listAccounts(db, false).map((a) => ({ id: a.id, name: a.name, type: a.type, subtype: a.subtype, currency: a.currency }));
  const system = `You interpret personal-finance transactions described in natural language for a double-entry accounting system.
Return ONLY a JSON object with these keys (use null when unknown, never invent amounts):
transactionDate (YYYY-MM-DD; today is ${today}), amount (number, total), currency (ISO code, default CAD),
merchant, transactionType (one of: ${TRANSACTION_TYPES.join(', ')}),
categoryAccountId (id of the income/expense account, or for reimbursement the expense or receivable account),
paymentAccountId (account money comes FROM: bank/card paying an expense, source of a transfer, loan for loan_proceeds, investment account for investment_sale, asset being sold),
destinationAccountId (account money goes TO: receiving bank for income, target of transfer, credit card being paid, loan being paid, investment account for purchases, asset bought, account for opening_balance/adjustment),
paymentMethod, principal, interest, fees, quantity, symbol, price, costBasis, taxAmount, taxType, direction ("increase"|"decrease" for adjustments),
description (short ledger description), notes, confidence (0-1), clarifications (array of questions to ask the user when information is ambiguous or missing).
Rules: paying a credit card is credit_card_payment (not an expense). Moving money between own accounts is transfer. Buying shares is investment_purchase. Loan payments should split principal and interest when stated.
Accounts: ${JSON.stringify(accounts)}`;
  const raw = await chat(system, text, true);
  return sanitizeInterpretation(extractJson(raw));
}

/** LLM output is untrusted: keep only primitive fields with bounded sizes. Journal lines are always built by the deterministic engine. */
export function sanitizeInterpretation(raw: unknown): Interpretation {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw).slice(0, 60)) {
      if (!/^[A-Za-z]{1,40}$/.test(k) || k === 'clarifications') continue;
      if (typeof v === 'string') out[k] = v.slice(0, 300);
      else if (typeof v === 'number') out[k] = Number.isFinite(v) && Math.abs(v) < 1e12 ? v : null;
      else if (typeof v === 'boolean' || v === null) out[k] = v;
    }
    const c = (raw as { clarifications?: unknown }).clarifications;
    out.clarifications = Array.isArray(c) ? c.filter((x) => typeof x === 'string').slice(0, 5).map((x: string) => x.slice(0, 300)) : [];
  }
  for (const k of ['categoryAccountId', 'paymentAccountId', 'destinationAccountId']) if (out[k] !== undefined && out[k] !== null && !Number.isInteger(out[k])) out[k] = null;
  if (typeof out.transactionType === 'string' && !(TRANSACTION_TYPES as readonly string[]).includes(out.transactionType)) out.transactionType = 'expense';
  if (typeof out.amount === 'number' && out.amount < 0) out.amount = Math.abs(out.amount);
  return out as Interpretation;
}
