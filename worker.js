import { parseFeed } from './src/feed.js';

const FEED_URL =
  'https://feeds.soundcloud.com/users/soundcloud:users:339829584/sounds.rss';
const EPISODES_PATH = '/api/episodes';
const CACHE_SECONDS = 900;

const SESSION_COOKIE = 'pablo_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COVER_BYTES = 1_500_000;
const MAX_BODY_CHARS = 3_000_000;

// Single admin account. Only a salted hash is stored here — never the password.
// Regenerate with: node scripts/hash-password.mjs "new password"
//
// mode 'client-pbkdf2' — the browser derives PBKDF2-SHA256(password) and this
//   Worker hashes that key once. Full PBKDF2 strength, microseconds of CPU, so
//   it fits the Workers free plan's 10ms budget (a server-side PBKDF2 run blows
//   it and fails with error 1102). Offline guessing still costs an attacker a
//   full PBKDF2 per attempt, so the hash in this repo stays expensive to crack.
// mode 'pbkdf2' — legacy server-side PBKDF2, needs the Workers paid plan.
const ADMIN = {
  username: 'pablo',
  mode: 'client-pbkdf2',
  salt: 'GVSgw/zz3Dx5MY1enSn3yQ==',
  hash: 'RuryeTDacUmdVabdYbrtqrxUlF+MSpvarC7FM69dy7c=',
  iterations: 210000,
};

const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/* ------------------------------------------------------------------ utils */

const encoder = new TextEncoder();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Base64(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToBase64(new Uint8Array(digest));
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyCredentials(username, password, key) {
  if (typeof username !== 'string' || !username || username.length > 80) {
    return false;
  }

  const usernameOk = constantTimeEqual(username, ADMIN.username) ? 1 : 0;

  if (ADMIN.mode === 'client-pbkdf2') {
    // `key` is the base64 PBKDF2 output computed in the browser. Never fall back
    // to accepting the raw password here: that would be a weaker credential.
    if (typeof key !== 'string' || !key || key.length > 100) return false;
    let bytes;
    try {
      bytes = bytesFromBase64(key);
    } catch {
      return false;
    }
    if (bytes.length !== 32) return false;
    const digest = await sha256Base64(bytes);
    return Boolean((constantTimeEqual(digest, ADMIN.hash) ? 1 : 0) & usernameOk);
  }

  if (typeof password !== 'string' || !password || password.length > 200) {
    return false;
  }

  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: bytesFromBase64(ADMIN.salt),
        iterations: ADMIN.iterations,
        hash: 'SHA-256',
      },
      material,
      256,
    ),
  );
  const expected = bytesFromBase64(ADMIN.hash);

  let passwordOk = bits.length === expected.length ? 1 : 0;
  const length = Math.min(bits.length, expected.length);
  for (let i = 0; i < length; i += 1) {
    passwordOk &= bits[i] === expected[i] ? 1 : 0;
  }
  return Boolean(passwordOk & usernameOk);
}

// Exposed for scripts/test-auth.mjs; not used by the Worker itself.
export const __auth = { verifyCredentials, sha256Base64, ADMIN };

/* -------------------------------------------------------------------- db */

let schemaPromise = null;

function ensureSchema(env) {
  if (!env.DB) return Promise.reject(new Error('storage_unavailable'));
  if (!schemaPromise) {
    schemaPromise = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        release_date TEXT NOT NULL DEFAULT '',
        links TEXT NOT NULL DEFAULT '[]',
        cover BLOB,
        cover_type TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS favourites (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        release_date TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        cover BLOB,
        cover_type TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )`),
      env.DB.prepare(
        'CREATE INDEX IF NOT EXISTS releases_date_idx ON releases (release_date)',
      ),
    ]).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function publicRelease(row) {
  let links = [];
  try {
    links = JSON.parse(row.links || '[]');
  } catch {
    links = [];
  }
  return {
    id: row.id,
    title: row.title,
    releaseDate: row.release_date,
    links: Array.isArray(links) ? links : [],
    coverUrl: row.has_cover
      ? `/api/releases/${row.id}/cover?v=${row.updated_at}`
      : null,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------ favourites */

function publicFavourite(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    releaseDate: row.release_date,
    url: row.url,
    coverUrl: row.has_cover
      ? `/api/favourites/${row.id}/cover?v=${row.updated_at}`
      : null,
    updatedAt: row.updated_at,
  };
}

async function listFavourites(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, artist, release_date, url, updated_at,
            (cover IS NOT NULL) AS has_cover
     FROM favourites
     ORDER BY created_at ASC
     LIMIT 3`,
  ).all();
  return (results || []).map(publicFavourite);
}

/* --------------------------------------------------------------- sessions */

