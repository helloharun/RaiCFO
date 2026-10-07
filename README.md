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

## Quick start
Requires Node.js 20+ and a PostgreSQL database (e.g. a free [Supabase](https://supabase.com) project, or a local Postgres).
```bash
npm install
cp server/.env.example server/.env
# set DATABASE_URL in server/.env (tables are created automatically on first start)
npm run gen-secret -w server          # paste into SESSION_SECRET
npm run hash-password -w server       # paste the APP_PASSWORD_HASH line into server/.env
# set APP_USERNAME (and optionally GROQ_API_KEY) in server/.env
npm run build                         # builds server + client
npm start                             # http://127.0.0.1:4000
```
Development (hot reload): `npm run dev` → UI on http://localhost:5173 (proxies /api to :4000). For plain-http local use set `NODE_ENV=development` or `COOKIE_SECURE=false`.

Checks: `npm run typecheck`, and `TEST_DATABASE_URL=postgres://… npm test` against a **disposable** Postgres database (each test run uses its own temporary schema and drops it afterwards).

## Configuration (`server/.env`)
All settings and secrets live in `server/.env` (git-ignored); `server/.env.example` documents every option. The server refuses to start if required values are missing or weak.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase: Project Settings → Database → Connection string → URI). Required. |
| `DATABASE_SSL`, `DATABASE_CA_CERT`, `DATABASE_POOL_MAX` | TLS is on automatically for any non-localhost host (`auto`); `verify-full` + CA cert for strict verification. Pool size defaults to 5. |
| `APP_USERNAME`, `APP_PASSWORD_HASH` (or `APP_PASSWORD`) | The single login. There is no sign-up page. Changing them signs out all sessions. |
| `SESSION_SECRET` | ≥32 random chars. Rotating it signs out all sessions. |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | Idle and absolute session timeouts. |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES` | Brute-force lockout per IP. |
| `HOST`, `PORT`, `TRUST_PROXY`, `COOKIE_SECURE`, `CORS_ORIGINS` | Network settings. Defaults bind to 127.0.0.1 only. |
| `GROQ_API_KEY`, `GROQ_MODEL`, `LLM_PROVIDER` | AI via Groq (default model `llama-3.3-70b-versatile`). OpenAI/Anthropic also supported. Without a key the built-in parser is used. |
| `BACKUP_ENCRYPTION_KEY` | Enables AES-256-GCM encrypted backup downloads. |
| `ALLOW_DEMO_DATA` | Allow loading sample data into an empty ledger. |

## Planning & data features
- **Goals & financial health**: savings / emergency-fund / debt-payoff / net-worth goals tracked from ledger balances, with required monthly contribution, pace and projected date; health metrics (emergency-fund months, savings rate, debt-to-asset, card debt).
- **Cash-flow forecast & bills**: projected cash balance and upcoming bills/income from recurring transactions, with low-balance warnings.
- **Debt payoff planner**: avalanche vs snowball vs minimum payments, payoff dates and total interest; APR/minimum payment saved per liability account.
- **Data & Security page**: download the journal, general ledger, trial balance and chart of accounts (CSV), the full ledger (JSON), and a complete restorable backup (JSON, optionally encrypted); integrity check of the books; active sessions with "sign out other sessions".
- **Restore**: point `DATABASE_URL` at a new, empty database and run `npm run restore -w server -- <backup.json | backup.json.enc>`. It refuses to overwrite a database that already has journal entries, and verifies the books after restoring. Supabase also keeps its own database backups (depending on your plan).

## Insights, merchants & #tags

- **Insights page** (`/insights`): search a merchant (“Tims”), any memo word, or a `#tag`, and/or pick any account (expense, asset, liability). Group by **day / week / month / year** over any date range (presets: This month, Last month, Last 3 months, YTD, Last 12 months, Last year, All time). Shows total, average per period, average per transaction, a chart, breakdowns by period/merchant/category, and the matching transactions. Asset/liability accounts also show the running balance.
- **Merchant grouping**: payees are normalised — store numbers, card-processor prefixes (`SQ *`, `TST*`) and nicknames are merged (“TIM HORTONS #1234”, “Tims”, “Timmies” → Tim Hortons). Built-in groups cover common Canadian merchants; add your own under **Insights → Merchant groups**. Nothing in the ledger is rewritten — grouping is applied when reading.
- **#tags**: put tags in the memo or in the sentence you type (“Lunch with client at Joe's $42 #work #client-acme”) and they become searchable and totalled in Insights and Ask Finance.
- **Ask Finance** answers merchant/tag questions (“How much am I spending on Tims?”, “What did I spend at Costco last month?”, “Where do I spend the most this year?”). With Groq enabled, the model also receives top merchants, tags and the exact ledger matches for whatever the question mentions.
- Tip: include the merchant when recording (“Coffee at Tims $3.50”) so every transaction has a payee.

## Using it as an iPhone app

Open the deployed URL in **Safari** → Share → **Add to Home Screen**. It launches full-screen with its own icon, a bottom tab bar (Home, Record, Insights, Ask, More), notch/home-indicator safe areas and no input zoom. Sessions use the same secure cookie as the browser; data is always live from the server (no offline copy of your books is stored on the phone).

## Security
- Login with scrypt-hashed password from `.env`; constant-time comparison; generic error messages; per-IP lockout plus global throttling; login and API rate limits.
- Server-side sessions (random 256-bit tokens, stored hashed) in `HttpOnly`, `SameSite=Strict`, `Secure` (`__Host-` prefix in production) cookies; idle + absolute timeouts; logout revokes server-side.
- Every `/api` route except `/api/health` and login requires a session; state-changing requests also require a CSRF token and same-origin `Origin`.
- Helmet security headers with a strict Content-Security-Policy, HSTS (when secure), `no-store` on API responses, no `X-Powered-By`.
- Input validation and size limits on every route; parameterised SQL everywhere; JSON body limit; no internal error details leaked.
- Ledger protection in the database itself: triggers block deleting or truncating journal entries/lines, changing posted amounts, and editing the audit log. Row-level security is enabled on every table and Supabase's public API roles (`anon`, `authenticated`) get no access, so only the server (via `DATABASE_URL`) can read or write your data.
- LLM output treated as untrusted (sanitised, never builds journal lines); API keys are never sent to the browser and are scrubbed from error messages.
- CSV exports neutralise spreadsheet formula injection. Backups never include sessions or secrets.
- Database connections use TLS for remote hosts; the connection string is never logged. `.env` is git-ignored.
- For access from other devices, put the app behind HTTPS (Caddy/nginx) and set `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=1`.

## Deploying on Render (with Supabase)
1. Create a Supabase project and copy its connection string (Project Settings → Database → Connection string → URI; use the **pooler** "Session" URI since Render is IPv4-only). Replace `[YOUR-PASSWORD]` with your database password.
2. Create a Render **Web Service** from this repo:
   - Build command: `npm ci --include=dev && npm run build`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. In the service's **Environment** tab add: `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, `NODE_VERSION=20`, `DATABASE_URL`, `APP_USERNAME`, `APP_PASSWORD_HASH` (no quotes), `SESSION_SECRET`, and optionally `GROQ_API_KEY` and `BACKUP_ENCRYPTION_KEY`. Don't set `PORT`. No disk is needed: all data lives in Supabase.
