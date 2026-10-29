/* PABLO admin — release management */

const PLATFORMS = [
  'Spotify',
  'Apple Music',
  'YouTube Music',
  'Beatport',
  'SoundCloud',
  'Deezer',
  'Tidal',
  'Amazon Music',
  'Traxsource',
  'Bandcamp',
  'Other',
];

const loginView = document.getElementById('login-view');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutButton = document.getElementById('logout');
const statusLine = document.getElementById('admin-status');
const releaseForm = document.getElementById('release-form');
const formTitle = document.getElementById('form-title');
const formError = document.getElementById('form-error');
const coverInput = document.getElementById('cover-input');
const coverPreview = document.getElementById('cover-preview');
const linkRows = document.getElementById('link-rows');
const releaseList = document.getElementById('release-list');
const favouriteForm = document.getElementById('favourite-form');
const favouriteFormTitle = document.getElementById('favourite-form-title');
const favouriteError = document.getElementById('favourite-error');
const favouriteCoverInput = document.getElementById('favourite-cover-input');
const favouriteCoverPreview = document.getElementById('favourite-cover-preview');
const favouriteList = document.getElementById('favourite-list');
const favouriteStatus = document.getElementById('favourite-status');

const state = {
  releases: [],
  editingId: null,
  cover: null,
  favourites: [],
  editingFavouriteId: null,
  favouriteCover: null,
};

// The session token travels in a header and lives in sessionStorage, so the
// dashboard stays signed in even where the browser drops the session cookie
// (embedded frames, third-party cookie blocking, plain-http dev previews).
const TOKEN_KEY = 'pablo_admin_token';

function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked — the cookie still covers direct visits */
  }
}

function authHeaders(headers = {}) {
  let token = null;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
}

init();

// The Worker compares a hash of a browser-derived PBKDF2 key instead of running
// PBKDF2 itself: a full server-side derivation outruns the Workers free plan's
// 10ms CPU budget and the request dies before the password is ever checked.
let loginParams = null;

async function loadLoginParams() {
  try {
    const response = await fetch('/api/admin/login-params', {
      headers: { accept: 'application/json' },
    });
    loginParams = response.ok ? await response.json() : null;
  } catch {
    loginParams = null;
  }
}

async function deriveLoginKey(password, params) {
  const binary = atob(params.salt);
  const salt = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) salt[i] = binary.charCodeAt(i);

  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: params.iterations,
        hash: 'SHA-256',
      },
      material,
      256,
    ),
  );

  let out = '';
  for (const byte of bits) out += String.fromCharCode(byte);
  return btoa(out);
}

async function init() {
  await loadLoginParams();
  try {
    const response = await fetch('/api/admin/session', {
      headers: authHeaders({ accept: 'application/json' }),
    });
    const data = response.ok ? await response.json() : {};
    if (data.authenticated) await showDashboard();
    else showLogin();
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginView.hidden = false;
  dashboard.hidden = true;
  logoutButton.hidden = true;
  loginForm.elements.username.focus();
}

async function showDashboard() {
  loginView.hidden = true;
  dashboard.hidden = false;
  logoutButton.hidden = false;
  await Promise.all([loadReleases(), loadFavourites()]);
}

async function loadReleases() {
  try {
    const response = await fetch('/api/admin/releases', {
      headers: authHeaders({ accept: 'application/json' }),
    });
    if (response.status === 401) {
      showLogin();
      return;
    }
    const data = response.ok ? await response.json() : { releases: [] };
    state.releases = Array.isArray(data.releases) ? data.releases : [];
    renderList();
  } catch {
    releaseList.innerHTML = '<p class="admin-empty">Releases could not be loaded right now.</p>';
  }
}

function renderList() {
  if (!state.releases.length) {
    releaseList.innerHTML =
      '<p class="admin-empty">No releases yet. Use “New release” to add your first one.</p>';
    return;
  }

  releaseList.innerHTML = state.releases
    .map((release) => {
      const date = formatDate(release.releaseDate);
      const linkCount = release.links.length;
      const cover = release.coverUrl
        ? `<img src="${escapeAttribute(release.coverUrl)}" alt="" loading="lazy" />`
        : '<span>NO ART</span>';

      return `
        <article class="admin-item">
          <div class="admin-item__cover">${cover}</div>
          <div>
            <h3>${escapeHtml(release.title)}</h3>
            <p>${[date, `${linkCount} ${linkCount === 1 ? 'link' : 'links'}`]
              .filter(Boolean)
              .map(escapeHtml)
              .join(' · ')}</p>
          </div>
          <div class="admin-item__actions">
            <button type="button" data-edit="${escapeAttribute(release.id)}">Edit</button>
            <button type="button" data-delete="${escapeAttribute(release.id)}">Delete</button>
          </div>
        </article>`;
    })
    .join('');
}

releaseList.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');

  if (editButton) {
    const release = state.releases.find((item) => item.id === editButton.dataset.edit);
    if (release) startEdit(release);
  }

  if (deleteButton) {
    const id = deleteButton.dataset.delete;
    const release = state.releases.find((item) => item.id === id);
    if (!window.confirm(`Delete “${release ? release.title : 'this release'}”?`)) return;
    await request(`/api/admin/releases/${id}`, { method: 'DELETE' });
    statusLine.textContent = 'Release deleted.';
    await loadReleases();
  }
});

