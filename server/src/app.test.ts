import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from './db.js';
import { seedIfEmpty } from './seed.js';
import { parseConfig, setConfig } from './config.js';
import { createApp } from './app.js';
import { hashPassword } from './security/password.js';
import { csvCell } from './security/csv.js';
import { backupPath, decryptBuffer, encryptBuffer } from './features/backup.js';
import { sanitizeInterpretation, llmConfig } from './ai/llm.js';

const PASSWORD = 'correct horse battery staple';
let server: Server;
let base: string;
let db: DB;
let tmpDir: string;

async function req(p: string, opts: { method?: string; body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  const res = await fetch(base + p, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { res, json, text };
}

async function login() {
  const r = await req('/api/auth/login', { body: { username: 'owner', password: PASSWORD } });
  expect(r.res.status).toBe(200);
  const cookie = r.res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, csrf: r.json.csrfToken as string };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfhq-test-'));
  const cfg = parseConfig({
    NODE_ENV: 'test',
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword(PASSWORD),
    SESSION_SECRET: 'x'.repeat(48),
    LOGIN_MAX_ATTEMPTS: '3',
    DB_PATH: path.join(tmpDir, 'test.db'),
    BACKUP_DIR: path.join(tmpDir, 'backups'),
    BACKUP_INTERVAL_HOURS: '0',
  });
  setConfig(cfg);
  db = openDb(cfg.dbPath);
  seedIfEmpty(db);
  server = createApp(db, cfg, { clientDist: null }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('configuration', () => {
  it('refuses to start without credentials or a strong session secret', () => {
    expect(() => parseConfig({ APP_USERNAME: 'a', SESSION_SECRET: 'x'.repeat(40) })).toThrow(/APP_PASSWORD_HASH/);
    expect(() => parseConfig({ APP_USERNAME: 'a', APP_PASSWORD: 'long-enough-password', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => parseConfig({ APP_USERNAME: 'a', APP_PASSWORD: 'long-enough-password', SESSION_SECRET: 'change-me-generate-a-long-random-secret' })).toThrow(/placeholder/);
    expect(() => parseConfig({ APP_USERNAME: 'a', APP_PASSWORD: 'short', SESSION_SECRET: 'y'.repeat(40) })).toThrow(/12 characters/);
  });
  it('picks Groq when GROQ_API_KEY is set', () => {
    expect(llmConfig({ GROQ_API_KEY: 'gsk_test' })).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' });
    expect(llmConfig({})).toBeNull();
    expect(llmConfig({ GROQ_API_KEY: 'k', LLM_PROVIDER: 'none' })).toBeNull();
  });
});

describe('authentication', () => {
  it('blocks every API route without a session', async () => {
    for (const p of ['/api/accounts', '/api/journal', '/api/export/journal.csv', '/api/export/ledger.json', '/api/export/database.sqlite', '/api/meta', '/api/backups', '/api/audit']) {
      const r = await req(p);
      expect(r.res.status, p).toBe(401);
    }
    expect((await req('/api/journal', { body: { date: '2026-01-01' } })).res.status).toBe(401);
    expect((await req('/api/health')).res.status).toBe(200);
  });

  it('has no sign-up endpoint', async () => {
    for (const p of ['/api/auth/register', '/api/auth/signup', '/api/users']) expect((await req(p, { body: { username: 'x', password: 'y' } })).res.status).toBe(401);
  });

  it('rejects wrong credentials with a generic message and sets a hardened cookie on success', async () => {
    const bad = await req('/api/auth/login', { body: { username: 'owner', password: 'nope' } });
    expect(bad.res.status).toBe(401);
    expect(bad.json.error).toBe('Invalid username or password.');
    const badUser = await req('/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
    expect(badUser.json.error).toBe('Invalid username or password.');
    expect((await req('/api/auth/login', { body: { username: ['owner'], password: { $ne: 1 } } })).res.status).toBe(400);
    const ok = await req('/api/auth/login', { body: { username: 'owner', password: PASSWORD } });
    const sc = ok.res.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(ok.json.csrfToken).toBeTruthy();
    expect(ok.text).not.toContain(PASSWORD);
  });

  it('requires a CSRF token for state-changing requests and rejects cross-origin posts', async () => {
    const { cookie, csrf } = await login();
    expect((await req('/api/accounts', { cookie })).res.status).toBe(200);
    const body = { code: '1999', name: 'CSRF test', type: 'asset', subtype: 'bank' };
    expect((await req('/api/accounts', { body, cookie })).res.status).toBe(403);
    expect((await req('/api/accounts', { body, cookie, csrf: 'wrong' })).res.status).toBe(403);
    expect((await req('/api/accounts', { body, cookie, csrf, headers: { origin: 'https://evil.example' } })).res.status).toBe(403);
    expect((await req('/api/accounts', { body, cookie, csrf })).res.status).toBe(200);
  });

  it('logout invalidates the session server-side', async () => {
    const { cookie, csrf } = await login();
    expect((await req('/api/auth/logout', { method: 'POST', cookie, csrf })).res.status).toBe(200);
    expect((await req('/api/accounts', { cookie })).res.status).toBe(401);
  });

  it('rejects forged session cookies', async () => {
    expect((await req('/api/accounts', { cookie: 'pfhq_sid=' + 'a'.repeat(43) })).res.status).toBe(401);
    expect((await req('/api/accounts', { cookie: 'pfhq_sid=%E0%A4%A' })).res.status).toBe(401);
  });

  it('locks out an IP after repeated failures, even for the right password', async () => {
    for (let i = 0; i < 3; i++) await req('/api/auth/login', { body: { username: 'owner', password: 'wrong' + i } });
    const locked = await req('/api/auth/login', { body: { username: 'owner', password: PASSWORD } });
    expect(locked.res.status).toBe(429);
    expect(locked.res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('hardening', () => {
  let s: { cookie: string; csrf: string };
  beforeAll(() => {
    // fresh app instance has its own lockout table; sessions live in the DB
    return (async () => {
      const row = db.prepare('SELECT 1').get();
      expect(row).toBeTruthy();
    })();
  });

  it('sends security headers', async () => {
    const r = await req('/api/health');
    expect(r.res.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(r.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.res.headers.get('x-frame-options')).toBeTruthy();
    expect(r.res.headers.get('x-powered-by')).toBeNull();
    expect(r.res.headers.get('cache-control')).toBe('no-store');
  });

  it('handles malformed input without leaking internals', async () => {
    db.prepare('DELETE FROM sessions').run();
    // lockout is per-IP in memory; use the session table directly to obtain a session for these tests
    const { AuthService } = await import('./security/auth.js');
    const { getConfig } = await import('./config.js');
    const auth = new AuthService(db, getConfig()!);
    const out = await auth.login('owner', PASSWORD, 'test-ip', 'vitest');
    if (!out.ok) throw new Error('login failed');
    s = { cookie: `pfhq_sid=${out.token}`, csrf: out.session.csrf };

    const bad = await req('/api/journal', { body: '{"date":', cookie: s.cookie, csrf: s.csrf });
    expect(bad.res.status).toBe(400);
    expect(bad.text).not.toMatch(/at .*\.ts|stack/i);
    expect((await req('/api/journal/abc', { cookie: s.cookie })).res.status).toBe(400);
    expect((await req("/api/journal?search=' OR 1=1 --", { cookie: s.cookie })).json.total).toBe(0);
    expect((await req('/api/journal?limit=-5&offset=abc', { cookie: s.cookie })).res.status).toBe(200);
    const huge = await req('/api/ai/interpret', { body: { text: 'x'.repeat(3000) }, cookie: s.cookie, csrf: s.csrf });
    expect(huge.res.status).toBe(400);
  });

  it('cannot bypass ledger validation by spoofing the reversal source', async () => {
    const acct = (code: string) => (db.prepare('SELECT id FROM accounts WHERE code = ?').get(code) as { id: number }).id;
    const r = await req('/api/journal', {
      cookie: s.cookie,
      csrf: s.csrf,
      body: { date: '2026-01-05', description: 'spoof', source: 'reversal', lines: [{ accountId: acct('1100'), credit: 100, symbol: 'XEQT', quantity: -100 }, { accountId: acct('1010'), debit: 100 }] },
    });
    expect(r.res.status).toBe(400);
    expect(r.json.error).toMatch(/Cannot sell/);
    const unbalanced = await req('/api/journal', { cookie: s.cookie, csrf: s.csrf, body: { date: '2026-01-05', description: 'x', lines: [{ accountId: acct('1010'), debit: 10 }, { accountId: acct('4000'), credit: 9 }] } });
    expect(unbalanced.res.status).toBe(400);
  });

  it('exports the ledger in CSV/JSON/SQLite and neutralises formula injection', { timeout: 15000 }, async () => {
    const acct = (code: string) => (db.prepare('SELECT id FROM accounts WHERE code = ?').get(code) as { id: number }).id;
    const post = await req('/api/journal', { cookie: s.cookie, csrf: s.csrf, body: { date: '2026-01-06', description: '=HYPERLINK("http://evil")', lines: [{ accountId: acct('5100'), debit: 12.5 }, { accountId: acct('1010'), credit: 12.5 }] } });
    expect(post.res.status).toBe(200);
    const csv = await req('/api/export/journal.csv', { cookie: s.cookie });
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    for (const p of ['/api/export/general-ledger.csv', '/api/export/trial-balance.csv', '/api/export/accounts.csv']) {
      const r = await req(p, { cookie: s.cookie });
      expect(r.res.status, p).toBe(200);
      expect(r.res.headers.get('content-disposition')).toMatch(/attachment/);
    }
    const json = await req('/api/export/ledger.json', { cookie: s.cookie });
    expect(json.json.journalLines.length).toBeGreaterThan(0);
    expect(JSON.stringify(json.json)).not.toMatch(/csrf|cred_fp/);
    const sqlite = await fetch(base + '/api/export/database.sqlite', { headers: { cookie: s.cookie } });
    expect(Buffer.from(await sqlite.arrayBuffer()).subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('protects the ledger at the database level', () => {
    expect(() => db.prepare('DELETE FROM journal_entries').run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare('UPDATE journal_lines SET debit = 1').run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('creates backups and blocks path traversal on download', async () => {
    const b = await req('/api/backups', { method: 'POST', cookie: s.cookie, csrf: s.csrf });
    expect(b.res.status).toBe(200);
    expect((await req(`/api/backups/${b.json.name}/download`, { cookie: s.cookie })).res.status).toBe(200);
    for (const evil of ['..%2F..%2Fdata%2Ftest.db', '..%2Ftest.db', 'finance-20260101-000000-x.db%00.txt']) {
      expect((await req(`/api/backups/${evil}/download`, { cookie: s.cookie })).res.status).not.toBe(200);
    }
    expect(backupPath({ backupDir: tmpDir } as never, '../test.db')).toBeNull();
  });

  it('runs integrity, goals, forecast and debt planning', async () => {
    const integ = await req('/api/integrity', { cookie: s.cookie });
    expect(integ.json.checks.find((c: { name: string }) => c.name === 'Trial balance').status).toBe('pass');
    const g = await req('/api/goals', { cookie: s.cookie, csrf: s.csrf, body: { name: 'Emergency fund', kind: 'emergency_fund', targetAmount: 10000, targetDate: '2027-12-31', accountIds: [1] } });
    expect(g.res.status).toBe(200);
    expect((await req('/api/goals', { cookie: s.cookie })).json[0].name).toBe('Emergency fund');
    expect((await req('/api/goals', { cookie: s.cookie, csrf: s.csrf, body: { name: 'x', targetAmount: -1 } })).res.status).toBe(400);
    expect((await req('/api/planning/forecast?days=30', { cookie: s.cookie })).json.series.length).toBe(31);
    expect((await req('/api/planning/forecast?days=99999', { cookie: s.cookie })).res.status).toBe(400);
    expect((await req('/api/planning/debt', { cookie: s.cookie, csrf: s.csrf, body: { extraMonthly: 100 } })).res.status).toBe(200);
  });
});

describe('helpers', () => {
  it('csvCell neutralises formulas but keeps numbers', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a,b')).toBe('"a,b"');
  });
  it('backup encryption round-trips and detects tampering', () => {
    const key = 'k'.repeat(40);
    const enc = encryptBuffer(Buffer.from('ledger'), key);
    expect(decryptBuffer(enc, key).toString()).toBe('ledger');
    enc[enc.length - 1] ^= 1;
    expect(() => decryptBuffer(enc, key)).toThrow();
    expect(() => decryptBuffer(encryptBuffer(Buffer.from('x'), key), 'w'.repeat(40))).toThrow();
  });
  it('sanitises untrusted LLM output', () => {
    const out = sanitizeInterpretation({ amount: -50, transactionType: 'drop_table', categoryAccountId: '1; DROP', nested: { a: 1 }, clarifications: ['ok', 5], description: 'x'.repeat(1000) });
    expect(out.amount).toBe(50);
    expect(out.transactionType).toBe('expense');
    expect(out.categoryAccountId).toBeNull();
    expect((out as Record<string, unknown>).nested).toBeUndefined();
    expect(out.clarifications).toEqual(['ok']);
    expect(String(out.description).length).toBe(300);
  });
});
