import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, epmcUrl, epmcToEvent, htmlToText, pageTitle, findFeed, textDiff, parseFeed, sha256 } from '../site/js/products-lib.js';

test('query from name + aliases, or custom', () => {
  assert.equal(buildQuery({ name: 'Visium HD', aliases: ['Visium High Definition', 'Visium HD'] }), '("Visium HD" OR "Visium High Definition")');
  assert.equal(buildQuery({ name: 'Xenium', search_query: 'Xenium AND "10x Genomics"' }), 'Xenium AND "10x Genomics"');
  const u = decodeURIComponent(epmcUrl('"CosMx"', { from: '2026-01-01', sort: 'CITED desc' }));
  assert.ok(u.includes('"CosMx" AND (FIRST_PDATE:[2026-01-01 TO 3000-12-31])') && u.includes('sort=CITED desc'));
});

test('Europe PMC record → event', () => {
  const e = epmcToEvent({ id: '123', source: 'MED', pmid: '123', doi: '10.1/ABC', title: 'A <i>Visium</i> study.', authorString: 'Li X, Wang G.',
    journalTitle: 'Nature', pubYear: '2026', firstPublicationDate: '2026-03-02', citedByCount: 5 });
  assert.equal(e.title, 'A Visium study');
  assert.equal(e.external_id, 'epmc:MED:123');
  assert.equal(e.url, 'https://doi.org/10.1/abc');
  assert.equal(e.event_date, '2026-03-02');
  assert.equal(e.payload.preprint, false);
});

const html = (body) => `<html><head><title>Visium HD &amp; more</title>
  <link rel="alternate" type="application/rss+xml" href="/news/feed.xml"></head>
  <body><nav>Menu Products Support</nav><script>var x=1</script><h1>Visium HD</h1>${body}<footer>© 2026 Vendor. All rights reserved.</footer></body></html>`;

test('page text, title, feed discovery', () => {
  const h = html('<p>Single-cell scale resolution across the whole transcriptome.</p>');
  const t = htmlToText(h);
  assert.ok(t.includes('Single-cell scale resolution') && !t.includes('var x') && !t.includes('Menu') && !t.includes('rights reserved'));
  assert.equal(pageTitle(h), 'Visium HD & more');
  assert.equal(findFeed(h, 'https://vendor.com/products/visium'), 'https://vendor.com/news/feed.xml');
});

test('diff reports newly added passages, ignores noise', () => {
  const a = htmlToText(html('<p>Single-cell scale resolution across the whole transcriptome.</p><p>Updated 1 March 2026</p>'));
  const b = htmlToText(html('<p>Single-cell scale resolution across the whole transcriptome.</p><p>Updated 2 April 2026</p>' +
    '<p>New: Visium HD 3\' now supports FFPE samples with 2 µm resolution and a new analysis pipeline.</p>'));
  const d = textDiff(a, b);
  assert.equal(d.addedCount, 1);
  assert.ok(d.added[0].startsWith("New: Visium HD 3' now supports FFPE"));
  assert.equal(textDiff(a, a).addedCount, 0);
});

test('RSS and Atom feeds', () => {
  const rss = `<rss><channel><item><title><![CDATA[Launch of CosMx 6K]]></title><link>https://v.com/n/1</link><guid>n1</guid>
    <pubDate>Tue, 04 Mar 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Big panel&lt;/p&gt;</description></item></channel></rss>`;
  assert.deepEqual(parseFeed(rss)[0], { id: 'n1', title: 'Launch of CosMx 6K', link: 'https://v.com/n/1', date: '2026-03-04', summary: 'Big panel' });
  const atom = `<feed><entry><title>Xenium Prime 5K</title><link href="https://x.com/a"/><id>tag:x,1</id><updated>2026-02-01T00:00:00Z</updated></entry></feed>`;
  assert.deepEqual(parseFeed(atom).map((x) => [x.id, x.link, x.date]), [['tag:x,1', 'https://x.com/a', '2026-02-01']]);
});

test('sha256', async () => assert.equal((await sha256('abc')).slice(0, 8), 'ba7816bf'));
