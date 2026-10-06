import fs from 'node:fs';
import { ConfigError, loadEnvFiles, parseConfig, setConfig } from './config.js';
import { openDb } from './db.js';
import { seedIfEmpty } from './seed.js';
import { runDueRecurring } from './engine/services.js';
import { createApp } from './app.js';
import { scheduleBackups } from './features/backup.js';

loadEnvFiles();
let cfg;
try {
  cfg = parseConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
setConfig(cfg);
if (cfg.APP_PASSWORD) console.warn('Warning: APP_PASSWORD is stored in plain text. Prefer APP_PASSWORD_HASH (npm run hash-password -w server).');

const db = openDb(cfg.dbPath);
if (cfg.dbPath !== ':memory:') {
  for (const f of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
}
seedIfEmpty(db);
const posted = runDueRecurring(db);
if (posted.length) console.log(`Posted ${posted.length} due recurring transaction(s).`);
setInterval(() => runDueRecurring(db), 60 * 60 * 1000).unref();
scheduleBackups(db, cfg);

const app = createApp(db, cfg);
const server = app.listen(cfg.PORT, cfg.HOST, () => console.log(`Personal Finance HQ listening on http://${cfg.HOST}:${cfg.PORT}`));
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
