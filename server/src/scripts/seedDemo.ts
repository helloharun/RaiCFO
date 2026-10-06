import { dbOptions, loadEnvFiles, parseConfig } from '../config.js';
import { openDb } from '../db.js';
import { seedIfEmpty } from '../seed.js';
import { seedDemo } from './demoData.js';

loadEnvFiles();
const db = await openDb(dbOptions(parseConfig()));
try {
  await seedIfEmpty(db);
  const n = ((await db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get()) as { n: number }).n;
  if (n > 0) console.log('Ledger is not empty; skipping demo data.');
  else console.log(`Posted ${await seedDemo(db)} demo entries.`);
} finally {
  await db.close();
}
