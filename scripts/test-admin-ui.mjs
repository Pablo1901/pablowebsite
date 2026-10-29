import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const html = readFileSync('public/admin.html', 'utf8');
const source = readFileSync('public/admin.js', 'utf8');
const { window, document } = parseHTML(html);

const store = new Map();
const sessionStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const calls = [];
let issued = null;

function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function fetchStub(url, options = {}) {
  const headers = options.headers || {};
  const auth = headers.authorization || headers.Authorization || null;
  calls.push({ url, method: options.method || 'GET', auth });

  if (url === '/api/admin/login') {
    issued = 'test-token';
    return reply({ ok: true, token: issued });
  }
  if (url === '/api/admin/session') {
    const valid = auth === `Bearer ${issued}` && store.get('pablo_admin_token') === issued;
    return reply({ authenticated: Boolean(valid) });
  }
  if (url === '/api/admin/releases') {
    if (auth !== `Bearer ${issued}`) return reply({ error: 'Unauthorized.' }, 401);
    return reply({ releases: [] });
  }
  return reply({ ok: true });
}

class FormDataStub {
  get(name) {
    return name === 'username' ? 'pablo' : 'Isienka1!';
  }
}

const loginForm = document.getElementById('login-form');
loginForm.elements = { username: { focus() {} } };
const releaseForm = document.getElementById('release-form');
if (!releaseForm.elements) releaseForm.elements = {};

// linkedom implements neither of these; real browsers do.
for (const form of [loginForm, releaseForm]) {
  if (typeof form.reset !== 'function') form.reset = () => {};
  if (typeof form.scrollIntoView !== 'function') form.scrollIntoView = () => {};
}

const run = new Function(
  'document',
  'window',
  'fetch',
  'sessionStorage',
  'FormData',
  `${source}\n`,
);
run(document, window, fetchStub, sessionStorage, FormDataStub);

const loginView = document.getElementById('login-view');
const dashboard = document.getElementById('dashboard');

const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
};

check('starts on the login view', loginView.hidden === false && dashboard.hidden === true);

loginForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 80));

check('token stored in sessionStorage', store.get('pablo_admin_token') === 'test-token');
check('dashboard becomes visible', dashboard.hidden === false);
check('login view is hidden', loginView.hidden === true);
check(
  'release list fetched with bearer token',
  calls.some((call) => call.url === '/api/admin/releases' && call.auth === 'Bearer test-token'),
);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nadmin login flow ok');
