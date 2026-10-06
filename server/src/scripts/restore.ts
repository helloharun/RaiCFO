/**
 * Restore the database from a backup. Stop the server first.
 *   npm run restore -w server -- data/backups/finance-20260101-000000-auto.db[.enc]
 * The current database is first copied to <db>.pre-restore-<timestamp>.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEnvFiles, parseConfig } from '../config.js';
import { decryptBuffer, verifyDatabaseFile } from '../features/backup.js';

loadEnvFiles();
const cfg = parseConfig();
const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('Usage: npm run restore -w server -- <backup-file>');
  process.exit(1);
}
let file = path.resolve(src);
let tmp: string | null = null;
if (file.endsWith('.enc')) {
  if (!cfg.BACKUP_ENCRYPTION_KEY) {
    console.error('This backup is encrypted; set BACKUP_ENCRYPTION_KEY in server/.env.');
    process.exit(1);
  }
  tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pfhq-')), 'restore.db');
  fs.writeFileSync(tmp, decryptBuffer(fs.readFileSync(file), cfg.BACKUP_ENCRYPTION_KEY), { mode: 0o600 });
  file = tmp;
}
const v = verifyDatabaseFile(file);
if (!v.ok) {
  console.error(`Refusing to restore: integrity=${v.integrity} expectedTables=${v.hasTables}`);
  process.exit(1);
}
if (fs.existsSync(cfg.dbPath)) {
  const keep = `${cfg.dbPath}.pre-restore-${Date.now()}`;
  fs.copyFileSync(cfg.dbPath, keep);
  fs.chmodSync(keep, 0o600);
  console.log(`Current database saved to ${keep}`);
}
for (const f of [`${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
fs.copyFileSync(file, cfg.dbPath);
fs.chmodSync(cfg.dbPath, 0o600);
if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(`Restored ${src} → ${cfg.dbPath}. Start the server again.`);
