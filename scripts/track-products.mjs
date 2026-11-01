#!/usr/bin/env node
// Daily technology tracker (run by .github/workflows/track-products.yml).
// For every product: (1) new literature from Europe PMC, (2) product-page changes,
// (3) vendor news feed items. Results are written to Supabase as product_events.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (secret key — never ship it to the website).
import {
  buildQuery, epmcUrl, epmcToEvent, htmlToText, pageTitle, findFeed, textDiff, sha256, parseFeed,
} from '../site/js/products-lib.js';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set'); process.exit(1); }
const DRY = process.argv.includes('--dry-run');

const headers = { apikey: KEY, 'Content-Type': 'application/json' };
if (KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${KEY}`;   // legacy JWT service_role key

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function addEvents(productId, events) {
  if (!events.length) return 0;
  const rows = events.map((e) => ({ ...e, product_id: productId, created_by: null }));
  if (DRY) { console.log('  would add', rows.length, 'events:', rows.slice(0, 3).map((r) => r.title)); return rows.length; }
  const res = await rest('product_events?on_conflict=product_id,external_id', { method: 'POST', body: rows, prefer: 'resolution=ignore-duplicates,return=representation' });
  return res?.length ?? 0;
}

const UA = 'Mozilla/5.0 (compatible; LabPortalTracker/1.0; +https://github.com/WangLab-CI/paper_database)';
async function get(url, accept = 'text/html,application/xhtml+xml') {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const isoDay = (d) => d.toISOString().slice(0, 10);

async function trackLiterature(p) {
  const q = buildQuery(p);
  if (!q) return 0;
  // first run: last 90 days; afterwards: since last check minus 7 days (indexing lag)
  const since = p.last_lit_check ? new Date(new Date(p.last_lit_check) - 7 * 864e5) : new Date(Date.now() - 90 * 864e5);
  const j = await (await fetch(epmcUrl(q, { from: isoDay(since), pageSize: 100 }))).json();
  const events = (j.resultList?.result || []).map(epmcToEvent);
  const n = await addEvents(p.id, events);
  if (!DRY) await rest(`products?id=eq.${p.id}`, { method: 'PATCH', body: { last_lit_check: new Date().toISOString() } });
  return n;
}

async function trackPage(p) {
  const patch = { last_checked_at: new Date().toISOString(), check_error: null };
  let added = 0;
  let html = null;
  if (p.url) {
    html = await get(p.url);
    const text = htmlToText(html).slice(0, 60000);
    const hash = await sha256(text);
    patch.page_title = pageTitle(html) || p.page_title;
    if (p.page_hash && p.page_hash !== hash) {
      const d = textDiff(p.page_text, text);
      if (d.addedCount) {
        added += await addEvents(p.id, [{
          kind: 'page_change', title: `Product page updated: ${d.addedCount} new passage${d.addedCount > 1 ? 's' : ''}`,
          url: p.url, event_date: isoDay(new Date()), external_id: `page:${hash.slice(0, 16)}`,
          payload: { added: d.added, added_count: d.addedCount, removed_count: d.removedCount },
        }]);
      }
    }
    patch.page_hash = hash; patch.page_text = text;
    if (!p.feed_url) { const f = findFeed(html, p.url); if (f) patch.feed_url = f; }
  }
  const feed = patch.feed_url || p.feed_url;
  if (feed) {
    const items = parseFeed(await get(feed, 'application/rss+xml,application/atom+xml,application/xml,text/xml'));
    // first time this feed is read: only the 5 most recent items
    const fresh = p.last_checked_at && p.feed_url ? items.slice(0, 30) : items.slice(0, 5);
    added += await addEvents(p.id, fresh.map((it) => ({
      kind: 'news', title: it.title, url: it.link, event_date: it.date, external_id: `feed:${it.id}`.slice(0, 500),
      payload: { summary: it.summary, feed },
    })));
  }
  if (!DRY) await rest(`products?id=eq.${p.id}`, { method: 'PATCH', body: patch });
  return added;
}

const products = await rest('products?select=id,name,aliases,search_query,url,feed_url,page_hash,page_text,page_title,last_checked_at,last_lit_check');
console.log(`Tracking ${products.length} products${DRY ? ' (dry run)' : ''}`);
let failures = 0;
for (const p of products) {
  const out = [];
  try { out.push(`${await trackLiterature(p)} papers`); } catch (e) { failures++; out.push(`literature failed: ${e.message}`); }
  try { out.push(`${await trackPage(p)} page/news updates`); } catch (e) {
    failures++; out.push(`page failed: ${e.message}`);
    if (!DRY) await rest(`products?id=eq.${p.id}`, { method: 'PATCH', body: { check_error: String(e.message).slice(0, 300), last_checked_at: new Date().toISOString() } }).catch(() => {});
  }
  console.log(`- ${p.name}: ${out.join(', ')}`);
}
// Individual vendor sites may block bots; that's reported per product, not as a job failure.
console.log(failures ? `${failures} checks failed (see check_error on each product)` : 'All checks succeeded');
