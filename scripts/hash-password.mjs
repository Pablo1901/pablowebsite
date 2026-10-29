/**
 * Generates the salt + hash for the single admin account.
 *
 *   node scripts/hash-password.mjs "new password"
 *
 * Paste the printed block over the ADMIN object in worker.js. The password is
 * never stored anywhere.
 *
 * How the hash is built (mode 'client-pbkdf2'):
 *   key  = PBKDF2-SHA256(password, salt, iterations, 32 bytes)   <- browser
 *   hash = SHA-256(key)                                          <- Worker
 * The Worker only does the single SHA-256, which keeps login inside the Workers
 * free plan CPU budget; the expensive PBKDF2 happens on the visitor's machine.
 * Guessing the password offline still costs a full PBKDF2 per attempt.
 *
 * Pass --mode pbkdf2 for the legacy server-side scheme (needs the paid plan).
 */
import { pbkdf2Sync, randomBytes, createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--mode') {
    flags.mode = args[i + 1];
    i += 1;
  } else {
    positional.push(arg);
  }
}

const password = positional[0];
const mode = flags.mode === 'pbkdf2' ? 'pbkdf2' : 'client-pbkdf2';

if (!password) {
  console.error('Usage: node scripts/hash-password.mjs "new password" [--mode pbkdf2]');
  process.exit(1);
}

const salt = randomBytes(16);
const iterations = 210000;

if (mode === 'client-pbkdf2') {
  const key = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hash = createHash('sha256').update(key).digest('base64');

  console.log(`salt: ${salt.toString('base64')}`);
  console.log(`hash: ${hash}`);
  console.log('mode: client-pbkdf2');
  console.log('');
  console.log('Paste this into worker.js:');
  console.log('const ADMIN = {');
  console.log("  username: 'pablo',");
  console.log("  mode: 'client-pbkdf2',");
  console.log(`  salt: '${salt.toString('base64')}',`);
  console.log(`  hash: '${hash}',`);
  console.log(`  iterations: ${iterations},`);
  console.log('};');
} else {
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');

  console.log(`salt: ${salt.toString('base64')}`);
  console.log(`hash: ${hash.toString('base64')}`);
  console.log(`iterations: ${iterations}`);
  console.log('mode: pbkdf2');
  console.log('');
  console.log('Paste this into worker.js:');
  console.log('const ADMIN = {');
  console.log("  username: 'pablo',");
  console.log("  mode: 'pbkdf2',");
  console.log(`  salt: '${salt.toString('base64')}',`);
  console.log(`  hash: '${hash.toString('base64')}',`);
  console.log(`  iterations: ${iterations},`);
  console.log('};');
}
