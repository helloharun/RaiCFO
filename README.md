# Personal Finance HQ

AI-assisted **double-entry** personal accounting: describe transactions in plain English, review the proposed journal entry, and post it to a real general ledger that drives every statement, chart, and answer.

```
Natural language → AI interpretation → structured proposal → deterministic rules & validation
  → double-entry journal entry → general ledger → statements / dashboard / analytics / Ask Finance
```

**The AI interprets; the accounting engine controls the books.** The AI (LLM or the built-in parser) only produces a structured interpretation. Journal lines are built by deterministic rules (`server/src/ai/proposal.ts`) and every entry is validated (`server/src/engine/ledger.ts`) before posting — unbalanced entries are rejected, posted entries are never deleted (corrections are reversals), and every change is written to the audit log.

## Features
- Record transactions in natural language with editable proposals, explanations, and clarification prompts (income, expenses, transfers, credit-card purchases/payments, loan proceeds/payments with principal/interest split, investment buys/sells with gains, dividends, interest, asset purchases/sales, refunds, reimbursements, owner contributions/withdrawals, opening balances, adjustments, foreign currency, sales tax).
- Chart of accounts (create, edit, reorder, deactivate; accounts with history can't be deleted).
- Journal with search/filters, manual entries, edit (reverse + repost), reversal, CSV export.
- Statements with "as of" dates: Balance Sheet, Income Statement, Cash Flow, Changes in Equity, Net Worth (book & market), Trial Balance, General Ledger.
- Dashboard, budgets (defaults + monthly overrides), investments (average-cost holdings, market prices), reconciliation, CSV import with duplicate detection, recurring transactions, learned merchant rules, multi-currency (CAD base), period lock date, audit trail.
- Ask Finance: questions answered from ledger data.

## Run
Requires Node.js 20+.
```bash
npm install
npm run build      # builds server + client
npm start          # http://localhost:4000 (serves API + UI)
```
Development (hot reload): `npm run dev` → UI on http://localhost:5173, API on :4000.

Tests / checks: `npm test`, `npm run typecheck`.

Load sample data from the empty dashboard ("Load demo data") or `npm run seed:demo -w server`.

Data is stored in SQLite at `server/data/finance.db` (override with `DB_PATH`). If you switch Node versions, run `npm rebuild better-sqlite3`.

## Optional LLM
Create `server/.env`:
```
OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY=...
# LLM_MODEL=gpt-4o-mini   LLM_BASE_URL=https://...   LLM_PROVIDER=openai|anthropic
```
Without a key, the built-in deterministic parser and analyst are used.
