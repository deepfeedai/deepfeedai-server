'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paperMarkup, safeAssetPath } = require('../public/edition-print');
const contributor = { writer_id: 3, name: 'Amina', kind: 'ai_persona', role: 'writer', focus: 'Business', bio: 'Configured focus on businesses.', contribution: 'Assigned writer for this article', profile_version: 'v1' };
const article = { article_id: 8, title: 'Business today', byline: 'Saved author', content: 'Saved text', contributor, portrait_path: '/api/editions/11111111-1111-4111-8111-111111111111/portraits/8' };
const edition = { name: 'Test edition', mode: 'proof', status: 'working', settings: { images: true, contributors: true, portraits: true }, articles: [article], contributors: [{ writer_id: 3, article_ids: [8], article_count: 1, versions: [{ ...contributor, article_ids: [8], portrait_path: article.portrait_path }] }] };
test('Captured contributor bylines and optional section have truthful labels and working article links', () => {
 const html = paperMarkup(edition);
 assert.match(html, /AI writer persona/); assert.match(html, /Assigned writer for this article/); assert.match(html, /Configured persona description:/);
 assert.match(html, /Assigned to 1 article in this issue/); assert.match(html, /href="#edition-article-8"/); assert.match(html, /id="edition-article-8"/);
 assert.equal((html.match(/class="edition-contributor-card"/g)||[]).length, 1);
});
test('Unknown authors and old snapshots are not labeled AI or enriched', () => {
 const html = paperMarkup({ ...edition, settings: {}, articles: [{ ...article, contributor: null, portrait_path: null }] });
 assert.match(html, /Saved author/); assert.doesNotMatch(html, /AI writer|Meet the contributors|<img/);
 const unknown = paperMarkup({ ...edition, settings: {}, articles: [{ ...article, contributor: { ...contributor, kind: 'unclassified' } }] });
 assert.doesNotMatch(unknown, /AI writer persona/);
});
test('Images-off and portrait toggle suppress portraits without removing contributor text', () => {
 for (const settings of [{ ...edition.settings, images: false }, { ...edition.settings, portraits: false }]) {
 const html = paperMarkup({ ...edition, settings }); assert.doesNotMatch(html, /<img/); assert.match(html, /Meet the contributors/); assert.match(html, /Amina/);
 }
 assert.doesNotMatch(paperMarkup({ ...edition, settings: { ...edition.settings, contributors: false } }), /Meet the contributors/);
});
test('Profile HTML is inert and distinct saved profile versions are disclosed', () => {
 const html = paperMarkup({ ...edition, contributors: [{ profile_versions_differ: true, versions: [{ ...contributor, name: '<img onerror=evil>', bio: '<script>evil</script>', article_ids: [8] }] }] });
 assert.match(html, /different saved profile versions/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<img onerror/);
});
test('Protected portrait paths have the same strict public/private boundary as hero images', () => {
 assert.equal(safeAssetPath('/api/editions/11111111-1111-4111-8111-111111111111/portraits/8', false), '/api/editions/11111111-1111-4111-8111-111111111111/portraits/8');
 assert.equal(safeAssetPath('/api/editions/public/11111111-1111-4111-8111-111111111111/portraits/8', true), '/api/editions/public/11111111-1111-4111-8111-111111111111/portraits/8');
 for (const value of ['/api/editions/11111111-1111-4111-8111-111111111111/portraits/8?token=x', 'https://x.test/portrait', '/api/editions/public/11111111-1111-4111-8111-111111111111/portraits/8']) assert.equal(safeAssetPath(value, false), null);
});
test('Missing captured portraits are visible notices, suppressed when images are off', () => {
 const e = { ...edition, articles: [{ ...article, portrait_path: null, contributor: { ...contributor, portrait_notice: 'Portrait unavailable in captured profile.' } }] };
 assert.match(paperMarkup(e), /Portrait unavailable in captured profile/);
 assert.doesNotMatch(paperMarkup({ ...e, settings: { ...e.settings, images: false } }), /Portrait unavailable/);
});
