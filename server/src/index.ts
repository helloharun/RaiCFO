import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedIfEmpty } from './seed.js';
import { apiRouter } from './routes/api.js';
import { runDueRecurring } from './engine/services.js';

const db = openDb();
seedIfEmpty(db);
const posted = runDueRecurring(db);
if (posted.length) console.log(`Posted ${posted.length} due recurring transaction(s).`);
setInterval(() => runDueRecurring(db), 60 * 60 * 1000).unref();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/api', apiRouter(db));

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => (req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile(path.join(clientDist, 'index.html')) : next()));
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Personal Finance HQ API listening on http://localhost:${port}`));
