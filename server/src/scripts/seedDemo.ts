import { openDb } from '../db.js';
import { seedIfEmpty } from '../seed.js';
import { seedDemo } from './demoData.js';

const db = openDb();
seedIfEmpty(db);
const n = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n;
if (n > 0) {
  console.log('Ledger is not empty; skipping demo data.');
} else {
  console.log(`Posted ${seedDemo(db)} demo entries.`);
}
