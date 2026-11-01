// Runs scripts/track-products.mjs against a local stub of Supabase REST + a vendor site.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { htmlToText, sha256 } from '../site/js/products-lib.js';

const page = (extra) => `<html><head><title>Visium HD</title><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>
  <body><p>Whole transcriptome at single-cell scale resolution on standard slides.</p>${extra}</body></html>`;

test('tracker records page changes and feed items via Supabase REST', async () => {
  const oldText = htmlToText(page(''));
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push({ m: req.method, u: req.url, body: body && JSON.parse(body), key: req.headers.apikey });
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url.startsWith('/rest/v1/products?select')) {
      res.end(JSON.stringify([{ id: 'p1', name: 'Visium HD', aliases: [], url: `${base}/page`, feed_url: null,
        page_hash: await sha256(oldText), page_text: oldText, last_checked_at: '2026-01-01T00:00:00Z', last_lit_check: null }]));
    } else if (req.url === '/page') {
      res.end(page('<p>New in 2026: Visium HD 3-prime assay now supports FFPE tissue and a 5 micron grid.</p>'));
    } else if (req.url === '/feed.xml') {
      res.end('<rss><item><title>Launch</title><link>https://v/1</link><guid>g1</guid><pubDate>Mon, 02 Mar 2026 00:00:00 GMT</pubDate></item></rss>');
    } else if (req.url.startsWith('/rest/v1/product_events')) {
      res.end(JSON.stringify(calls.at(-1).body));
    } else { res.statusCode = 204; res.end(); }
  }).listen(0);
  const port = srv.address().port;
  const out = await new Promise((resolve) => execFile(process.execPath, ['scripts/track-products.mjs'], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_KEY: 'sb_secret_test', HTTPS_PROXY: '', https_proxy: '' },
  }, (err, stdout, stderr) => resolve(stdout + stderr)));
  srv.close();
  const posts = calls.filter((c) => c.m === 'POST' && c.u.startsWith('/rest/v1/product_events'));
  const ev = posts.flatMap((c) => c.body);
  const change = ev.find((e) => e.kind === 'page_change');
  assert.ok(change, out);
  assert.ok(change.payload.added[0].startsWith('New in 2026: Visium HD 3-prime'));
  assert.ok(ev.some((e) => e.kind === 'news' && e.external_id === 'feed:g1'));
  assert.ok(posts.every((c) => c.u.includes('on_conflict=product_id,external_id')));
  const patch = calls.find((c) => c.m === 'PATCH' && c.body.page_hash);
  assert.ok(patch.body.feed_url.endsWith('/feed.xml'), 'feed auto-detected');
  assert.ok(calls.every((c) => !c.key || c.key === 'sb_secret_test'));
});
