/**
 * Deep Feed AI — RSS / JSON Feed / OPML render helpers
 *
 * Pure rendering — no DB, no HTTP. Shared by routes/feeds.js and test code.
 *
 * Kept stateless + dependency-free on purpose so feeds can be unit-tested
 * without spinning up Express or a Postgres fixture.
 */
'use strict';

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s) {
  return '<![CDATA[' + String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

function rfc822(d) {
  return new Date(d || Date.now()).toUTCString();
}

function renderItem(a, siteUrl) {
  const link  = `${siteUrl}/article/${a.slug}`;
  const title = a.generated_title || a.title || '(untitled)';
  const desc  = a.tldr_overview || a.summary
    || (a.full_content ? a.full_content.replace(/<[^>]+>/g, ' ').slice(0, 500) : '');
  let item = '<item>'
    + `<title>${cdata(title)}</title>`
    + `<link>${xmlEscape(link)}</link>`
    + `<guid isPermaLink="true">${xmlEscape(link)}</guid>`
    + `<pubDate>${rfc822(a.published_at)}</pubDate>`;
  if (a.writer_name) item += `<dc:creator>${cdata(a.writer_name)}</dc:creator>`;
  if (a.category)    item += `<category>${cdata(a.category)}</category>`;
  if (a.importance)  item += `<dfa:importance>${xmlEscape(a.importance)}</dfa:importance>`;
  if (desc)          item += `<description>${cdata(desc)}</description>`;
  if (a.full_content) item += `<content:encoded>${cdata(a.full_content)}</content:encoded>`;
  if (a.image_url)    item += `<media:thumbnail url="${xmlEscape(a.image_url)}"/>`;
  item += '</item>';
  return item;
}

function renderRSS({ siteUrl, siteName, tagline, feedPath, feedTitle, feedDescription, articles }) {
  const channelTitle = feedTitle || siteName;
  const channelDesc  = feedDescription || tagline;
  const lastBuild    = articles[0]?.published_at ? rfc822(articles[0].published_at) : new Date().toUTCString();
  const items = articles.map(a => renderItem(a, siteUrl)).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" '
    +   'xmlns:atom="http://www.w3.org/2005/Atom" '
    +   'xmlns:content="http://purl.org/rss/1.0/modules/content/" '
    +   'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    +   'xmlns:media="http://search.yahoo.com/mrss/" '
    +   'xmlns:dfa="https://deepfeedai.com/ns">'
    + '<channel>'
    +   `<title>${cdata(channelTitle)}</title>`
    +   `<link>${xmlEscape(siteUrl)}</link>`
    +   `<description>${cdata(channelDesc)}</description>`
    +   '<language>en-us</language>'
    +   `<lastBuildDate>${lastBuild}</lastBuildDate>`
    +   `<atom:link href="${xmlEscape(siteUrl + feedPath)}" rel="self" type="application/rss+xml"/>`
    +   items
    + '</channel></rss>';
}

function renderBriefsRSS({ siteUrl, siteName, events }) {
  const items = events.map(e => {
    const payload = (typeof e.payload === 'string' ? JSON.parse(e.payload || '{}') : (e.payload || {}));
    const isWeekly = e.event_type === 'weekly_digest';
    const dateStr = payload.period_range
      || new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const title = isWeekly ? `Week in Review — ${dateStr}` : `Day Brief — ${dateStr}`;
    const headline = payload.headline || '';
    const prose = payload.prose || payload.text || '';
    const desc = headline ? `${headline}\n\n${prose}` : prose;
    const link = `${siteUrl}/briefs/${e.id}`;
    return '<item>'
      + `<title>${cdata(title)}</title>`
      + `<link>${xmlEscape(link)}</link>`
      + `<guid isPermaLink="false">brief-${e.id}</guid>`
      + `<pubDate>${rfc822(e.created_at)}</pubDate>`
      + (desc ? `<description>${cdata(desc)}</description>` : '')
      + (prose ? `<content:encoded>${cdata(prose)}</content:encoded>` : '')
      + '</item>';
  }).join('');
  const lastBuild = events[0] ? rfc822(events[0].created_at) : new Date().toUTCString();
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">'
    + '<channel>'
    +   `<title>${cdata(siteName + ' — Editorial Briefs')}</title>`
    +   `<link>${xmlEscape(siteUrl)}</link>`
    +   `<description>${cdata("Maxwell's daily editorial brief and weekly digest from " + siteName)}</description>`
    +   '<language>en-us</language>'
    +   `<lastBuildDate>${lastBuild}</lastBuildDate>`
    +   `<atom:link href="${xmlEscape(siteUrl + '/feed/briefs.xml')}" rel="self" type="application/rss+xml"/>`
    +   items
    + '</channel></rss>';
}

function renderPodcastRSS({ siteUrl, siteName, tagline, coverUrl, articles }) {
  const items = articles.map(a => {
    const link = `${siteUrl}/article/${a.slug}`;
    const author = a.audio_voice_name || a.writer_name || siteName;
    const desc = a.summary || a.title || '';
    return '<item>'
      + `<title>${cdata(a.title || '(untitled)')}</title>`
      + `<link>${xmlEscape(link)}</link>`
      + `<guid isPermaLink="false">audio-${a.id}</guid>`
      + `<pubDate>${rfc822(a.published_at)}</pubDate>`
      + `<description>${cdata(desc)}</description>`
      + `<enclosure url="${xmlEscape(a.audio_url)}" type="audio/mpeg" length="0"/>`
      + `<itunes:author>${cdata(author)}</itunes:author>`
      + `<itunes:summary>${cdata(desc)}</itunes:summary>`
      + (a.image_url ? `<itunes:image href="${xmlEscape(a.image_url)}"/>` : '')
      + '<itunes:explicit>false</itunes:explicit>'
      + '</item>';
  }).join('');
  const lastBuild = articles[0] ? rfc822(articles[0].published_at) : new Date().toUTCString();
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" '
    +   'xmlns:atom="http://www.w3.org/2005/Atom" '
    +   'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" '
    +   'xmlns:content="http://purl.org/rss/1.0/modules/content/">'
    + '<channel>'
    +   `<title>${cdata(siteName)}</title>`
    +   `<link>${xmlEscape(siteUrl)}</link>`
    +   `<description>${cdata(tagline + ' — narrated articles')}</description>`
    +   '<language>en-us</language>'
    +   `<lastBuildDate>${lastBuild}</lastBuildDate>`
    +   `<atom:link href="${xmlEscape(siteUrl + '/podcast.xml')}" rel="self" type="application/rss+xml"/>`
    +   `<itunes:author>${cdata(siteName)}</itunes:author>`
    +   `<itunes:summary>${cdata(tagline)}</itunes:summary>`
    +   `<itunes:image href="${xmlEscape(coverUrl)}"/>`
    +   '<itunes:category text="News"/>'
    +   '<itunes:explicit>false</itunes:explicit>'
    +   `<image><url>${xmlEscape(coverUrl)}</url><title>${cdata(siteName)}</title><link>${xmlEscape(siteUrl)}</link></image>`
    +   items
    + '</channel></rss>';
}

function renderOPML({ siteUrl, siteName, writers, categories }) {
  function outline(text, xmlUrl, htmlUrl) {
    return `<outline type="rss" text="${xmlEscape(text)}" title="${xmlEscape(text)}" xmlUrl="${xmlEscape(xmlUrl)}" htmlUrl="${xmlEscape(htmlUrl)}"/>`;
  }
  const newsroomOutlines = ''
    + outline(`${siteName} — All Articles`, `${siteUrl}/feed.xml`, siteUrl)
    + outline(`${siteName} — Stories`, `${siteUrl}/feed/stories.xml`, `${siteUrl}/stories`)
    + outline(`${siteName} — Editorial Briefs`, `${siteUrl}/feed/briefs.xml`, siteUrl)
    + outline(`${siteName} — Podcast`, `${siteUrl}/podcast.xml`, siteUrl);
  const writerOutlines = (writers || []).map(w =>
    outline(w.name, `${siteUrl}/feed/writers/${w.slug}.xml`, `${siteUrl}/writers/${w.slug}`)
  ).join('');
  const categoryOutlines = (categories || []).map(c => {
    const slug = c.name.toLowerCase().replace(/\s+/g, '-');
    return outline(c.name, `${siteUrl}/feed/category/${slug}.xml`, `${siteUrl}/category/${slug}`);
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<opml version="2.0">'
    + '<head>'
    +   `<title>${xmlEscape(siteName + ' Feeds')}</title>`
    +   `<dateCreated>${rfc822(new Date())}</dateCreated>`
    + '</head>'
    + '<body>'
    +   `<outline text="Newsroom" title="Newsroom">${newsroomOutlines}</outline>`
    +   (writerOutlines    ? `<outline text="Writers" title="Writers">${writerOutlines}</outline>` : '')
    +   (categoryOutlines  ? `<outline text="Categories" title="Categories">${categoryOutlines}</outline>` : '')
    + '</body>'
    + '</opml>';
}

function renderJsonFeed({ siteUrl, siteName, tagline, articles }) {
  const items = articles.map(a => {
    const link = `${siteUrl}/article/${a.slug}`;
    const item = {
      id:    link,
      url:   link,
      title: a.generated_title || a.title || '(untitled)',
      date_published: new Date(a.published_at).toISOString(),
    };
    const summary = a.tldr_overview || a.summary;
    if (summary)        item.summary       = summary;
    if (a.full_content) item.content_html  = a.full_content;
    if (a.image_url)    item.image         = a.image_url;
    if (a.writer_name)  item.authors       = [{ name: a.writer_name }];
    const tags = [a.category, a.importance].filter(Boolean);
    if (tags.length)    item.tags          = tags;
    return item;
  });
  return {
    version:       'https://jsonfeed.org/version/1.1',
    title:         siteName,
    home_page_url: siteUrl,
    feed_url:      `${siteUrl}/feed.json`,
    description:   tagline,
    language:      'en-US',
    items,
  };
}

function renderStoriesRSS({ siteUrl, siteName, stories }) {
  const items = stories.map(s => {
    const link  = `${siteUrl}/story/${s.slug}`;
    // Bucket guid by day so n8n fires at most once per day per updated story
    const day   = new Date(s.last_activity_at).toISOString().slice(0, 10);
    const guid  = `story-${s.id}-${day}`;
    const count = s.article_count || 0;
    const desc  = s.summary
      ? `${s.summary} (${count} article${count !== 1 ? 's' : ''})`
      : `${count} article${count !== 1 ? 's' : ''} — developing story`;
    let item = '<item>'
      + `<title>${cdata(s.name)}</title>`
      + `<link>${xmlEscape(link)}</link>`
      + `<guid isPermaLink="false">${xmlEscape(guid)}</guid>`
      + `<pubDate>${rfc822(s.last_activity_at)}</pubDate>`
      + `<description>${cdata(desc)}</description>`
      + `<dfa:articleCount>${count}</dfa:articleCount>`
      + `<dfa:storyStatus>${xmlEscape(s.status || 'active')}</dfa:storyStatus>`;
    if (s.image_url) item += `<media:thumbnail url="${xmlEscape(s.image_url)}"/>`;
    item += '</item>';
    return item;
  }).join('');

  const lastBuild = stories[0]?.last_activity_at
    ? rfc822(stories[0].last_activity_at) : new Date().toUTCString();

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" '
    +   'xmlns:atom="http://www.w3.org/2005/Atom" '
    +   'xmlns:media="http://search.yahoo.com/mrss/" '
    +   'xmlns:dfa="https://deepfeedai.com/ns">'
    + '<channel>'
    +   `<title>${cdata(siteName + ' — Stories')}</title>`
    +   `<link>${xmlEscape(siteUrl + '/stories')}</link>`
    +   `<description>${cdata('Developing news stories tracked by ' + siteName)}</description>`
    +   '<language>en-us</language>'
    +   `<lastBuildDate>${lastBuild}</lastBuildDate>`
    +   `<atom:link href="${xmlEscape(siteUrl + '/feed/stories.xml')}" rel="self" type="application/rss+xml"/>`
    +   items
    + '</channel></rss>';
}

module.exports = {
  xmlEscape, cdata, rfc822,
  renderItem, renderRSS, renderBriefsRSS, renderPodcastRSS,
  renderStoriesRSS, renderOPML, renderJsonFeed,
};
