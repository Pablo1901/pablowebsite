import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const html = readFileSync('public/index.html', 'utf8');
const source = readFileSync('public/app.js', 'utf8');
const { window, document } = parseHTML(html);

const reply = (body) => ({ ok: true, status: 200, json: async () => body });

const favourites = [
  {
    id: 'a',
    title: 'Tune One',
    artist: 'Artist One',
    releaseDate: '2026-10-01',
    url: 'https://open.spotify.com/track/one',
    coverUrl: '/api/favourites/a/cover?v=1',
  },
  {
    id: 'b',
    title: 'Tune Two',
    artist: 'Artist Two',
    releaseDate: '2026-10-02',
    url: 'https://music.apple.com/two',
    coverUrl: '/api/favourites/b/cover?v=2',
  },
  {
    id: 'c',
    title: 'Tune Three',
    artist: 'Artist Three',
    releaseDate: '',
    url: 'https://soundcloud.com/three',
    coverUrl: null,
  },
];

async function fetchStub(url) {
  if (url === '/api/favourites') return reply({ favourites });
  if (url === '/api/episodes' || url === '/episodes.json') return reply({ episodes: [] });
  return reply({});
}

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const run = new Function(
  'document',
  'window',
  'IntersectionObserver',
  'fetch',
  'navigator',
  'setTimeout',
  source,
);

run(
  document,
  window,
  ObserverStub,
  fetchStub,
  { clipboard: { writeText: async () => {} } },
  setTimeout,
);

await new Promise((resolve) => setTimeout(resolve, 120));

const section = document.getElementById('favourites');
const grid = document.getElementById('favourites-grid');
const cards = [...grid.querySelectorAll('.fav')];

const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
};

check('section is visible after load', section.hidden === false && !section.hasAttribute('hidden'));
check('three cards rendered', cards.length === 3);
check('card links to the track', cards[0]?.getAttribute('href') === favourites[0].url);
check('card opens in a new tab', cards[0]?.getAttribute('target') === '_blank');
check('title and artist shown', cards[0]?.textContent.includes('Tune One') && cards[0]?.textContent.includes('Artist One'));
check('release date formatted', /1 Oct 2026/.test(cards[0]?.textContent || ''));
check('cover image rendered', Boolean(cards[0]?.querySelector('img')));
check('missing cover falls back to placeholder', Boolean(cards[2]?.querySelector('.fav__placeholder')));
check('empty date omitted', !cards[2]?.querySelector('.fav__date'));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nfavourites section ok');
