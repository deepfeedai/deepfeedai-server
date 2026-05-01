/**
 * Deep Feed AI — RSS / JSON Feed / OPML render tests
 *
 * Pure unit tests against lib/rss-render.js. No DB, no Express, no network.
 * XML wellformedness is validated by spawning xmllint; if xmllint isn't
 * available on the runner, those assertions are skipped but field-level
 * checks still run.
 *
 *   node --test tests/rss-render.test.js
 */
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const R = require('../lib/rss-render');

// ── xmllint availability ────────────────────────────────────
function haveXmlLint() {
  try {
    const r = spawnSync('xmllint', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch { return false; }
}
const HAVE_XMLLINT = haveXmlLint();

function assertWellFormedXML(xml, label) {
  if (!HAVE_XMLLINT) {
    console.log(`  (skip wellformedness check — xmllint not available) ${label}`);
    return;
  }
  const r = spawnSync('xmllint', ['--noout', '-'], {
    input: xml,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`${label} is not well-formed XML:\n${r.stderr}\n--- first 400 chars ---\n${xml.slice(0, 400)}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────
const SITE = {
  siteUrl:  'https://acme.example.com',
  siteName: 'Acme News',
  tagline:  'Straight from the wire',
};

const ARTICLE = {
  id: 1,
  title: 'Tesla Q4 Earnings Beat Expectations',
  slug: 'tesla-q4-earnings',
  summary: 'Strong margins despite delivery softness.',
  full_content: '<p>Body text with <em>HTML</em> markup.</p>',
  image_url: 'https://cdn.example.com/tesla.jpg',
  category: 'Markets',
  published_at: '2026-04-19T14:00:00Z',
  writer_name: 'Priya Patel',
};

const TROUBLESOME_ARTICLE = {
  id: 2,
  title: 'Quotes "&" ampersand <tags> & apostrophes\' everywhere',
  slug: 'tricky-escaping',
  summary: 'A summary with ]]> sequence and & < > " \' all at once.',
  full_content: 'CDATA end ]]> and HTML <b>tags</b>',
  published_at: '2026-04-19T13:00:00Z',
  writer_name: "Marcus O'Brien",
  category: 'Tech & Policy',
};

// ── xmlEscape / cdata / rfc822 ──────────────────────────────
test('xmlEscape: escapes XML special characters', () => {
  assert.equal(R.xmlEscape('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
});

test('xmlEscape: handles null / undefined', () => {
  assert.equal(R.xmlEscape(null),      '');
  assert.equal(R.xmlEscape(undefined), '');
});

test('cdata: splits literal "]]>" sequences inside payload', () => {
  const out = R.cdata('end ]]> here');
  assert.ok(out.startsWith('<![CDATA['));
  assert.ok(out.endsWith(']]>'));
  assert.ok(out.includes(']]]]><![CDATA[>'),
    `expected the defensive split marker; got: ${out}`);
});

test('rfc822: returns RFC-822 date string', () => {
  const s = R.rfc822('2026-04-19T14:00:00Z');
  // "Sun, 19 Apr 2026 14:00:00 GMT" style
  assert.match(s, /GMT$/);
  assert.match(s, /^[A-Z][a-z]{2},\s\d{2}\s[A-Z][a-z]{2}\s\d{4}/);
});

// ── renderItem ──────────────────────────────────────────────
test('renderItem: produces expected structure', () => {
  const item = R.renderItem(ARTICLE, SITE.siteUrl);
  assert.ok(item.startsWith('<item>'));
  assert.ok(item.endsWith('</item>'));
  assert.ok(item.includes(`<link>${SITE.siteUrl}/article/${ARTICLE.slug}</link>`));
  assert.ok(item.includes('isPermaLink="true"'));
  assert.ok(item.includes('Tesla Q4 Earnings'));
  assert.ok(item.includes('<dc:creator>'));
  assert.ok(item.includes('<category>'));
  assert.ok(item.includes('<media:thumbnail'));
  assert.ok(item.includes('<content:encoded>'));
});

test('renderItem: omits optional fields when absent', () => {
  const minimal = { id: 9, title: 't', slug: 's', published_at: '2026-04-19T00:00:00Z' };
  const item = R.renderItem(minimal, SITE.siteUrl);
  assert.ok(!item.includes('<dc:creator>'));
  assert.ok(!item.includes('<category>'));
  assert.ok(!item.includes('<media:thumbnail'));
  assert.ok(!item.includes('<content:encoded>'));
});

// ── renderRSS ───────────────────────────────────────────────
test('renderRSS: produces well-formed XML', () => {
  const xml = R.renderRSS({ ...SITE, feedPath: '/feed.xml', articles: [ARTICLE, TROUBLESOME_ARTICLE] });
  assertWellFormedXML(xml, 'sitewide feed');
  assert.ok(xml.includes('<?xml version="1.0"'));
  assert.ok(xml.includes('<rss version="2.0"'));
  assert.ok(xml.includes('<atom:link'));
  assert.ok(xml.includes('<title>'));
  assert.ok(xml.includes('</channel></rss>'));
});

test('renderRSS: troublesome characters stay inside CDATA and do not break XML', () => {
  const xml = R.renderRSS({ ...SITE, feedPath: '/feed.xml', articles: [TROUBLESOME_ARTICLE] });
  assertWellFormedXML(xml, 'troublesome feed');
  // The bare ampersand + quotes shouldn't appear as literal unescaped XML
  // outside CDATA sections. Quick sanity check: the <link> element contains
  // xmlEscaped URL output, not raw special chars.
  const linkMatch = xml.match(/<link>([^<]+)<\/link>/);
  assert.ok(linkMatch, 'link tag present');
  assert.ok(!linkMatch[1].includes('<'));
  assert.ok(!linkMatch[1].includes('>'));
});

test('renderRSS: empty article list still renders valid XML', () => {
  const xml = R.renderRSS({ ...SITE, feedPath: '/feed.xml', articles: [] });
  assertWellFormedXML(xml, 'empty feed');
  assert.ok(xml.includes('<channel>'));
  assert.ok(!xml.includes('<item>'));
});

test('renderRSS: custom feedTitle + feedDescription override defaults', () => {
  const xml = R.renderRSS({
    ...SITE,
    feedPath: '/feed/writers/priya.xml',
    feedTitle: 'Priya Patel — Acme News',
    feedDescription: 'Per-writer digest',
    articles: [ARTICLE],
  });
  assert.ok(xml.includes('Priya Patel'));
  assert.ok(xml.includes('Per-writer digest'));
});

// ── renderBriefsRSS ─────────────────────────────────────────
test('renderBriefsRSS: daily + weekly events render as items', () => {
  const events = [
    {
      id: 101, event_type: 'weekly_digest', created_at: '2026-04-19T12:00:00Z',
      payload: { version: 2, period_range: 'Apr 13–Apr 19, 2026', headline: 'Big week', prose: 'Long prose here' },
    },
    {
      id: 100, event_type: 'daily_brief', created_at: '2026-04-18T18:00:00Z',
      payload: { version: 2, headline: 'Quiet day', prose: 'Not much happened.' },
    },
  ];
  const xml = R.renderBriefsRSS({ ...SITE, events });
  assertWellFormedXML(xml, 'briefs feed');
  assert.ok(xml.includes('Week in Review — Apr 13–Apr 19, 2026'));
  assert.ok(xml.includes('Day Brief'));
  assert.ok(xml.includes('Big week'));
  assert.ok(xml.includes('brief-100'));
  assert.ok(xml.includes('brief-101'));
});

test('renderBriefsRSS: legacy payload.text falls back when prose missing', () => {
  const events = [{
    id: 7, event_type: 'daily_brief', created_at: '2026-04-19T18:00:00Z',
    payload: { text: 'Legacy format brief body' },
  }];
  const xml = R.renderBriefsRSS({ ...SITE, events });
  assertWellFormedXML(xml, 'briefs feed legacy');
  assert.ok(xml.includes('Legacy format brief body'));
});

test('renderBriefsRSS: payload as JSON string also works', () => {
  const events = [{
    id: 8, event_type: 'daily_brief', created_at: '2026-04-19T18:00:00Z',
    payload: '{"headline":"stringified","prose":"Works"}',
  }];
  const xml = R.renderBriefsRSS({ ...SITE, events });
  assertWellFormedXML(xml, 'briefs feed stringified');
  assert.ok(xml.includes('Works'));
});

// ── renderPodcastRSS ────────────────────────────────────────
test('renderPodcastRSS: includes iTunes namespace + enclosure', () => {
  const articles = [{
    id: 1, title: 'Narrated article', slug: 'narrated', summary: 'Audio',
    published_at: '2026-04-19T14:00:00Z',
    audio_url: 'https://cdn.example.com/narrated.mp3',
    audio_voice_name: 'Priya',
    image_url: 'https://cdn.example.com/narrated.jpg',
    writer_name: 'Priya Patel',
  }];
  const xml = R.renderPodcastRSS({
    ...SITE, coverUrl: 'https://cdn.example.com/cover.jpg', articles,
  });
  assertWellFormedXML(xml, 'podcast feed');
  assert.ok(xml.includes('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"'));
  assert.ok(xml.includes('<enclosure url="https://cdn.example.com/narrated.mp3"'));
  assert.ok(xml.includes('type="audio/mpeg"'));
  assert.ok(xml.includes('<itunes:author>'));
  assert.ok(xml.includes('<itunes:image href="https://cdn.example.com/narrated.jpg"'));
  assert.ok(xml.includes('<itunes:category text="News"/>'));
  assert.ok(xml.includes('<itunes:explicit>false</itunes:explicit>'));
});

test('renderPodcastRSS: empty article list still renders valid XML', () => {
  const xml = R.renderPodcastRSS({ ...SITE, coverUrl: 'https://cdn/c.jpg', articles: [] });
  assertWellFormedXML(xml, 'empty podcast feed');
  assert.ok(xml.includes('<channel>'));
  assert.ok(!xml.includes('<item>'));
});

// ── renderOPML ──────────────────────────────────────────────
test('renderOPML: structure with writers + categories', () => {
  const writers    = [{ name: 'Priya Patel', slug: 'priya' }, { name: 'Marcus O\'Brien', slug: 'marcus' }];
  const categories = [{ name: 'Markets' }, { name: 'Tech & Policy' }];
  const xml = R.renderOPML({ ...SITE, writers, categories });
  assertWellFormedXML(xml, 'opml');
  assert.ok(xml.includes('<opml version="2.0">'));
  assert.ok(xml.includes('<outline text="Newsroom"'));
  assert.ok(xml.includes('<outline text="Writers"'));
  assert.ok(xml.includes('<outline text="Categories"'));
  assert.ok(xml.includes(`xmlUrl="${SITE.siteUrl}/feed/writers/priya.xml"`));
  assert.ok(xml.includes(`xmlUrl="${SITE.siteUrl}/feed/writers/marcus.xml"`));
  // Tech & Policy → tech-&amp;-policy in URL after lowercase/hyphenate; the &
  // inside the URL must be XML-escaped
  assert.ok(xml.includes('tech-&amp;-policy.xml') || xml.includes('tech-&amp;-policy'));
});

test('renderOPML: omits Writers section when no writers', () => {
  const xml = R.renderOPML({ ...SITE, writers: [], categories: [] });
  assertWellFormedXML(xml, 'opml empty');
  assert.ok(!xml.includes('<outline text="Writers"'));
  assert.ok(!xml.includes('<outline text="Categories"'));
  assert.ok(xml.includes('<outline text="Newsroom"'));
});

// ── renderJsonFeed ──────────────────────────────────────────
test('renderJsonFeed: conforms to JSON Feed 1.1 spec', () => {
  const feed = R.renderJsonFeed({ ...SITE, articles: [ARTICLE, TROUBLESOME_ARTICLE] });
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(feed.title, SITE.siteName);
  assert.equal(feed.home_page_url, SITE.siteUrl);
  assert.equal(feed.feed_url, `${SITE.siteUrl}/feed.json`);
  assert.ok(Array.isArray(feed.items));
  assert.equal(feed.items.length, 2);

  const first = feed.items[0];
  assert.equal(first.id, `${SITE.siteUrl}/article/${ARTICLE.slug}`);
  assert.equal(first.title, ARTICLE.title);
  assert.equal(first.content_html, ARTICLE.full_content);
  assert.equal(first.image, ARTICLE.image_url);
  assert.deepEqual(first.authors, [{ name: ARTICLE.writer_name }]);
  assert.deepEqual(first.tags, [ARTICLE.category]);

  // Date must be ISO 8601
  assert.match(first.date_published, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // Whole payload must be JSON-serializable without error
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(feed)));
});

test('renderJsonFeed: omits optional fields when source article lacks them', () => {
  const feed = R.renderJsonFeed({
    ...SITE,
    articles: [{ id: 3, title: 'bare', slug: 'bare', published_at: '2026-04-19T00:00:00Z' }],
  });
  const item = feed.items[0];
  assert.equal(item.title, 'bare');
  assert.ok(!('summary' in item));
  assert.ok(!('content_html' in item));
  assert.ok(!('image' in item));
  assert.ok(!('authors' in item));
  assert.ok(!('tags' in item));
});
