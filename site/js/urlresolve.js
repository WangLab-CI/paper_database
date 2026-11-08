// Resolve an article web page link to a paper record.
// Order: (1) identifier in the URL itself, (2) publisher URL patterns (Nature IDs,
// Elsevier PII via Crossref), (3) optional Supabase Edge Function `resolve-url`
// that reads the page's citation_* meta tags (browsers cannot read publisher pages
// themselves), (4) Crossref search on words in the URL → candidates to choose from.

const DOI_TAIL = /\/(full|abstract|abs|pdf|epdf|summary|meta|figures|references|fulltext|full-text|html|suppl|supplementary|article-info|tab-figures-data)$/i;

export function cleanDoi(raw) {
  let d = decodeURIComponent(String(raw || '')).split(/[?#\s]/)[0];
  for (let i = 0; i < 4; i++) d = d.replace(DOI_TAIL, '').replace(/\.(pdf|full|abstract)$/i, '');
  d = d.replace(/[.,;)\]]+$/, '');
  // bioRxiv / medRxiv version suffix (old prefix 10.1101, newer prefixes such as 10.64898): DOI is date-based
  if (/^10\.1101\//.test(d) || /^10\.\d{4,9}\/\d{4}\.\d{2}\.\d{2}\.\d+v\d+$/i.test(d)) d = d.replace(/v\d+$/i, '');
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d.toLowerCase() : null;
}

// Pure: what does the URL itself tell us?
export function parseArticleUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = decodeURIComponent(u.pathname);
  const full = decodeURIComponent(u.pathname + u.search);
  let m;
  if (host === 'doi.org' || host === 'dx.doi.org') { const d = cleanDoi(path.slice(1)); if (d) return { type: 'doi', id: d }; }
  if ((m = full.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov|^\/pubmed)\/(\d{1,9})/)) || (host === 'pubmed.ncbi.nlm.nih.gov' && (m = path.match(/^\/(\d{1,9})/)))) return { type: 'pmid', id: m[1] };
  if ((m = full.match(/\b(PMC\d+)\b/i)) && /ncbi|europepmc|pmc/.test(host)) return { type: 'pmcid', id: m[1].toUpperCase() };
  if (host.endsWith('europepmc.org') && (m = path.match(/\/(?:article|abstract)\/(?:MED|med)\/(\d+)/))) return { type: 'pmid', id: m[1] };
  if (host.endsWith('arxiv.org') && (m = path.match(/\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/))) return { type: 'arxiv', id: m[1] };
  if (/(^|\.)(biorxiv|medrxiv)\.org$/.test(host) && (m = path.match(/(10\.\d{4,9}\/[\d.]+)/))) { const d = cleanDoi(m[1]); if (d) return { type: 'doi', id: d }; }
  if (host.endsWith('nature.com') && (m = path.match(/\/articles\/([a-z0-9.-]+?)(?:\.pdf)?$/i))) return { type: 'doi', id: `10.1038/${m[1].toLowerCase()}` };
  // Elsevier (ScienceDirect, Cell Press, Lancet): PII
  if ((m = path.match(/\/pii\/([S\dX()\-]{10,})/i)) || (m = path.match(/\/(?:fulltext|pdf|abstract|pdfExtended)\/(S[\dX()\-]{10,})/i))
      || (m = path.match(/\/PII(S[\dX()\-]{10,})/i))) return { type: 'pii', id: m[1].replace(/[()\-]/g, '').toUpperCase() };
  // Any DOI in the path or query string (Science, PNAS, Wiley, Springer, PLOS, ACS, T&F, Oxford "doi" links…)
  if ((m = full.match(/10\.\d{4,9}\/[^\s?#&]+/))) { const d = cleanDoi(m[0]); if (d) return { type: 'doi', id: d }; }
  // Nothing explicit: keep words from the slug for a title search
  const words = path.split('/').filter(Boolean)
    .filter((seg) => /[a-z]{3,}.*[-_][a-z]{3,}/i.test(seg))
    .sort((a, b) => b.length - a.length)[0];
  return { type: 'unknown', host, slug: words ? words.replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').trim() : '' };
}

// Pure: turn the page's <meta> tags into a partial record (Highwire / Dublin Core / OpenGraph).
export function extractCitationMeta(pairs, pageTitle = null) {
  const all = (name) => pairs.filter(([n]) => n.toLowerCase() === name).map(([, c]) => String(c || '').trim()).filter(Boolean);
  const first = (...names) => { for (const n of names) { const v = all(n)[0]; if (v) return v; } return null; };
  const doiRaw = first('citation_doi', 'prism.doi', 'bepress_citation_doi', 'dc.identifier', 'dc.identifier.doi', 'eprints.id_number');
  const doi = doiRaw ? cleanDoi(doiRaw.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, '')) : null;
  const authors = all('citation_author').length ? all('citation_author') : all('dc.creator');
  const date = first('citation_publication_date', 'citation_date', 'citation_online_date', 'dc.date', 'prism.publicationdate', 'article:published_time');
  const year = date ? +((date.match(/(19|20)\d{2}/) || [])[0] || 0) || null : null;
  return {
    doi,
    pmid: first('citation_pmid', 'ncbi_uid'),
    title: first('citation_title', 'dc.title', 'og:title', 'twitter:title') || pageTitle,
    authors: authors.map((a) => (a.includes(',') ? a : (() => { const p = a.split(/\s+/); return p.length > 1 ? `${p.pop()}, ${p.join(' ')}` : a; })())).join('; ') || null,
    journal: first('citation_journal_title', 'prism.publicationname', 'citation_conference_title', 'og:site_name'),
    year,
    abstract: first('citation_abstract', 'dc.description', 'description', 'og:description'),
    pdf_url: first('citation_pdf_url'),
  };
}

// --------------------------------------------------------------- async chain
export async function resolveUrl(url, { fetchers, sb = null } = {}) {
  const parsed = parseArticleUrl(url);
  if (!parsed) throw new Error('Not a valid web link');
  const tried = [];
  const byId = async (t, id) => {
    const rec = await fetchers[t](id);
    return { rec: { ...rec, url: rec.url || url }, via: t === 'doi' ? 'DOI in link' : `${t.toUpperCase()} in link` };
  };
  if (['doi', 'pmid', 'pmcid', 'arxiv'].includes(parsed.type)) {
    try { return await byId(parsed.type, parsed.id); } catch (e) { tried.push(`${parsed.type} ${parsed.id}: ${e.message}`); }
  }
  if (parsed.type === 'pii') {
    try {
      const j = await (await fetch(`https://api.crossref.org/works?filter=alternative-id:${encodeURIComponent(parsed.id)}&rows=1&select=DOI`)).json();
      const doi = j.message?.items?.[0]?.DOI;
      if (doi) return { rec: { ...(await fetchers.doi(doi.toLowerCase())), url }, via: 'Elsevier PII → Crossref' };
      tried.push('PII not found in Crossref');
    } catch (e) { tried.push(`Crossref PII: ${e.message}`); }
  }
  // Server-side page reader (optional Supabase Edge Function)
  if (sb) {
    try {
      const { data, error } = await sb.functions.invoke('resolve-url', { body: { url } });
      if (error) throw error;
      const meta = extractCitationMeta(data.meta || [], data.title);
      if (meta.doi) { try { return { rec: { ...meta, ...stripNull(await fetchers.doi(meta.doi)), url }, via: 'page citation tags → DOI' }; } catch { /* fall through */ } }
      if (meta.pmid) { try { return { rec: { ...meta, ...stripNull(await fetchers.pmid(meta.pmid)), url }, via: 'page citation tags → PMID' }; } catch { /* fall through */ } }
      if (meta.title && (meta.authors || meta.journal)) return { rec: { ...meta, url }, via: 'page citation tags' };
      tried.push('page has no citation tags');
    } catch (e) { tried.push(`page reader: ${e.message || e}`); }
  }
  // Last resort: Crossref bibliographic search on the slug → let the user pick
  const q = parsed.slug || (parsed.type === 'unknown' ? '' : parsed.id);
  if (q && q.split(' ').length >= 3) {
    try {
      const j = await (await fetch(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=5&select=DOI,title,author,issued,container-title`)).json();
      const candidates = (j.message?.items || []).map((w) => ({
        doi: w.DOI?.toLowerCase(), title: w.title?.[0] || '(untitled)', journal: w['container-title']?.[0] || '',
        year: w.issued?.['date-parts']?.[0]?.[0] || null, authors: (w.author || []).slice(0, 3).map((a) => a.family).filter(Boolean).join(', '),
      })).filter((c) => c.doi);
      if (candidates.length) return { candidates, via: `Crossref search for “${q}”`, tried };
    } catch (e) { tried.push(`Crossref search: ${e.message}`); }
  }
  const err = new Error(`Could not identify the paper from this link. ${tried.length ? `Tried: ${tried.join('; ')}.` : ''} Paste its DOI or PMID instead.`);
  err.tried = tried;
  throw err;
}

const stripNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)));