document.getElementById('new-release').addEventListener('click', () => startCreate());

document.getElementById('cancel-edit').addEventListener('click', () => {
  releaseForm.hidden = true;
});

document.getElementById('add-link').addEventListener('click', () => addLinkRow());

logoutButton.addEventListener('click', async () => {
  await fetch('/api/admin/logout', {
    method: 'POST',
    headers: authHeaders({ accept: 'application/json' }),
  });
  setToken(null);
  window.location.reload();
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const data = new FormData(loginForm);

  try {
    const payload = { username: data.get('username') };
    if (loginParams && loginParams.mode === 'client-pbkdf2') {
      payload.key = await deriveLoginKey(String(data.get('password') || ''), loginParams);
    } else {
      payload.password = data.get('password');
    }

    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      loginError.textContent = body.error || 'Login failed.';
      return;
    }
    setToken(body.token || null);
    loginForm.reset();
    await showDashboard();
  } catch {
    loginError.textContent = 'Network error. Try again.';
  }
});

coverInput.addEventListener('change', async () => {
  formError.textContent = '';
  const file = coverInput.files && coverInput.files[0];
  if (!file) {
    state.cover = null;
    coverPreview.hidden = true;
    return;
  }
  try {
    state.cover = await prepareCover(file);
    coverPreview.src = state.cover.preview;
    coverPreview.hidden = false;
  } catch (error) {
    state.cover = null;
    coverPreview.hidden = true;
    formError.textContent = error.message;
  }
});

releaseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';

  const data = new FormData(releaseForm);
  const title = String(data.get('title') || '').trim();
  if (!title) {
    formError.textContent = 'A title is required.';
    return;
  }

  const links = [...linkRows.querySelectorAll('.admin-link-row')]
    .map((row) => ({
      platform: row.querySelector('select').value,
      url: row.querySelector('input').value.trim(),
    }))
    .filter((link) => link.url);

  const payload = {
    title,
    releaseDate: String(data.get('releaseDate') || ''),
    links,
  };
  if (state.cover) {
    payload.cover = { type: state.cover.type, data: state.cover.data };
  }

  const url = state.editingId
    ? `/api/admin/releases/${state.editingId}`
    : '/api/admin/releases';
  const method = state.editingId ? 'PUT' : 'POST';

  const saveButton = document.getElementById('save-release');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';

  try {
    const response = await request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response) return;

    statusLine.textContent = state.editingId
      ? 'Release updated.'
      : 'Release added — it is live on the site.';
    releaseForm.hidden = true;
    state.editingId = null;
    state.cover = null;
    releaseForm.reset();
    coverPreview.hidden = true;
    await loadReleases();
  } catch (error) {
    formError.textContent = error.message;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save release';
  }
});

/* ------------------------------------------------------------ favourites */