async function readSession(request, env) {
  const cookies = parseCookies(request.headers.get('cookie') || '');
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
  // Bearer token first: it keeps the dashboard signed in even where the
  // browser refuses the cookie (embedded frames, third-party cookie blocking).
  const token = bearer ? bearer[1] : cookies[SESSION_COOKIE];
  if (!token || token.length > 200) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT expires_at FROM sessions WHERE token_hash = ?',
  )
    .bind(tokenHash)
    .first();

  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
    return null;
  }
  return { tokenHash };
}

const loginAttempts = new Map();

function clientKey(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'local'
  );
}

function tooManyAttempts(key) {
  const entry = loginAttempts.get(key);
  if (!entry || entry.reset < Date.now()) return false;
  return entry.count >= 6;
}

function recordFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.reset < now) {
    loginAttempts.set(key, { count: 1, reset: now + 10 * 60 * 1000 });
  } else {
    entry.count += 1;
  }
  if (loginAttempts.size > 500) loginAttempts.clear();
}

function sameOrigin(request, url) {
  // A bearer token is never attached automatically by the browser, so a
  // malicious page cannot ride on it: only cookie sessions need this check.
  if (request.headers.get('authorization')) return true;

  const origin = request.headers.get('origin');
  if (!origin) return true;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  // Behind the preview proxy/TLS termination the incoming URL is the internal
  // socket (127.0.0.1:3000), so compare against the Host header too.
  const host = request.headers.get('host');
  return originHost === host || originHost === url.host;
}

async function handleLogin(request, env, url) {
  const key = clientKey(request);
  if (tooManyAttempts(key)) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  const parsed = await readBody(request);
  if (parsed.error) return parsed.error;

  const ok = await verifyCredentials(
    parsed.data.username,
    parsed.data.password,
    parsed.data.key,
  );
  if (!ok) {
    recordFailure(key);
    return json({ error: 'Invalid username or password.' }, 401);
  }

  const token = `${crypto.randomUUID().replace(/-/g, '')}${crypto
    .randomUUID()
    .replace(/-/g, '')}`;
  const expires = Date.now() + SESSION_TTL_MS;

  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)',
  )
    .bind(await sha256Hex(token), expires)
    .run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?')
    .bind(Date.now())
    .run();

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}${isLocal ? '' : '; Secure'}`;

  return json({ ok: true, token }, 200, { 'set-cookie': cookie });
}

async function handleLogout(request, env) {
  const session = await readSession(request, env);
  if (session) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(session.tokenHash)
      .run();
  }
  const cookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

/* --------------------------------------------------------------- releases */

async function readBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_CHARS) {
    return { error: json({ error: 'Upload is too large.' }, 413) };
  }
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) {
      return { error: json({ error: 'Upload is too large.' }, 413) };
    }
    return { data: JSON.parse(raw || '{}') };
  } catch {
    return { error: json({ error: 'Invalid request body.' }, 400) };
  }
}

function cleanLinks(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (link) =>
        link &&
        typeof link.url === 'string' &&
        /^https?:\/\//i.test(link.url.trim()),
    )
    .slice(0, 12)
    .map((link) => ({
      platform: String(link.platform || 'Link').slice(0, 40),
      url: link.url.trim().slice(0, 500),
    }));
}

function decodeCover(input) {
  if (!input || !input.data) return { bytes: null, type: null };
  const type = String(input.type || '');
  if (!COVER_TYPES.includes(type)) {
    return { error: 'Use a JPEG, PNG or WebP cover.' };
  }
  try {
    const base64 = String(input.data).replace(/^data:[^;]+;base64,/, '');
    const bytes = bytesFromBase64(base64);
    if (!bytes.length) return { bytes: null, type: null };
    if (bytes.length > MAX_COVER_BYTES) {
      return { error: 'Cover is too large (max 1.5 MB after resizing).' };
    }
    return {
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
      type,
    };
  } catch {
    return { error: 'Cover could not be read.' };
  }
}

function releasePayload(body) {
  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) return { error: 'A title is required.' };
  const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(body.releaseDate || '')
    ? body.releaseDate
    : '';
  const supplied = (Array.isArray(body.links) ? body.links : [])
    .filter((link) => link && typeof link.url === 'string' && link.url.trim())
    .slice(0, 12);
  const links = cleanLinks(body.links);
  if (links.length < supplied.length) {
    return {
      error: 'Links must be full addresses starting with http:// or https://.',
    };
  }

  const cover = decodeCover(body.cover);
  if (cover.error) return { error: cover.error };
  return { title, releaseDate, links, cover };
}

async function listPublicReleases(env) {
  try {
    await ensureSchema(env);
  } catch {
    return json({ releases: [] }, 200, { 'cache-control': 'no-store' });
  }
  const { results } = await env.DB.prepare(
    `SELECT id, title, release_date, links, updated_at,
            (cover IS NOT NULL) AS has_cover
     FROM releases
     ORDER BY release_date DESC, created_at DESC`,
  ).all();
  return json(
    { releases: (results || []).map(publicRelease) },
    200,
    { 'cache-control': 'public, max-age=30' },
  );
}

async function listAllReleases(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, release_date, links, updated_at,
            (cover IS NOT NULL) AS has_cover
     FROM releases
     ORDER BY release_date DESC, created_at DESC`,
  ).all();
  return json({ releases: (results || []).map(publicRelease) });
}

