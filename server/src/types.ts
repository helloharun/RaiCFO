export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  currency: string;
  parent_id: number | null;
  institution: string | null;
  aliases: string | null;
  description: string | null;
  sort_order: number;
  is_active: number;
  is_system: number;
  interest_rate?: number | null;
  min_payment?: number | null;
}

export interface LineInput {
  accountId: number;
  debit?: number;
  credit?: number;
  memo?: string | null;
  securityId?: number | null;
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
  importHash?: string | null;
  recurringId?: number | null;
  lines: LineInput[];
}

export const TRANSACTION_TYPES = [
  'income', 'expense', 'transfer', 'credit_card_purchase', 'credit_card_payment', 'loan_payment',
  'loan_proceeds', 'investment_purchase', 'investment_sale', 'dividend', 'interest', 'asset_purchase',
  'asset_sale', 'liability_increase', 'liability_reduction', 'refund', 'reimbursement',
  'owner_contribution', 'owner_withdrawal', 'adjustment', 'opening_balance',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const SUBTYPES: Record<AccountType, string[]> = {
  asset: ['cash', 'bank', 'savings', 'investment', 'tfsa', 'rrsp', 'other_investment', 'vehicle', 'property', 'personal_asset', 'accounts_receivable', 'other_asset'],
  liability: ['credit_card', 'line_of_credit', 'personal_loan', 'auto_loan', 'student_loan', 'mortgage', 'accounts_payable', 'other_liability'],
  equity: ['opening_balance_equity', 'owner_contribution', 'owner_withdrawal', 'accumulated_equity', 'current_earnings'],
  income: ['employment', 'business', 'freelance', 'interest', 'dividend', 'capital_gains', 'other_income'],
  expense: ['housing', 'rent', 'mortgage_interest', 'utilities', 'groceries', 'restaurants', 'transportation', 'gas', 'public_transit', 'vehicle_maintenance', 'vehicle_insurance', 'health', 'insurance', 'phone', 'internet', 'entertainment', 'shopping', 'clothing', 'education', 'professional', 'bank_fees', 'interest_expense', 'taxes', 'subscriptions', 'travel', 'gifts', 'other_expense'],
};

export const CASH_SUBTYPES = ['cash', 'bank', 'savings'];
export const INVESTMENT_SUBTYPES = ['investment', 'tfsa', 'rrsp', 'other_investment'];
export const LOAN_SUBTYPES = ['line_of_credit', 'personal_loan', 'auto_loan', 'student_loan', 'mortgage', 'other_liability'];

export function isDebitNormal(type: AccountType): boolean {
  return type === 'asset' || type === 'expense';
}

export class ValidationError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
  }
}
