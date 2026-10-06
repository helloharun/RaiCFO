import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DB } from './db.js';
import { openTestDb, testDatabaseUrl } from './testDb.js';
import { seedIfEmpty } from './seed.js';
import { dbOptions, parseConfig, setConfig } from './config.js';
import { createApp } from './app.js';
import { hashPassword } from './security/password.js';
import { csvCell } from './security/csv.js';
import { createBackup, decryptBuffer, encryptBuffer, parseBackup, restoreBackup } from './features/backup.js';
import { trialBalance } from './engine/reports.js';
import { sanitizeInterpretation, llmConfig } from './ai/llm.js';

const PASSWORD = 'correct horse battery staple';
let server: Server;
let base: string;
let db: DB;
let dropDb: () => Promise<void>;

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
  const cfg = parseConfig({
    NODE_ENV: 'test',
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword(PASSWORD),
    SESSION_SECRET: 'x'.repeat(48),
    LOGIN_MAX_ATTEMPTS: '3',
    DATABASE_URL: testDatabaseUrl(),
  });
  setConfig(cfg);
  const t = await openTestDb();
  db = t.db;
  dropDb = t.drop;
  await seedIfEmpty(db);
  server = createApp(db, cfg, { clientDist: null }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await dropDb?.();
});

describe('configuration', () => {
  it('refuses to start without credentials or a strong session secret', () => {
    expect(() => parseConfig({ APP_USERNAME: 'a', SESSION_SECRET: 'x'.repeat(40) , DATABASE_URL: 'postgres://u:p@localhost/db' })).toThrow(/APP_PASSWORD_HASH/);
    expect(() => parseConfig({ APP_USERNAME: 'a', APP_PASSWORD: 'long-enough-password', SESSION_SECRET: 'short' , DATABASE_URL: 'postgres://u:p@localhost/db' })).toThrow(/SESSION_SECRET/);
    expect(() => parseConfig({ APP_USERNAME: 'a', APP_PASSWORD: 'long-enough-password', SESSION_SECRET: 'change-me-generate-a-long-random-secret' , DATABASE_URL: 'postgres://u:p@localhost/db' })).toThrow(/placeholder/);
    expect(() => parseConfig({ APP_USERNAME: 'a', APP_PASSWORD: 'short', SESSION_SECRET: 'y'.repeat(40) , DATABASE_URL: 'postgres://u:p@localhost/db' })).toThrow(/12 characters/);
  });
  it('requires a Postgres DATABASE_URL and enables TLS for remote hosts', () => {
    const ok = { APP_USERNAME: 'a', APP_PASSWORD: 'long-enough-password', SESSION_SECRET: 'y'.repeat(40) };
    expect(() => parseConfig(ok)).toThrow(/DATABASE_URL/);
    expect(() => parseConfig({ ...ok, DATABASE_URL: 'mysql://x@y/z' })).toThrow(/postgres/);
    const remote = parseConfig({ ...ok, DATABASE_URL: 'postgresql://u:p@db.abc.supabase.co:5432/postgres?sslmode=disable' });
    expect(dbOptions(remote).ssl).toBe('require');
    expect(dbOptions(parseConfig({ ...ok, DATABASE_URL: 'postgres://u:p@localhost/db' })).ssl).toBe(false);
    expect(() => parseConfig({ ...ok, DATABASE_URL: 'postgres://u:p@h/db', DATABASE_SSL: 'verify-full' })).toThrow(/DATABASE_CA_CERT/);
  });
  it('picks Groq when GROQ_API_KEY is set', () => {
    expect(llmConfig({ GROQ_API_KEY: 'gsk_test' })).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' });
    expect(llmConfig({})).toBeNull();
    expect(llmConfig({ GROQ_API_KEY: 'k', LLM_PROVIDER: 'none' })).toBeNull();
  });
});

