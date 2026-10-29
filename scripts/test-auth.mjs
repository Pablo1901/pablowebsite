/**
 * Checks the admin credential path in worker.js end to end.
 *
 * It reproduces what the browser does — PBKDF2 over the shipped salt — then asks
 * the Worker's own verifyCredentials whether that key is accepted. So this tests
 * the real credential in worker.js, not a fixture.
 *
 *   node scripts/test-auth.mjs
 */
import { pbkdf2Sync } from 'node:crypto';
import { __auth } from '../worker.js';

const { verifyCredentials, coverBytes, ADMIN } = __auth;
const PASSWORD = 'Isienka1!';

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${actual}, want ${expected})`}`);
}

function deriveKey(password) {
  const salt = Buffer.from(ADMIN.salt, 'base64');
  return pbkdf2Sync(password, salt, ADMIN.iterations, 32, 'sha256').toString('base64');
}

check('mode is the free-plan friendly one', ADMIN.mode, 'client-pbkdf2');
check('correct password is accepted', await verifyCredentials('pablo', null, deriveKey(PASSWORD)), true);
check('wrong password is rejected', await verifyCredentials('pablo', null, deriveKey('wrong-password')), false);
check('wrong username is rejected', await verifyCredentials('someone', null, deriveKey(PASSWORD)), false);
check('raw password without a key is rejected', await verifyCredentials('pablo', PASSWORD, undefined), false);
check('short key is rejected', await verifyCredentials('pablo', null, 'abc'), false);
check('non-base64 key is rejected', await verifyCredentials('pablo', null, '!!!!not-base64!!!!'), false);
check('empty key is rejected', await verifyCredentials('pablo', null, ''), false);
check('missing username is rejected', await verifyCredentials(undefined, null, deriveKey(PASSWORD)), false);

// Cover storage: base64 text in, real bytes out. Rows written before the fix
// hold a comma-separated byte list and must still render.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const fromBase64 = coverBytes(png.toString('base64'));
check('base64 cover decodes to the original bytes', Buffer.from(fromBase64).equals(png), true);
check(
  'legacy byte-list cover decodes',
  Buffer.from(coverBytes(`[${[...png].join(',')}]`)).equals(png),
  true,
);
check('garbage cover value is rejected', coverBytes('not base64 at all!!'), null);
check('empty cover value is rejected', coverBytes(''), null);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
