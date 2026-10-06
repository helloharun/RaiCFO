import { ConfigError, dbOptions, loadEnvFiles, parseConfig, setConfig } from './config.js';
import { openDb } from './db.js';
import { seedIfEmpty } from './seed.js';
import { runDueRecurring } from './engine/services.js';
import { createApp } from './app.js';

async function main() {
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

  const db = await openDb(dbOptions(cfg));
  await seedIfEmpty(db);
  const runRecurring = async () => {
    try {
      const posted = await runDueRecurring(db);
      if (posted.length) console.log(`Posted ${posted.length} due recurring transaction(s).`);
    } catch (e) {
      console.error('Recurring run failed:', (e as Error).message);
    }
  };
  await runRecurring();
  setInterval(runRecurring, 60 * 60 * 1000).unref();

  const app = createApp(db, cfg);
  const server = app.listen(cfg.PORT, cfg.HOST, () => console.log(`Personal Finance HQ listening on http://${cfg.HOST}:${cfg.PORT}`));
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(`Failed to start: ${e.code === 'EADDRINUSE' ? `port ${cfg.PORT} is already in use` : e.message}`);
    process.exit(1);
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;

  const shutdown = () => {
    server.close(async () => {
      await db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main().catch((e) => {
  const msg = (e as Error).message ?? String(e);
  console.error(`Failed to start: ${msg.replace(/postgres(ql)?:\/\/[^\s@]+@/gi, 'postgres://***@')}`);
  process.exit(1);
});
