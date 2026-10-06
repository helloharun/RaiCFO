import { createHash, randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db.js';
import type { AppConfig } from '../config.js';
import { audit } from '../engine/ledger.js';
import { hashPassword, safeEqual, verifyPasswordHash } from './password.js';

export interface SessionRow {
  id: string;
  csrf: string;
  cred_fp: string;
  created_at: number;
  last_seen: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionRow;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_FIELD = 256;

export function cookieName(cfg: AppConfig) {
  return cfg.cookieSecure ? '__Host-pfhq_sid' : 'pfhq_sid';
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

interface Attempt {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

/** Credentials are verified against server/.env only; there is no user table and no sign-up. */
export class AuthService {
  private attempts = new Map<string, Attempt>();
  private passwordHash: Promise<string>;
  private dummyHash: Promise<string>;
  readonly credFingerprint: string;

  constructor(
    private db: DB,
    private cfg: AppConfig,
  ) {
    this.passwordHash = cfg.APP_PASSWORD_HASH ? Promise.resolve(cfg.APP_PASSWORD_HASH) : hashPassword(cfg.APP_PASSWORD!);
    this.dummyHash = hashPassword(randomBytes(16).toString('hex'));
    // Any change to the configured username/password/secret invalidates all existing sessions.
    this.credFingerprint = sha256(`${cfg.APP_USERNAME}\n${cfg.APP_PASSWORD_HASH ?? cfg.APP_PASSWORD}\n${cfg.SESSION_SECRET}`);
    db.prepare('DELETE FROM sessions WHERE cred_fp <> ? OR expires_at < ?').run(this.credFingerprint, Date.now());
  }

  private tokenId(token: string) {
    return createHash('sha256').update(`${this.cfg.SESSION_SECRET}:${token}`).digest('hex');
  }

  lockStatus(key: string, now = Date.now()) {
    const a = this.attempts.get(key);
    return a && a.lockedUntil > now ? Math.ceil((a.lockedUntil - now) / 1000) : 0;
  }

  private recordFailure(key: string, max: number, now = Date.now()) {
    const windowMs = this.cfg.LOGIN_LOCKOUT_MINUTES * 60_000;
    const a = this.attempts.get(key);
    const cur = !a || now - a.windowStart > windowMs ? { failures: 0, windowStart: now, lockedUntil: 0 } : a;
    cur.failures += 1;
    if (cur.failures >= max) {
      cur.lockedUntil = now + windowMs;
      cur.failures = 0;
      cur.windowStart = now;
    }
    this.attempts.set(key, cur);
    if (this.attempts.size > 10_000) {
      for (const [k, v] of this.attempts) if (v.lockedUntil < now && now - v.windowStart > windowMs) this.attempts.delete(k);
    }
  }

  async verify(username: string, password: string): Promise<boolean> {
    const userOk = safeEqual(username, this.cfg.APP_USERNAME);
    // Always run the hash so timing does not reveal whether the username was right.
    const pwOk = await verifyPasswordHash(password, userOk ? await this.passwordHash : await this.dummyHash);
    return userOk && pwOk;
  }

  async login(username: string, password: string, ip: string, userAgent: string) {
    const ipKey = `ip:${ip}`;
    const wait = Math.max(this.lockStatus(ipKey), this.lockStatus('global'));
    if (wait) return { ok: false as const, retryAfter: wait };
    const ok = await this.verify(username, password);
    if (!ok) {
      this.recordFailure(ipKey, this.cfg.LOGIN_MAX_ATTEMPTS);
      this.recordFailure('global', this.cfg.LOGIN_MAX_ATTEMPTS * 10);
      audit(this.db, 'login_failed', 'auth', null, { ip, userAgent: userAgent.slice(0, 200) });
      return { ok: false as const, retryAfter: Math.max(this.lockStatus(ipKey), this.lockStatus('global')) };
    }
    this.attempts.delete(ipKey);
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const row: SessionRow = {
      id: this.tokenId(token),
      csrf: randomBytes(32).toString('base64url'),
      cred_fp: this.credFingerprint,
      created_at: now,
      last_seen: now,
      expires_at: now + this.cfg.SESSION_MAX_HOURS * 3_600_000,
      ip,
      user_agent: userAgent.slice(0, 300),
    };
    this.db
      .prepare('INSERT INTO sessions (id, csrf, cred_fp, created_at, last_seen, expires_at, ip, user_agent) VALUES (@id, @csrf, @cred_fp, @created_at, @last_seen, @expires_at, @ip, @user_agent)')
      .run(row);
    audit(this.db, 'login', 'auth', null, { ip, userAgent: row.user_agent });
    return { ok: true as const, token, session: row };
  }

  resolve(token: string | undefined, now = Date.now()): SessionRow | undefined {
    if (!token || token.length > 200) return undefined;
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(this.tokenId(token)) as SessionRow | undefined;
    if (!s) return undefined;
    const idleMs = this.cfg.SESSION_IDLE_MINUTES * 60_000;
    if (s.expires_at < now || now - s.last_seen > idleMs || s.cred_fp !== this.credFingerprint) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
      return undefined;
    }
    if (now - s.last_seen > 15_000) {
      this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, s.id);
      s.last_seen = now;
    }
    return s;
  }

  destroy(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  destroyOthers(id: string) {
    return this.db.prepare('DELETE FROM sessions WHERE id <> ?').run(id).changes;
  }

  cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?').run(Date.now(), Date.now() - this.cfg.SESSION_IDLE_MINUTES * 60_000);
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameOrigin(req: Request, cfg: AppConfig): boolean {
  const origin = req.get('origin') ?? (req.get('referer') ? safeOrigin(req.get('referer')!) : undefined);
  if (!origin) return true; // non-browser clients; CSRF token is still required
  const host = req.get('host');
  return (host && (origin === `${req.protocol}://${host}` || safeOrigin(origin)?.endsWith(`//${host}`))) || cfg.corsOrigins.includes(origin);
}
function safeOrigin(u: string) {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

export function authRouter(db: DB, cfg: AppConfig, auth: AuthService) {
  const r = express.Router();
  const name = cookieName(cfg);
  const cookieOpts = { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict' as const, path: '/', maxAge: cfg.SESSION_MAX_HOURS * 3_600_000 };

  r.get('/health', (_req, res) => res.json({ ok: true }));

  r.post('/auth/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!sameOrigin(req, cfg)) return res.status(403).json({ error: 'Cross-origin request rejected.' });
      const { username, password } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > MAX_FIELD || password.length > MAX_FIELD) {
        return res.status(400).json({ error: 'Enter your username and password.' });
      }
      const result = await auth.login(username, password, req.ip ?? 'unknown', req.get('user-agent') ?? '');
      if (!result.ok) {
        if (result.retryAfter) {
          res.setHeader('Retry-After', String(result.retryAfter));
          return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(result.retryAfter / 60)} minute(s).`, retryAfter: result.retryAfter });
        }
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      res.cookie(name, result.token, cookieOpts);
      res.json({ authenticated: true, username: cfg.APP_USERNAME, csrfToken: result.session.csrf, idleMinutes: cfg.SESSION_IDLE_MINUTES });
    } catch (e) {
      next(e);
    }
  });

  r.get('/auth/session', (req, res) => {
    const s = auth.resolve(parseCookies(req.headers.cookie)[name]);
    if (!s) return res.json({ authenticated: false });
    res.json({ authenticated: true, username: cfg.APP_USERNAME, csrfToken: s.csrf, expiresAt: s.expires_at, idleMinutes: cfg.SESSION_IDLE_MINUTES });
  });

  return r;
}

/** Requires a valid session for every route after it, plus CSRF token + same-origin for state-changing requests. */
export function requireAuth(cfg: AppConfig, auth: AuthService) {
  const name = cookieName(cfg);
  return (req: Request, res: Response, next: NextFunction) => {
    const s = auth.resolve(parseCookies(req.headers.cookie)[name]);
    if (!s) {
      res.clearCookie(name, { path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict' });
      return res.status(401).json({ error: 'Not signed in or session expired.' });
    }
    if (!SAFE_METHODS.has(req.method)) {
      const token = req.get('x-csrf-token');
      if (!token || !safeEqual(token, s.csrf) || !sameOrigin(req, cfg)) return res.status(403).json({ error: 'Invalid or missing CSRF token. Reload the page.' });
    }
    req.session = s;
    next();
  };
}

export function sessionRoutes(db: DB, cfg: AppConfig, auth: AuthService) {
  const r = express.Router();
  const name = cookieName(cfg);
  r.post('/auth/logout', (req, res) => {
    auth.destroy(req.session!.id);
    audit(db, 'logout', 'auth', null);
    res.clearCookie(name, { path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict' });
    res.json({ ok: true });
  });
  r.get('/auth/sessions', (req, res) => {
    const rows = db.prepare('SELECT id, created_at, last_seen, expires_at, ip, user_agent FROM sessions ORDER BY last_seen DESC').all() as SessionRow[];
    res.json(rows.map((x) => ({ current: x.id === req.session!.id, createdAt: x.created_at, lastSeen: x.last_seen, expiresAt: x.expires_at, ip: x.ip, userAgent: x.user_agent })));
  });
  r.post('/auth/sessions/revoke-others', (req, res) => {
    const n = auth.destroyOthers(req.session!.id);
    audit(db, 'revoke_sessions', 'auth', null, { count: n });
    res.json({ revoked: n });
  });
  return r;
}
