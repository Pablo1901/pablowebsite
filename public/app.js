/* PABLO — page behaviour: episodes, reveal animations, copy-email */

const SOUNDCLOUD_URL = 'https://soundcloud.com/pablo1901';
const PLAY_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';

/* ---------------------------------------------------------------- nav */

const nav = document.getElementById('nav');
const setNavState = () => nav.classList.toggle('is-scrolled', window.scrollY > 12);
setNavState();
window.addEventListener('scroll', setNavState, { passive: true });

/* ------------------------------------------------------------- reveal */

const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      revealObserver.unobserve(entry.target);
    }
  },
  { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
);

document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

/* ----------------------------------------------------------- episodes */

const episodesGrid = document.getElementById('episodes');
const episodesStatus = document.getElementById('episodes-status');

if (episodesGrid) {
  episodesGrid.innerHTML = Array.from(
    { length: 5 },
    () => `
      <div class="ep ep--skeleton" aria-hidden="true">
        <span class="ep__art"></span>
        <span class="ep__body">
          <span class="ep__title"></span>
          <span class="ep__meta"></span>
        </span>
      </div>`,
  ).join('');

  loadEpisodes();
}

async function loadEpisodes() {
  let payload = null;

  for (const source of ['/api/episodes', '/episodes.json']) {
    try {
      const response = await fetch(source, { headers: { accept: 'application/json' } });
      if (!response.ok) continue;
      const data = await response.json();
      if (data && Array.isArray(data.episodes) && data.episodes.length) {
        payload = data;
        break;
      }
    } catch {
      /* try the next source */
    }
  }

  episodesGrid.setAttribute('aria-busy', 'false');

  if (!payload) {
    renderEpisodesMessage(
      `Episodes can’t load right now. <a href="${SOUNDCLOUD_URL}" target="_blank" rel="noopener noreferrer">Listen to IMPACT on SoundCloud</a>.`,
    );
    return;
  }

  const impact = payload.episodes.filter((episode) => /impact/i.test(episode.title)).slice(0, 8);
  const list = impact.length ? impact : payload.episodes.slice(0, 8);

  episodesGrid.innerHTML = list
    .map((episode, index) => episodeCard(episode, index))
    .join('');

  episodesStatus.textContent = list.length
    ? `Showing the latest ${list.length} ${list.length === 1 ? 'episode' : 'episodes'} from SoundCloud.`
    : '';
}

function episodeCard(episode, index) {
  const number = (episode.title.match(/(\d{2,3})\s*$/) || [])[1];
  const badge = number ? `EP ${number}` : 'MIX';
  const date = formatDate(episode.publishedAt);
  const duration = formatDuration(episode.durationSeconds);
  const artwork = episode.artwork
    ? `<img src="${escapeAttribute(episode.artwork)}" alt="" width="500" height="500" loading="${index < 3 ? 'eager' : 'lazy'}" decoding="async" />`
    : '';

  return `
    <a class="ep" style="--i:${index}" href="${escapeAttribute(episode.url)}" target="_blank" rel="noopener noreferrer">
      <span class="ep__art">
        ${artwork}
        <span class="ep__badge">${escapeHtml(badge)}</span>
        ${index === 0 ? '<span class="ep__new">Latest</span>' : ''}
        <span class="ep__play">${PLAY_ICON}</span>
      </span>
      <span class="ep__body">
        <span class="ep__title">${escapeHtml(episode.title)}</span>
        <span class="ep__meta">
          ${date ? `<span>${escapeHtml(date)}</span>` : ''}
          ${date && duration ? '<span aria-hidden="true">·</span>' : ''}
          ${duration ? `<span>${escapeHtml(duration)}</span>` : ''}
        </span>
      </span>
    </a>`;
}

