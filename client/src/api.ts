export class ApiError extends Error {}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError((data as { error?: string })?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const cad = (cents: number | null | undefined, opts: { sign?: boolean; currency?: string } = {}) => {
  if (cents === null || cents === undefined) return '—';
  const s = (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: opts.currency ?? 'CAD' });
  return opts.sign && cents > 0 ? `+${s}` : s;
};

export const amt = (n: number) => n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const yearStart = () => `${today().slice(0, 4)}-01-01`;
export const monthStartISO = () => `${today().slice(0, 7)}-01`;

export interface Account {
  id: number;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  subtype: string;
  currency: string;
  parent_id: number | null;
  institution: string | null;
  aliases: string | null;
  description: string | null;
  sort_order: number;
  is_active: number;
  is_system: number;
  balance: number;
  nativeBalance: number;
  hasActivity: boolean;
}

export interface LineInput {
  accountId: number;
  debit?: number;
  credit?: number;
  memo?: string | null;
  symbol?: string | null;
  quantity?: number | null;
}

export interface EntryInput {
  date: string;
  description: string;
  payee?: string | null;
  memo?: string | null;
  transactionType?: string;
  source?: string;
  currency?: string;
  fxRate?: number;
  rawInput?: string | null;
  explanation?: string | null;
  metadata?: Record<string, unknown> | null;
  lines: LineInput[];
}

export interface Entry {
  id: number;
  date: string;
  description: string;
  payee: string | null;
  memo: string | null;
  transaction_type: string;
  source: string;
  currency: string;
  fx_rate: number;
  raw_input: string | null;
  explanation: string | null;
  metadata: string | null;
  reversal_of: number | null;
  reversed_by: number | null;
  created_at: string;
  lines: Array<{
    id: number;
    account_id: number;
    account_name: string;
    account_code: string;
    account_type: string;
    debit: number;
    credit: number;
    original_debit: number;
    original_credit: number;
    memo: string | null;
    symbol: string | null;
    quantity: number | null;
    cleared: number;
  }>;
}

export interface Proposal {
  interpretation: Record<string, any>;
  entry: EntryInput;
  explanation: string[];
  clarifications: string[];
  warnings: string[];
  confidence: number;
  balanced: boolean;
  engine: 'rules' | 'llm';
}

export const TYPE_LABELS: Record<string, string> = {
  income: 'Income', expense: 'Expense', transfer: 'Transfer', credit_card_purchase: 'Credit-card purchase', credit_card_payment: 'Credit-card payment',
  loan_payment: 'Loan payment', loan_proceeds: 'Loan proceeds', investment_purchase: 'Investment purchase', investment_sale: 'Investment sale',
  dividend: 'Dividend', interest: 'Interest', asset_purchase: 'Asset purchase', asset_sale: 'Asset sale', liability_increase: 'Liability increase',
  liability_reduction: 'Liability reduction', refund: 'Refund', reimbursement: 'Reimbursement', owner_contribution: 'Owner contribution',
  owner_withdrawal: 'Owner withdrawal', adjustment: 'Adjustment', opening_balance: 'Opening balance', manual: 'Manual entry',
};

export const typeLabel = (t: string) => TYPE_LABELS[t] ?? t.replace(/_/g, ' ');
export const subtypeLabel = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
