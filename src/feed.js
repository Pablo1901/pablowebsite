/**
 * Minimal, dependency-free parser for the SoundCloud RSS feed.
 * Shared by the Worker (live /api/episodes) and the snapshot script.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

export function decodeXml(input = '') {
  return String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

const stripTags = (value) =>
  decodeXml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function pick(block, tag) {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'),
  );
  return match ? match[1].trim() : '';
}

function pickAttr(block, tag, attr) {
  const match = block.match(
    new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, 'i'),
  );
  return match ? match[1] : '';
}

/** SoundCloud serves square variants by rewriting the artwork suffix. */
export function squareArtwork(url, size = 500) {
  if (!url) return '';
  return url.replace(
    /-(t\d+x\d+|original|large|badge|crop|mini)\.(jpe?g|png|webp)$/i,
    `-t${size}x${size}.jpg`,
  );
}

function parseDuration(label) {
  const parts = String(label)
    .trim()
    .split(':')
    .map(Number);
  if (!parts.length || parts.some((value) => !Number.isFinite(value))) return 0;
  return parts.reduce((total, value) => total * 60 + value, 0);
}

export function parseFeed(xml) {
  const channelBlock = (xml.match(/<channel>([\s\S]*?)(?:<item>|<\/channel>)/i) || [])[1] || '';
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);

  const channelImage = squareArtwork(pickAttr(channelBlock, 'itunes:image', 'href'), 1000);
  const channel = {
    title: stripTags(pick(channelBlock, 'title')) || 'IMPACT Radio Show',
    description: stripTags(pick(channelBlock, 'description')),
    link: decodeXml(pick(channelBlock, 'link')),
    image: channelImage,
  };

  const episodes = itemBlocks
    .map((block) => {
      const title = stripTags(pick(block, 'title'));
      const publishedAt = new Date(decodeXml(pick(block, 'pubDate')));
      const duration = decodeXml(pick(block, 'itunes:duration'));
      return {
        id: decodeXml(pick(block, 'guid')) || decodeXml(pick(block, 'link')),
        title,
        url: decodeXml(pick(block, 'link')),
        publishedAt: Number.isNaN(publishedAt.getTime()) ? null : publishedAt.toISOString(),
        duration,
        durationSeconds: parseDuration(duration),
        artwork: squareArtwork(pickAttr(block, 'itunes:image', 'href')) || channelImage,
        show: /impact/i.test(title) ? 'IMPACT' : 'Mix',
      };
    })
    .filter((episode) => episode.url && episode.title)
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

  return { channel, episodes };
}