async function serveStoredCover(env, table, id) {
  try {
    await ensureSchema(env);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const row = await env.DB.prepare(
    `SELECT cover, cover_type FROM ${table} WHERE id = ?`,
  )
    .bind(id)
    .first();

  if (!row || !row.cover) return new Response('Not found', { status: 404 });

  return new Response(row.cover, {
    headers: {
      'content-type': COVER_TYPES.includes(row.cover_type)
        ? row.cover_type
        : 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

function serveCover(env, id) {
  return serveStoredCover(env, 'releases', id);
}

function serveFavouriteCover(env, id) {
  return serveStoredCover(env, 'favourites', id);
}

async function createRelease(request, env) {
  const parsed = await readBody(request);
  if (parsed.error) return parsed.error;

  const payload = releasePayload(parsed.data);
  if (payload.error) return json({ error: payload.error }, 400);

  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO releases
      (id, title, release_date, links, cover, cover_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      payload.title,
      payload.releaseDate,
      JSON.stringify(payload.links),
      payload.cover.bytes,
      payload.cover.type,
      now,
      now,
    )
    .run();

  return json({ ok: true, id }, 201);
}

async function updateRelease(request, env, id) {
  const existing = await env.DB.prepare(
    'SELECT id FROM releases WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!existing) return json({ error: 'Release not found.' }, 404);

  const parsed = await readBody(request);
  if (parsed.error) return parsed.error;

  const payload = releasePayload(parsed.data);
  if (payload.error) return json({ error: payload.error }, 400);

  const now = Date.now();
  const fields = ['title = ?', 'release_date = ?', 'links = ?', 'updated_at = ?'];
  const values = [
    payload.title,
    payload.releaseDate,
    JSON.stringify(payload.links),
    now,
  ];

  if (payload.cover.bytes) {
    fields.push('cover = ?', 'cover_type = ?');
    values.push(payload.cover.bytes, payload.cover.type);
  }

  values.push(id);
  await env.DB.prepare(
    `UPDATE releases SET ${fields.join(', ')} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  return json({ ok: true });
}

async function deleteRelease(env, id) {
  await env.DB.prepare('DELETE FROM releases WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/* ------------------------------------------------- favourites (admin + io) */

function favouritePayload(body) {
  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) return { error: 'A title is required.' };
  const artist = String(body.artist || '').trim().slice(0, 120);
  const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(body.releaseDate || '')
    ? body.releaseDate
    : '';
  const url = String(body.url || '').trim().slice(0, 500);
  if (!/^https?:\/\//i.test(url)) {
    return { error: 'Add a link starting with http:// or https://.' };
  }

  const cover = decodeCover(body.cover);
  if (cover.error) return { error: cover.error };
  return { title, artist, releaseDate, url, cover };
}

async function listPublicFavourites(env) {
  try {
    await ensureSchema(env);
  } catch {
    return json({ favourites: [] }, 200, { 'cache-control': 'no-store' });
  }
  return json(
    { favourites: await listFavourites(env) },
    200,
    { 'cache-control': 'public, max-age=30' },
  );
}

async function listAllFavourites(env) {
  return json({ favourites: await listFavourites(env) });
}

async function createFavourite(request, env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM favourites').first();
  if (Number(row && row.n) >= 3) {
    return json({ error: 'You can pin three favourites — remove one first.' }, 400);
  }

  const parsed = await readBody(request);
  if (parsed.error) return parsed.error;

  const payload = favouritePayload(parsed.data);
  if (payload.error) return json({ error: payload.error }, 400);
  if (!payload.cover.bytes) return json({ error: 'Add a cover image.' }, 400);

  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO favourites
      (id, title, artist, release_date, url, cover, cover_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      payload.title,
      payload.artist,
      payload.releaseDate,
      payload.url,
      payload.cover.bytes,
      payload.cover.type,
      now,
      now,
    )
    .run();

  return json({ ok: true, id }, 201);
}

async function updateFavourite(request, env, id) {
  const existing = await env.DB.prepare('SELECT id FROM favourites WHERE id = ?')
    .bind(id)
    .first();
  if (!existing) return json({ error: 'Favourite not found.' }, 404);

  const parsed = await readBody(request);
  if (parsed.error) return parsed.error;

  const payload = favouritePayload(parsed.data);
  if (payload.error) return json({ error: payload.error }, 400);

  const fields = ['title = ?', 'artist = ?', 'release_date = ?', 'url = ?', 'updated_at = ?'];
  const values = [
    payload.title,
    payload.artist,
    payload.releaseDate,
    payload.url,
    Date.now(),
  ];

  if (payload.cover.bytes) {
    fields.push('cover = ?', 'cover_type = ?');
    values.push(payload.cover.bytes, payload.cover.type);
  }

  values.push(id);
  await env.DB.prepare(`UPDATE favourites SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return json({ ok: true });
}

async function deleteFavourite(env, id) {
  await env.DB.prepare('DELETE FROM favourites WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/* ----------------------------------------------------------------- admin */

async function handleAdmin(request, env, url) {
  try {
    await ensureSchema(env);
  } catch {
    return json({ error: 'Storage is not configured.' }, 503);
  }

  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/admin/session' && method === 'GET') {
    const session = await readSession(request, env);
    return json({ authenticated: Boolean(session) });
  }

  if (pathname === '/api/admin/login-params' && method === 'GET') {
    // Public on purpose: the salt and iteration count are not secrets, and the
    // browser needs them to derive the key before signing in.
    return json({
      mode: ADMIN.mode,
      salt: ADMIN.mode === 'client-pbkdf2' ? ADMIN.salt : null,
      iterations: ADMIN.mode === 'client-pbkdf2' ? ADMIN.iterations : null,
    });
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    return handleLogin(request, env, url);
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    return handleLogout(request, env);
  }

  if (method !== 'GET' && !sameOrigin(request, url)) {
    return json({ error: 'Forbidden.' }, 403);
  }

  const session = await readSession(request, env);
  if (!session) return json({ error: 'Unauthorized.' }, 401);

  if (pathname === '/api/admin/releases') {
    if (method === 'GET') return listAllReleases(env);
    if (method === 'POST') return createRelease(request, env);
  }

  const match = pathname.match(/^\/api\/admin\/releases\/([\w-]+)$/);
  if (match) {
    if (method === 'PUT') return updateRelease(request, env, match[1]);
    if (method === 'DELETE') return deleteRelease(env, match[1]);
  }

  if (pathname === '/api/admin/favourites') {
    if (method === 'GET') return listAllFavourites(env);
    if (method === 'POST') return createFavourite(request, env);
  }

  const favouriteMatch = pathname.match(/^\/api\/admin\/favourites\/([\w-]+)$/);
  if (favouriteMatch) {
    if (method === 'PUT') return updateFavourite(request, env, favouriteMatch[1]);
    if (method === 'DELETE') return deleteFavourite(env, favouriteMatch[1]);
  }

  return json({ error: 'Not found.' }, 404);
}

/* --------------------------------------------------------------- episodes */

function episodesJson(body, status = 200, headers = {}) {
  return json(body, status, headers);
}

async function loadEpisodes(ctx, request) {
  const cache = typeof caches !== 'undefined' ? caches.default : undefined;
  const cacheKey = new Request(new URL(EPISODES_PATH, request.url).toString(), {
    method: 'GET',
  });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  try {
    upstream = await fetch(FEED_URL, {
      headers: {
        'user-agent': 'PABLO-site/1.0',
        accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      },
      cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
    });
  } catch {
    return episodesJson({ error: 'feed_unreachable' }, 502);
  }

  if (!upstream.ok) {
    return episodesJson({ error: 'feed_error', status: upstream.status }, 502);
  }

  const feed = parseFeed(await upstream.text());
  const response = episodesJson(
    { ...feed, fetchedAt: new Date().toISOString(), source: FEED_URL },
    200,
    {
      'cache-control': `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
    },
  );

  if (cache && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

/* ----------------------------------------------------------------- routes */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === EPISODES_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'method_not_allowed' }, 405, {
          allow: 'GET, HEAD',
        });
      }
      return loadEpisodes(ctx, request);
    }

    if (pathname === '/api/releases' && request.method === 'GET') {
      return listPublicReleases(env);
    }

    const coverMatch = pathname.match(/^\/api\/releases\/([\w-]+)\/cover$/);
    if (coverMatch && request.method === 'GET') {
      return serveCover(env, coverMatch[1]);
    }

    if (pathname === '/api/favourites' && request.method === 'GET') {
      return listPublicFavourites(env);
    }

    const favouriteCover = pathname.match(/^\/api\/favourites\/([\w-]+)\/cover$/);
    if (favouriteCover && request.method === 'GET') {
      return serveFavouriteCover(env, favouriteCover[1]);
    }

    if (pathname.startsWith('/api/admin/')) {
      return handleAdmin(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};
