/**
 * Restores a JSON backup (optionally encrypted) into an EMPTY database:
 *   npm run restore -w server -- path/to/personal-finance-backup-....json[.enc]
 * Uses DATABASE_URL / BACKUP_ENCRYPTION_KEY from server/.env. Refuses to overwrite a database that already has journal entries.
 */
import fs from 'node:fs';
import { ConfigError, dbOptions, loadEnvFiles, parseConfig } from '../config.js';
import { openDb } from '../db.js';
import { parseBackup, restoreBackup } from '../features/backup.js';
import { integrityCheck } from '../features/integrity.js';

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: npm run restore -w server -- <backup.json | backup.json.enc>');
    process.exit(1);
  }
  loadEnvFiles();
  const cfg = parseConfig();
  const data = parseBackup(fs.readFileSync(file), cfg.BACKUP_ENCRYPTION_KEY);
  const db = await openDb(dbOptions(cfg));
  try {
    const counts = await restoreBackup(db, data);
    console.log(`Restored backup from ${data.createdAt}:`);
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
    const check = await integrityCheck(db);
    console.log(`Integrity check: ${check.status.toUpperCase()}`);
    for (const c of check.checks.filter((x) => x.status !== 'pass')) console.log(`  [${c.status}] ${c.name}: ${c.detail}`);
  } finally {
    await db.close();
  }
}

await main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : `Restore failed: ${(e as Error).message}`);
  process.exit(1);
});
