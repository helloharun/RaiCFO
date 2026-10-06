import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { openDb, type DB } from './db.js';

/** Postgres used by the test suite, e.g. postgres://user:pass@127.0.0.1:5432/pfhq_test (never your real database). */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database to run the tests.');
  return url;
}

/** Opens a migrated database in a fresh, uniquely named schema. Call drop() to remove it. */
export async function openTestDb(): Promise<{ db: DB; schema: string; drop: () => Promise<void> }> {
  const url = testDatabaseUrl();
  const schema = `pfhq_t_${randomBytes(6).toString('hex')}`;
  const db = await openDb({ url, ssl: false, schema, max: 3 });
  return {
    db,
    schema,
    drop: async () => {
      await db.close();
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    },
  };
}