async function loadFavourites() {
  try {
    const response = await fetch('/api/admin/favourites', {
      headers: authHeaders({ accept: 'application/json' }),
    });
    if (response.status === 401) {
      setToken(null);
      showLogin();
      return;
    }
    const data = response.ok ? await response.json() : { favourites: [] };
    state.favourites = Array.isArray(data.favourites) ? data.favourites : [];
    renderFavourites();
  } catch {
    favouriteList.innerHTML =
      '<p class="admin-empty">Favourites could not be loaded right now.</p>';
  }
}

function renderFavourites() {
  if (!state.favourites.length) {
    favouriteList.innerHTML =
      '<p class="admin-empty">Nothing pinned yet. Add up to three tunes.</p>';
    return;
  }

  favouriteList.innerHTML = state.favourites
    .map((item) => {
      const cover = item.coverUrl
        ? `<img src="${escapeAttribute(item.coverUrl)}" alt="" loading="lazy" />`
        : '<span>NO ART</span>';
      const meta = [item.artist, formatDate(item.releaseDate)]
        .filter(Boolean)
        .map(escapeHtml)
        .join(' · ');

      return `
        <article class="admin-item">
          <div class="admin-item__cover">${cover}</div>
          <div>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${meta || 'No artist or date'}</p>
          </div>
          <div class="admin-item__actions">
            <button type="button" data-fav-edit="${escapeAttribute(item.id)}">Edit</button>
            <button type="button" data-fav-delete="${escapeAttribute(item.id)}">Delete</button>
          </div>
        </article>`;
    })
    .join('');
}

favouriteList.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-fav-edit]');
  const deleteButton = event.target.closest('[data-fav-delete]');

  if (editButton) {
    const item = state.favourites.find((entry) => entry.id === editButton.dataset.favEdit);
    if (item) startFavouriteEdit(item);
  }

  if (deleteButton) {
    const id = deleteButton.dataset.favDelete;
    const item = state.favourites.find((entry) => entry.id === id);
    if (!window.confirm(`Remove “${item ? item.title : 'this favourite'}”?`)) return;
    await request(`/api/admin/favourites/${id}`, { method: 'DELETE' });
    favouriteStatus.textContent = 'Favourite removed.';
    await loadFavourites();
  }
});

document.getElementById('new-favourite').addEventListener('click', () => startFavouriteCreate());

document.getElementById('cancel-favourite').addEventListener('click', () => {
  favouriteForm.hidden = true;
});

favouriteCoverInput.addEventListener('change', async () => {
  favouriteError.textContent = '';
  const file = favouriteCoverInput.files && favouriteCoverInput.files[0];
  if (!file) {
    state.favouriteCover = null;
    favouriteCoverPreview.hidden = true;
    return;
  }
  try {
    state.favouriteCover = await prepareCover(file);
    favouriteCoverPreview.src = state.favouriteCover.preview;
    favouriteCoverPreview.hidden = false;
  } catch (error) {
    state.favouriteCover = null;
    favouriteCoverPreview.hidden = true;
    favouriteError.textContent = error.message;
  }
});

favouriteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  favouriteError.textContent = '';

  const data = new FormData(favouriteForm);
  const title = String(data.get('title') || '').trim();
  const url = String(data.get('url') || '').trim();

  if (!title) {
    favouriteError.textContent = 'A title is required.';
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    favouriteError.textContent = 'Add a link starting with http:// or https://.';
    return;
  }
  if (!state.editingFavouriteId && !state.favouriteCover) {
    favouriteError.textContent = 'Add a cover image.';
    return;
  }

  const payload = {
    title,
    artist: String(data.get('artist') || '').trim(),
    releaseDate: String(data.get('releaseDate') || ''),
    url,
  };
  if (state.favouriteCover) {
    payload.cover = { type: state.favouriteCover.type, data: state.favouriteCover.data };
  }

  const target = state.editingFavouriteId
    ? `/api/admin/favourites/${state.editingFavouriteId}`
    : '/api/admin/favourites';
  const method = state.editingFavouriteId ? 'PUT' : 'POST';

  const saveButton = document.getElementById('save-favourite');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';

  try {
    await request(target, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    favouriteStatus.textContent = state.editingFavouriteId
      ? 'Favourite updated.'
      : 'Favourite added — it is live on the site.';
    favouriteForm.hidden = true;
    state.editingFavouriteId = null;
    state.favouriteCover = null;
    favouriteForm.reset();
    favouriteCoverPreview.hidden = true;
    await loadFavourites();
  } catch (error) {
    favouriteError.textContent = error.message;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save favourite';
  }
});