function renderEpisodesMessage(html) {
  episodesGrid.innerHTML = `<p class="episodes__empty">${html}</p>`;
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${Math.max(minutes, 1)}m`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

const escapeAttribute = escapeHtml;

/* ------------------------------------------------------------ releases */

const releasesGrid = document.getElementById('releases-grid');
const releasesEmpty = document.getElementById('releases-empty');

if (releasesGrid && releasesEmpty) loadReleases();

async function loadReleases() {
  try {
    const response = await fetch('/api/releases', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return;

    const data = await response.json();
    const releases = Array.isArray(data.releases) ? data.releases : [];
    if (!releases.length) return;

    releasesEmpty.hidden = true;
    releasesGrid.innerHTML = releases.map(releaseCard).join('');
  } catch {
    /* keep the empty state when the API is unavailable */
  }
}

function releaseCard(release) {
  const cover = release.coverUrl
    ? `<img src="${escapeAttribute(release.coverUrl)}" alt="" width="600" height="600" loading="lazy" decoding="async" />`
    : `<span class="release__placeholder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.4" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg></span>`;

  const links = (release.links || [])
    .map(
      (link) =>
        `<a class="release__link" href="${escapeAttribute(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.platform)}</a>`,
    )
    .join('');

  const date = release.releaseDate ? releaseDateLabel(release.releaseDate) : '';

  return `
    <article class="release">
      <div class="release__art">${cover}</div>
      <div class="release__body">
        <h3 class="release__title">${escapeHtml(release.title)}</h3>
        ${date ? `<p class="release__date">${escapeHtml(date)}</p>` : ''}
        ${links ? `<div class="release__links">${links}</div>` : ''}
      </div>
    </article>`;
}

function releaseDateLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/* --------------------------------------------------- current favourites */

const favouritesSection = document.getElementById('favourites');
const favouritesGrid = document.getElementById('favourites-grid');
const favouritesEmpty = document.getElementById('favourites-empty');

if (favouritesGrid) loadFavourites();

async function loadFavourites() {
  try {
    const response = await fetch('/api/favourites', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return;

    const data = await response.json();
    const items = Array.isArray(data.favourites) ? data.favourites.slice(0, 3) : [];
    if (!items.length) return;

    favouritesGrid.innerHTML = items.map(favouriteCard).join('');
    if (favouritesEmpty) favouritesEmpty.hidden = true;
    if (favouritesSection) favouritesSection.hidden = false;
  } catch {
    /* stay hidden when the list cannot be loaded */
  }
}

function favouriteCard(item) {
  const cover = item.coverUrl
    ? `<img src="${escapeAttribute(item.coverUrl)}" alt="" width="600" height="600" loading="lazy" decoding="async" />`
    : `<span class="fav__placeholder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9.2" /><circle cx="12" cy="12" r="2.4" /><path d="M12 2.8v3.2M12 18v3.2M2.8 12h3.2M18 12h3.2" /></svg></span>`;

  const date = item.releaseDate ? releaseDateLabel(item.releaseDate) : '';

  return `
    <a class="fav" href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">
      <span class="fav__art">${cover}</span>
      <span class="fav__body">
        <span class="fav__title">${escapeHtml(item.title)}</span>
        ${item.artist ? `<span class="fav__artist">${escapeHtml(item.artist)}</span>` : ''}
        ${date ? `<span class="fav__date">${escapeHtml(date)}</span>` : ''}
      </span>
    </a>`;
}

/* ------------------------------------------------------- copy email */

const copyButton = document.getElementById('copy-email');
const toast = document.getElementById('toast');
let toastTimer;

copyButton?.addEventListener('click', async () => {
  const email = copyButton.dataset.email || '';
  const copied = await copyText(email);
  showToast(copied ? 'Email copied — contact.pablomusic@proton.me' : `Email: ${email}`);
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    field.remove();
    return ok;
  }
}

function showToast(message) {
  if (!toast) return;
  toast.querySelector('span').textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('is-on');
    setTimeout(() => {
      toast.hidden = true;
    }, 240);
  }, 2600);
}
