/**
 * Generates the salt + PBKDF2 hash used for the single admin account.
 *
 *   node scripts/hash-password.mjs "new password"
 *
 * Paste the printed salt/hash into the ADMIN object in worker.js.
 * The password itself is never stored anywhere.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.mjs "new password"');
  process.exit(1);
}

const salt = randomBytes(16);
const iterations = 210000;
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');

console.log(`salt: ${salt.toString('base64')}`);
console.log(`hash: ${hash.toString('base64')}`);
console.log(`iterations: ${iterations}`);
