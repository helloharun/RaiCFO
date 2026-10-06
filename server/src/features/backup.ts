import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../db.js';
import type { AppConfig } from '../config.js';
import { audit } from '../engine/ledger.js';

const MAGIC = Buffer.from('PFHQENC1');
export const BACKUP_NAME = /^finance-\d{8}-\d{6}-[a-z]{1,12}\.db(\.enc)?$/;

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function keyFor(secret: string, salt: Buffer) {
  return scryptSync(secret, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
}

export function encryptBuffer(plain: Buffer, secret: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(secret, salt), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function decryptBuffer(data: Buffer, secret: string): Buffer {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted Personal Finance HQ backup.');
  let o = MAGIC.length;
  const salt = data.subarray(o, (o += 16));
  const iv = data.subarray(o, (o += 12));
  const tag = data.subarray(o, (o += 16));
  const d = createDecipheriv('aes-256-gcm', keyFor(secret, salt), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data.subarray(o)), d.final()]);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Consistent online snapshot of the database to a temporary file (caller deletes it). */
export async function snapshot(db: DB, dir: string): Promise<string> {
  ensureDir(dir);
  const tmp = path.join(dir, `tmp-${process.pid}-${randomBytes(6).toString('hex')}.db`);
  await db.backup(tmp);
  fs.chmodSync(tmp, 0o600);
  return tmp;
}

export async function createBackup(db: DB, cfg: AppConfig, reason = 'manual') {
  const tag = reason.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12) || 'manual';
  const tmp = await snapshot(db, cfg.backupDir);
  try {
    let name = `finance-${stamp()}-${tag}.db`;
    const target = () => path.join(cfg.backupDir, name);
    if (cfg.BACKUP_ENCRYPTION_KEY) {
      name += '.enc';
      fs.writeFileSync(target(), encryptBuffer(fs.readFileSync(tmp), cfg.BACKUP_ENCRYPTION_KEY), { mode: 0o600 });
    } else {
      fs.renameSync(tmp, target());
    }
    pruneBackups(cfg);
    audit(db, 'backup', 'database', null, { name, reason: tag });
    return { name, size: fs.statSync(target()).size, encrypted: Boolean(cfg.BACKUP_ENCRYPTION_KEY) };
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export function listBackups(cfg: AppConfig) {
  if (!fs.existsSync(cfg.backupDir)) return [];
  return fs
    .readdirSync(cfg.backupDir)
    .filter((f) => BACKUP_NAME.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(cfg.backupDir, f));
      return { name: f, size: st.size, createdAt: st.mtime.toISOString(), encrypted: f.endsWith('.enc') };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Resolves a backup name to a path inside the backup directory, rejecting anything else (path traversal). */
export function backupPath(cfg: AppConfig, name: string): string | null {
  if (typeof name !== 'string' || !BACKUP_NAME.test(name) || path.basename(name) !== name) return null;
  const p = path.join(cfg.backupDir, name);
  return path.dirname(p) === path.resolve(cfg.backupDir) && fs.existsSync(p) ? p : null;
}

export function pruneBackups(cfg: AppConfig) {
  const all = listBackups(cfg);
  for (const b of all.slice(cfg.BACKUP_RETENTION)) fs.unlinkSync(path.join(cfg.backupDir, b.name));
}

/** Verifies a SQLite file is intact and looks like a Personal Finance HQ database. */
export function verifyDatabaseFile(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const ok = (db.pragma('integrity_check', { simple: true }) as string) === 'ok';
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name));
    const hasTables = ['accounts', 'journal_entries', 'journal_lines'].every((t) => tables.has(t));
    return { ok: ok && hasTables, integrity: ok, hasTables };
  } finally {
    db.close();
  }
}

export function scheduleBackups(db: DB, cfg: AppConfig) {
  if (!cfg.BACKUP_INTERVAL_HOURS || cfg.dbPath === ':memory:') return;
  const intervalMs = cfg.BACKUP_INTERVAL_HOURS * 3_600_000;
  const run = () => createBackup(db, cfg, 'auto').catch((e) => console.error('Automatic backup failed:', (e as Error).message));
  const latest = listBackups(cfg)[0];
  if (!latest || Date.now() - new Date(latest.createdAt).getTime() > intervalMs) setTimeout(run, 5_000).unref();
  setInterval(run, intervalMs).unref();
}