describe('authentication', () => {
  it('blocks every API route without a session', async () => {
    for (const p of ['/api/accounts', '/api/journal', '/api/export/journal.csv', '/api/export/ledger.json', '/api/export/backup.json', '/api/export/backup.json.enc', '/api/meta', '/api/backups', '/api/audit']) {
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
      const row = await db.prepare('SELECT 1').get();
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
    await db.prepare('DELETE FROM sessions').run();
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
    const acct = async (code: string) => (await db.prepare('SELECT id FROM accounts WHERE code = ?').get(code) as { id: number }).id;
    const r = await req('/api/journal', {
      cookie: s.cookie,
      csrf: s.csrf,
      body: { date: '2026-01-05', description: 'spoof', source: 'reversal', lines: [{ accountId: (await acct('1100')), credit: 100, symbol: 'XEQT', quantity: -100 }, { accountId: (await acct('1010')), debit: 100 }] },
    });
    expect(r.res.status).toBe(400);
    expect(r.json.error).toMatch(/Cannot sell/);
    const unbalanced = await req('/api/journal', { cookie: s.cookie, csrf: s.csrf, body: { date: '2026-01-05', description: 'x', lines: [{ accountId: (await acct('1010')), debit: 10 }, { accountId: (await acct('4000')), credit: 9 }] } });
    expect(unbalanced.res.status).toBe(400);
  });

  it('exports the ledger in CSV/JSON/backup formats and neutralises formula injection', { timeout: 15000 }, async () => {
    const acct = async (code: string) => (await db.prepare('SELECT id FROM accounts WHERE code = ?').get(code) as { id: number }).id;
    const post = await req('/api/journal', { cookie: s.cookie, csrf: s.csrf, body: { date: '2026-01-06', description: '=HYPERLINK("http://evil")', lines: [{ accountId: (await acct('5100')), debit: 12.5 }, { accountId: (await acct('1010')), credit: 12.5 }] } });
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
    const backup = await req('/api/export/backup.json', { cookie: s.cookie });
    expect(backup.res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(backup.json.format).toBe('pfhq-backup-v2');
    expect(backup.json.tables.journal_lines.length).toBeGreaterThan(0);
    expect(backup.json.tables.sessions).toBeUndefined();
    expect(backup.text).not.toMatch(/csrf|cred_fp/);
    expect((await req('/api/export/backup.json.enc', { cookie: s.cookie })).res.status).toBe(400);
  });

  it('protects the ledger at the database level', async () => {
    await expect(db.prepare('DELETE FROM journal_entries').run()).rejects.toThrow(/cannot be deleted/);
    await expect(db.prepare('DELETE FROM journal_lines').run()).rejects.toThrow(/cannot be deleted/);
    await expect(db.prepare('UPDATE journal_lines SET debit = 1').run()).rejects.toThrow(/immutable/);
    await expect(db.prepare('UPDATE journal_lines SET account_id = account_id + 1').run()).rejects.toThrow(/immutable/);
    await expect(db.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
    await expect(db.prepare("UPDATE audit_log SET action = 'x'").run()).rejects.toThrow(/append-only/);
    await expect(db.exec('TRUNCATE journal_lines, journal_entries')).rejects.toThrow(/truncated/);
    await expect(db.exec('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
    // reconciliation metadata stays editable
    expect((await db.prepare('UPDATE journal_lines SET cleared = cleared WHERE id = (SELECT MIN(id) FROM journal_lines)').run()).changes).toBe(1);
    // the Supabase REST roles (when present) get no table access, and RLS is on everywhere
    const rls = (await db.prepare("SELECT COUNT(*) AS n FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' AND NOT relrowsecurity").get()) as { n: number };
    expect(rls.n).toBe(0);
  });

  it('restores a backup into an empty database and refuses to overwrite a live ledger', { timeout: 30000 }, async () => {
    const data = parseBackup(Buffer.from(JSON.stringify(await createBackup(db))));
    await expect(restoreBackup(db, data)).rejects.toThrow(/already has journal entries/);
    const target = await openTestDb();
    try {
      await seedIfEmpty(target.db);
      await restoreBackup(target.db, data);
      const [a, b] = [await trialBalance(db, '2030-01-01'), await trialBalance(target.db, '2030-01-01')];
      expect(b.totalDebit).toBe(a.totalDebit);
      expect(b.balanced).toBe(true);
      const count = async (d: DB, t: string) => ((await d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()) as { n: number }).n;
      for (const t of ['accounts', 'journal_entries', 'journal_lines', 'audit_log', 'recurring_transactions']) expect(await count(target.db, t), t).toBe(await count(db, t));
      // sequences continue after restored ids
      const id = (await target.db.prepare("INSERT INTO goals (name, target_amount) VALUES ('x', 1)").run()).lastInsertRowid!;
      expect(id).toBeGreaterThan(0);
      expect(parseBackup(encryptBuffer(Buffer.from(JSON.stringify(data)), 'k'.repeat(40)), 'k'.repeat(40)).format).toBe('pfhq-backup-v2');
      expect(() => parseBackup(Buffer.from('{"format":"evil"}'))).toThrow(/Not a Personal Finance HQ backup/);
    } finally {
      await target.drop();
    }
  });

  it('posts a recurring transaction on demand and still supports pause/resume', async () => {
    const acct = async (code: string) => (await db.prepare('SELECT id FROM accounts WHERE code = ?').get(code) as { id: number }).id;
    const created = await req('/api/recurring', { cookie: s.cookie, csrf: s.csrf, body: { description: 'Rent', frequency: 'monthly', nextDate: '2026-02-01', template: { lines: [{ accountId: (await acct('5010')), debit: 1500 }, { accountId: (await acct('1010')), credit: 1500 }] } } });
    expect(created.res.status, created.text).toBe(200);
    const rec = { id: created.json.id as number };
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n;
    const r = await req(`/api/recurring/${rec!.id}/post-now`, { cookie: s.cookie, csrf: s.csrf, body: { date: '2026-01-07' } });
    expect(r.res.status, r.text).toBe(200);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n).toBe(before + 1);
    expect((await db.prepare('SELECT next_date FROM recurring_transactions WHERE id = ?').get(rec.id) as { next_date: string }).next_date).toBe('2026-03-01');
    expect((await req(`/api/recurring/${rec!.id}/pause`, { cookie: s.cookie, csrf: s.csrf, body: {} })).res.status).toBe(200);
    expect((await req(`/api/recurring/${rec!.id}/resume`, { cookie: s.cookie, csrf: s.csrf, body: {} })).res.status).toBe(200);
    expect((await req(`/api/recurring/${rec!.id}/drop`, { cookie: s.cookie, csrf: s.csrf, body: {} })).res.status).toBe(400);
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
