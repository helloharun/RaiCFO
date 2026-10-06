import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { resetSequences, type DB } from '../db.js';
import { ValidationError } from '../types.js';

const MAGIC = Buffer.from('PFHQENC1');
export const BACKUP_FORMAT = 'pfhq-backup-v2';

/** Restore order respects foreign keys; sessions are never exported. */
export const BACKUP_TABLES = [
  'users', 'accounts', 'securities', 'journal_entries', 'journal_lines', 'reconciliations', 'budgets',
  'recurring_transactions', 'merchant_rules', 'fx_rates', 'goals', 'settings', 'audit_log',
] as const;

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

export interface Backup {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

/** Complete, restorable snapshot of every table (read in one transaction for consistency). */
export async function createBackup(db: DB): Promise<Backup> {
  return db.transaction(async () => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables: Backup['tables'] = {};
    for (const t of BACKUP_TABLES) tables[t] = (await db.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
    return { format: BACKUP_FORMAT as typeof BACKUP_FORMAT, createdAt: new Date().toISOString(), tables };
  })();
}

export function parseBackup(buf: Buffer, secret?: string): Backup {
  let raw = buf;
  if (buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (!secret) throw new ValidationError('This backup is encrypted; BACKUP_ENCRYPTION_KEY is required.');
    raw = decryptBuffer(buf, secret);
  }
  const data = JSON.parse(raw.toString('utf8')) as Backup;
  if (data?.format !== BACKUP_FORMAT || typeof data.tables !== 'object') throw new ValidationError('Not a Personal Finance HQ backup file.');
  return data;
}

/**
 * Restores a backup into a database whose ledger is empty. Existing non-ledger rows (seeded accounts, settings…) are replaced.
 * Column names come from the live schema, never from the file.
 */
export async function restoreBackup(db: DB, data: Backup) {
  return db.transaction(async () => {
    const posted = (await db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get()) as { n: number };
    if (posted.n > 0) throw new ValidationError('The target database already has journal entries. Restore into a new, empty database.');
    for (const t of [...BACKUP_TABLES].reverse()) if (t !== 'journal_entries' && t !== 'journal_lines' && t !== 'audit_log') await db.query(`DELETE FROM ${t}`);
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      const rows = Array.isArray(data.tables[t]) ? data.tables[t] : [];
      const cols = (
        await db.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [t])
      ).rows.map((r) => r.column_name as string);
      const deferred = t === 'accounts' ? ['parent_id'] : t === 'journal_entries' ? ['reversal_of', 'reversed_by'] : [];
      for (const row of rows) {
        const use = cols.filter((c) => c in row && !deferred.includes(c));
        await db.query(
          `INSERT INTO ${t} (${use.map((c) => `"${c}"`).join(', ')}) VALUES (${use.map((_, i) => `$${i + 1}`).join(', ')})`,
          use.map((c) => row[c]),
        );
      }
      for (const row of rows) {
        const set = deferred.filter((c) => row[c] !== null && row[c] !== undefined);
        if (set.length) await db.query(`UPDATE ${t} SET ${set.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE id = $1`, [row.id, ...set.map((c) => row[c])]);
      }
      counts[t] = rows.length;
    }
    await resetSequences(db);
    return counts;
  })();
}
