import readline from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../security/password.js';

async function prompt(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({ write: (chunk, _enc, cb) => (muted || process.stdout.write(chunk), cb()) });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(question);
    muted = true;
    rl.question('', (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

const pw = process.env.PASSWORD ?? (await prompt('New password: '));
if (!process.env.PASSWORD && pw !== (await prompt('Repeat password: '))) {
  console.error('Passwords do not match.');
  process.exit(1);
}
if (pw.length < 12) {
  console.error('Use at least 12 characters.');
  process.exit(1);
}
const hash = await hashPassword(pw);
console.log(`\nAdd this line to server/.env (the single quotes matter):\nAPP_PASSWORD_HASH='${hash}'`);
