import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'CAD',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  subtype TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  parent_id INTEGER REFERENCES accounts(id),
  institution TEXT,
  aliases TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, code)
);

CREATE TABLE IF NOT EXISTS securities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  symbol TEXT NOT NULL,
  name TEXT,
  currency TEXT NOT NULL DEFAULT 'CAD',
  last_price INTEGER,
  price_date TEXT,
  UNIQUE (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  payee TEXT,
  memo TEXT,
  transaction_type TEXT NOT NULL DEFAULT 'manual',
  source TEXT NOT NULL DEFAULT 'manual',
  currency TEXT NOT NULL DEFAULT 'CAD',
  fx_rate REAL NOT NULL DEFAULT 1,
  raw_input TEXT,
  explanation TEXT,
  metadata TEXT,
  import_hash TEXT,
  reversal_of INTEGER REFERENCES journal_entries(id),
  reversed_by INTEGER REFERENCES journal_entries(id),
  recurring_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON journal_entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_entries_hash ON journal_entries(import_hash);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  original_debit INTEGER NOT NULL DEFAULT 0,
  original_credit INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  security_id INTEGER REFERENCES securities(id),
  quantity REAL,
  reconciliation_id INTEGER,
  cleared INTEGER NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_lines_entry ON journal_lines(entry_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  UNIQUE (user_id, account_id, month)
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  statement_date TEXT NOT NULL,
  statement_balance INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS recurring_transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
  frequency TEXT NOT NULL,
  next_date TEXT NOT NULL,
  end_date TEXT,
  template TEXT NOT NULL,
  auto_post INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchant_rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  pattern TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  hits INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, pattern)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (currency, date)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER NOT NULL DEFAULT 1,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (user_id, key)
);
`;

export function openDb(file?: string): DB {
  const target = file ?? process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'finance.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
