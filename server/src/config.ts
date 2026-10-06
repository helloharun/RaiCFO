import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { DbOptions } from './db.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Loads server/.env (then a repo-root .env as fallback). Real environment variables always win. */
export function loadEnvFiles() {
  for (const file of [path.join(serverRoot, '.env'), path.resolve(serverRoot, '..', '.env')]) {
    if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
  }
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));
const opt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: int(4000, 1, 65535),
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required (postgres://user:password@host:5432/db, e.g. your Supabase connection string)' })
      .refine((v) => /^postgres(ql)?:\/\//.test(v.trim()), 'DATABASE_URL must be a postgres:// or postgresql:// connection string')
      .transform((v) => v.trim()),
    DATABASE_SSL: z.enum(['auto', 'disable', 'require', 'verify-full']).default('auto'),
    DATABASE_CA_CERT: opt,
    DATABASE_POOL_MAX: int(5, 1, 50),
    TRUST_PROXY: z.string().optional().default(''),
    CORS_ORIGINS: z.string().optional().default(''),

    APP_USERNAME: z.string().min(1, 'APP_USERNAME is required'),
    APP_PASSWORD_HASH: opt,
    APP_PASSWORD: opt,
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters (generate with: npm run gen-secret -w server)'),
    SESSION_IDLE_MINUTES: int(30, 1, 7 * 24 * 60),
    SESSION_MAX_HOURS: int(12, 1, 24 * 30),
    COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
    LOGIN_MAX_ATTEMPTS: int(5, 1, 100),
    LOGIN_LOCKOUT_MINUTES: int(15, 1, 24 * 60),
    API_RATE_LIMIT_PER_MINUTE: int(300, 10, 100000),

    LLM_PROVIDER: z.enum(['groq', 'openai', 'anthropic', 'none', '']).optional(),
    GROQ_API_KEY: opt,
    GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    OPENAI_API_KEY: opt,
    ANTHROPIC_API_KEY: opt,
    LLM_MODEL: opt,
    LLM_BASE_URL: opt,
    LLM_TIMEOUT_SECONDS: int(30, 5, 300),

    BACKUP_ENCRYPTION_KEY: opt,
    ALLOW_DEMO_DATA: bool(true),
  })
  .superRefine((c, ctx) => {
    if (!c.APP_PASSWORD_HASH && !c.APP_PASSWORD)
      ctx.addIssue({ code: 'custom', path: ['APP_PASSWORD_HASH'], message: 'Set APP_PASSWORD_HASH (recommended: npm run hash-password -w server) or APP_PASSWORD' });
    if (c.APP_PASSWORD_HASH && !/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(c.APP_PASSWORD_HASH))
      ctx.addIssue({ code: 'custom', path: ['APP_PASSWORD_HASH'], message: 'APP_PASSWORD_HASH is not a valid scrypt hash (use npm run hash-password -w server)' });
    if (c.APP_PASSWORD && c.APP_PASSWORD.length < 12)
      ctx.addIssue({ code: 'custom', path: ['APP_PASSWORD'], message: 'APP_PASSWORD must be at least 12 characters' });
    if (c.DATABASE_SSL === 'verify-full' && !c.DATABASE_CA_CERT)
      ctx.addIssue({ code: 'custom', path: ['DATABASE_CA_CERT'], message: 'DATABASE_SSL=verify-full requires DATABASE_CA_CERT (PEM text of the server CA certificate)' });
    if (c.BACKUP_ENCRYPTION_KEY && c.BACKUP_ENCRYPTION_KEY.length < 32)
      ctx.addIssue({ code: 'custom', path: ['BACKUP_ENCRYPTION_KEY'], message: 'BACKUP_ENCRYPTION_KEY must be at least 32 characters' });
    if (/change[-_ ]?me|example|placeholder/i.test(c.SESSION_SECRET))
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET still contains the placeholder value from .env.example' });
  });

export type AppConfig = z.output<typeof schema> & {
  cookieSecure: boolean;
  trustProxy: boolean | number | string;
  corsOrigins: string[];
};

export class ConfigError extends Error {}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const res = schema.safeParse(env);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration in server/.env:\n${msg}\nSee server/.env.example.`);
  }
  const c = res.data;
  const tp = c.TRUST_PROXY.trim();
  return {
    ...c,
    cookieSecure: c.COOKIE_SECURE === 'auto' ? c.NODE_ENV === 'production' : c.COOKIE_SECURE === 'true',
    trustProxy: tp === '' || tp === 'false' ? false : tp === 'true' ? true : /^\d+$/.test(tp) ? Number(tp) : tp,
    corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

let current: AppConfig | null = null;
export function setConfig(c: AppConfig) {
  current = c;
}
/** Returns the active config, or null when running outside the server (e.g. unit tests / scripts). */
export function getConfig(): AppConfig | null {
  return current;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Connection options for the Postgres pool. TLS is on by default for any non-local host (e.g. Supabase). */
export function dbOptions(c: Pick<AppConfig, 'DATABASE_URL' | 'DATABASE_SSL' | 'DATABASE_CA_CERT' | 'DATABASE_POOL_MAX'>, schema?: string): DbOptions {
  const host = new URL(c.DATABASE_URL).hostname;
  const mode = c.DATABASE_SSL === 'auto' ? (LOCAL_HOSTS.has(host) ? 'disable' : 'require') : c.DATABASE_SSL;
  const ssl: DbOptions['ssl'] =
    mode === 'disable' ? false : mode === 'require' ? 'require' : { rejectUnauthorized: true, ca: c.DATABASE_CA_CERT!.replace(/\\n/g, '\n') };
  return { url: c.DATABASE_URL, ssl, max: c.DATABASE_POOL_MAX, schema };
}