function startFavouriteCreate() {
  state.editingFavouriteId = null;
  state.favouriteCover = null;
  favouriteFormTitle.textContent = 'New favourite';
  favouriteError.textContent = '';
  favouriteStatus.textContent = '';
  favouriteForm.reset();
  favouriteCoverPreview.hidden = true;
  favouriteForm.hidden = false;
  favouriteForm.elements.title.focus();
  favouriteForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startFavouriteEdit(item) {
  state.editingFavouriteId = item.id;
  state.favouriteCover = null;
  favouriteFormTitle.textContent = 'Edit favourite';
  favouriteError.textContent = '';
  favouriteStatus.textContent = '';
  favouriteForm.reset();

  favouriteForm.elements.title.value = item.title;
  favouriteForm.elements.artist.value = item.artist || '';
  favouriteForm.elements.releaseDate.value = item.releaseDate || '';
  favouriteForm.elements.url.value = item.url || '';

  if (item.coverUrl) {
    favouriteCoverPreview.src = item.coverUrl;
    favouriteCoverPreview.hidden = false;
  } else {
    favouriteCoverPreview.hidden = true;
  }

  favouriteForm.hidden = false;
  favouriteForm.elements.title.focus();
  favouriteForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* --------------------------------------------------------------- helpers */

async function request(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders({ accept: 'application/json', ...(options.headers || {}) }),
  });
  const body = await response.json().catch(() => ({}));

  if (response.status === 401) {
    setToken(null);
    showLogin();
    throw new Error('Session expired — please sign in again.');
  }
  if (!response.ok) {
    throw new Error(body.error || 'Something went wrong.');
  }
  return body;
}

function startCreate() {
  state.editingId = null;
  state.cover = null;
  formTitle.textContent = 'New release';
  formError.textContent = '';
  statusLine.textContent = '';
  releaseForm.reset();
  coverPreview.hidden = true;
  linkRows.innerHTML = '';
  addLinkRow('Spotify');
  releaseForm.hidden = false;
  releaseForm.elements.title.focus();
  releaseForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startEdit(release) {
  state.editingId = release.id;
  state.cover = null;
  formTitle.textContent = 'Edit release';
  formError.textContent = '';
  statusLine.textContent = '';
  releaseForm.reset();

  releaseForm.elements.title.value = release.title;
  releaseForm.elements.releaseDate.value = release.releaseDate || '';

  linkRows.innerHTML = '';
  if (release.links.length) {
    release.links.forEach((link) => addLinkRow(link.platform, link.url));
  } else {
    addLinkRow();
  }

  if (release.coverUrl) {
    coverPreview.src = release.coverUrl;
    coverPreview.hidden = false;
  } else {
    coverPreview.hidden = true;
  }

  releaseForm.hidden = false;
  releaseForm.elements.title.focus();
  releaseForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function addLinkRow(platform = 'Spotify', url = '') {
  const row = document.createElement('div');
  row.className = 'admin-link-row';
  row.innerHTML = `
    <select aria-label="Platform">
      ${PLATFORMS.map(
        (name) =>
          `<option ${name === platform ? 'selected' : ''}>${escapeHtml(name)}</option>`,
      ).join('')}
    </select>
    <input type="url" placeholder="https://…" value="${escapeAttribute(url)}" aria-label="Link URL" />
    <button type="button" aria-label="Remove link">×</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  linkRows.appendChild(row);
}

function prepareCover(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      reject(new Error('Use a JPEG, PNG or WebP image.'));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error('Image is too large (max 8 MB).'));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#0b0713';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
      resolve({
        type: 'image/jpeg',
        data: dataUrl.split(',')[1],
        preview: dataUrl,
      });
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('That image could not be read.'));
    };

    image.src = objectUrl;
  });
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

const escapeAttribute = escapeHtml;
