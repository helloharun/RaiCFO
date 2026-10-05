import type { DB } from '../db.js';
import { todayISO } from '../money.js';
import { TRANSACTION_TYPES } from '../types.js';
import { listAccounts } from '../engine/ledger.js';
import type { Interpretation } from './proposal.js';

export interface LlmConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
  baseUrl: string;
}

export function llmConfig(): LlmConfig | null {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY;
  const provider = explicit === 'anthropic' || (!explicit && anthropicKey && !openaiKey) ? 'anthropic' : 'openai';
  const apiKey = provider === 'anthropic' ? anthropicKey ?? process.env.LLM_API_KEY : openaiKey;
  if (!apiKey) return null;
  return {
    provider,
    apiKey,
    model: process.env.LLM_MODEL ?? (provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini'),
    baseUrl: process.env.LLM_BASE_URL ?? (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
  };
}

export async function chat(system: string, user: string, json: boolean): Promise<string> {
  const cfg = llmConfig();
  if (!cfg) throw new Error('No LLM configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    if (cfg.provider === 'anthropic') {
      const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: 1500, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  const parsed = extractJson(raw) as Interpretation;
  return { ...parsed, clarifications: Array.isArray(parsed.clarifications) ? parsed.clarifications : [] };
}
