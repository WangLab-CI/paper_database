// Shared, dependency-free helpers for technology tracking. Used by the portal
// (browser) and by scripts/track-products.mjs (GitHub Actions, Node 22).

export const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

// Europe PMC query for a product: custom query, else "name" OR "alias" … (exact phrases).
// Europe PMC searches full text of open-access papers, so Methods-only mentions are found.
export function buildQuery(p) {
  if (p.search_query && p.search_query.trim()) return p.search_query.trim();
  const terms = [...new Set([p.name, ...(p.aliases || [])].map((t) => String(t || '').replace(/"/g, '').trim()).filter((t) => t.length >= 2))];
  return terms.length ? `(${terms.map((t) => `"${t}"`).join(' OR ')})` : '';
}

export function epmcUrl(query, { from = null, sort = 'FIRST_PDATE desc', pageSize = 25, year = null } = {}) {
  let q = query;
  if (from) q += ` AND (FIRST_PDATE:[${from} TO 3000-12-31])`;
  if (year) q += ` AND (PUB_YEAR:${year})`;
  return `${EPMC}?query=${encodeURIComponent(q)}&format=json&resultType=lite&pageSize=${pageSize}&sort=${encodeURIComponent(sort)}`;
}

export function epmcToEvent(r) {
  const doi = r.doi ? String(r.doi).toLowerCase() : null;
  return {
    kind: 'paper',
    title: String(r.title || '(untitled)').replace(/<[^>]+>/g, '').replace(/\.$/, ''),
    url: doi ? `https://doi.org/${doi}` : r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : `https://europepmc.org/article/${r.source}/${r.id}`,
    event_date: r.firstPublicationDate || (r.pubYear ? `${r.pubYear}-01-01` : null),
    external_id: `epmc:${r.source}:${r.id}`,
    payload: {
      authors: r.authorString || '', journal: r.journalTitle || r.bookOrReportDetails?.publisher || null,
      year: r.pubYear ? +r.pubYear : null, cited_by: r.citedByCount ?? 0, doi, pmid: r.pmid || null, preprint: r.source === 'PPR',
    },
  };
}

// ---------------------------------------------------------------- web pages
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', reg: '®', trade: '™', copy: '©' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')                    // site chrome changes are noise
    .replace(/<\/?(p|div|li|h[1-6]|tr|section|article|br|ul|ol|table|dd|dt)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1).join('\n');
}

export function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
}

export function findFeed(html, base) {
  const re = /<link\b[^>]*>/gi;
  for (const tag of String(html || '').match(re) || []) {
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) { try { return new URL(decodeEntities(href), base).href; } catch { /* ignore */ } }
  }
  return null;
}

// Lines that look like boilerplate even when they change (dates, cookie banners, counters).
const NOISE = /cookie|copyright|©|all rights reserved|privacy|subscribe|sign in|log in|^\W*\d[\d\s,./:-]*\W*$/i;

// Sentence-level diff: what text appeared on the page since the last check?
export function textDiff(oldText, newText, { minLen = 40, max = 8 } = {}) {
  const split = (t) => String(t || '').split(/\n|(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
  const oldSet = new Set(split(oldText));
  const newSet = new Set(split(newText));
  const added = [...newSet].filter((x) => !oldSet.has(x) && x.length >= minLen && !NOISE.test(x));
  const removed = [...oldSet].filter((x) => !newSet.has(x) && x.length >= minLen && !NOISE.test(x));
  return { added: added.slice(0, max).map((x) => x.slice(0, 240)), addedCount: added.length, removedCount: removed.length };
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- RSS / Atom
export function parseFeed(xml) {
  const s = String(xml || '');
  const blocks = s.match(/<item\b[\s\S]*?<\/item>/gi) || s.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const get = (b, tag) => {
    const m = b.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
  };
  return blocks.map((b) => {
    const link = get(b, 'link') || b.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || null;
    const date = get(b, 'pubDate') || get(b, 'updated') || get(b, 'published') || get(b, 'dc:date');
    const d = date ? new Date(date) : null;
    return {
      id: get(b, 'guid') || get(b, 'id') || link || get(b, 'title'),
      title: get(b, 'title') || '(untitled)',
      link,
      date: d && !isNaN(d) ? d.toISOString().slice(0, 10) : null,
      summary: (get(b, 'description') || get(b, 'summary') || '').slice(0, 400),
    };
  }).filter((x) => x.id);
}
