/** Decrypt an encrypted backup:  npm run decrypt-backup -w server -- <file.db.enc> <output.db> */
import fs from 'node:fs';
import { loadEnvFiles } from '../config.js';
import { decryptBuffer } from '../features/backup.js';

loadEnvFiles();
const [src, out] = process.argv.slice(2);
const key = process.env.BACKUP_ENCRYPTION_KEY;
if (!src || !out || !key) {
  console.error('Usage: npm run decrypt-backup -w server -- <file.db.enc> <output.db>   (requires BACKUP_ENCRYPTION_KEY)');
  process.exit(1);
}
fs.writeFileSync(out, decryptBuffer(fs.readFileSync(src), key), { mode: 0o600 });
console.log(`Decrypted to ${out}`);
