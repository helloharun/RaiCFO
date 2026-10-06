import { randomBytes } from 'node:crypto';
console.log(randomBytes(48).toString('base64url'));
