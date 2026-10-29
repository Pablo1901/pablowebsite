import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseFeed } from '../src/feed.js';

const FEED_URL =
  process.env.FEED_URL ??
  'https://feeds.soundcloud.com/users/soundcloud:users:339829584/sounds.rss';

const response = await fetch(FEED_URL, {
  headers: { 'user-agent': 'PABLO-site/1.0', accept: 'application/rss+xml' },
});

if (!response.ok) {
  throw new Error(`Feed responded with HTTP ${response.status}`);
}

const feed = parseFeed(await response.text());
const payload = {
  ...feed,
  fetchedAt: new Date().toISOString(),
  source: FEED_URL,
};

const output = fileURLToPath(new URL('../public/episodes.json', import.meta.url));
await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);

console.log(
  `Wrote ${feed.episodes.length} episodes (${feed.episodes.filter((e) => e.show === 'IMPACT').length} IMPACT) to public/episodes.json`,
);
