// Metadata lookup from public, CORS-enabled APIs:
//   DOI   → Crossref (+ Europe PMC for PMID/abstract)
//   PMID  → Europe PMC
//   arXiv → DataCite (arXiv DOIs 10.48550/arXiv.<id>)
import { normalizeDoi } from './util.js';
import { resolveUrl } from './urlresolve.js';

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

export function parseIdentifier(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const arx = s.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*|10\.48550\/arxiv\.)?(\d{4}\.\d{4,5})(v\d+)?/i);
  if (/arxiv/i.test(s) && arx) return { type: 'arxiv', id: arx[1] };
  const doi = normalizeDoi(s);
  if (doi) return { type: 'doi', id: doi };
  const pmc = s.match(/PMC\d+/i);
  if (pmc) return { type: 'pmcid', id: pmc[0].toUpperCase() };
  const pmid = s.match(/^(?:pmid:?\s*)?(\d{1,9})$/i) || s.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
  if (pmid) return { type: 'pmid', id: pmid[1] };
  if (arx && /^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return { type: 'arxiv', id: arx[1] };
  return { type: 'query', id: s };
}

const stripTags = (s) => (s ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null);

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}

function fromEpmc(r) {
  return {
    title: (r.title || '').replace(/\.$/, ''),
    authors: (r.authorList?.author || [])
      .map((a) => (a.lastName ? `${a.lastName}, ${a.firstName || a.initials || ''}`.trim() : a.collectiveName))
      .filter(Boolean)
      .join('; ') || (r.authorString || '').replace(/\.$/, '').split(', ').join('; '),
    journal: r.journalInfo?.journal?.title || r.journalTitle || r.bookOrReportDetails?.publisher || null,
    year: r.pubYear ? parseInt(r.pubYear, 10) : null,
    abstract: stripTags(r.abstractText),
    doi: normalizeDoi(r.doi),
    pmid: r.pmid || null,
    url: r.doi ? `https://doi.org/${r.doi}` : r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : null,
    pdf_url: r.pmcid ? `https://europepmc.org/articles/${r.pmcid}/pdf` : null,
    tags: (r.keywordList?.keyword || []).slice(0, 8).map((k) => k.toLowerCase()),
  };
}

async function epmcQuery(query, pageSize = 1) {
  const url = `${EPMC}?query=${encodeURIComponent(query)}&resultType=core&format=json&pageSize=${pageSize}`;
  const j = await getJSON(url);
  return j.resultList?.result || [];
}

export async function fetchByDoi(doi) {
  const j = await getJSON(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const m = j.message;
  const year = (m.issued?.['date-parts']?.[0]?.[0]) || (m.published?.['date-parts']?.[0]?.[0]) || null;
  const rec = {
    title: (m.title?.[0] || '').replace(/\s+/g, ' ').trim(),
    authors: (m.author || []).map((a) => (a.family ? `${a.family}, ${a.given || ''}`.trim() : a.name)).filter(Boolean).join('; '),
    journal: m['container-title']?.[0] || m.institution?.[0]?.name || m.publisher || null,
    year,
    abstract: stripTags(m.abstract)?.replace(/^Abstract\s*/i, '') || null,
    doi: normalizeDoi(m.DOI),
    url: m.URL || `https://doi.org/${doi}`,
    entry_type: m.type === 'posted-content' ? 'misc' : m.type === 'book-chapter' ? 'incollection' : 'article',
    pmid: null, pdf_url: null, tags: [],
  };
  try {
    const hits = await epmcQuery(`DOI:"${doi}"`, 3);
    const hit = hits.find((h) => normalizeDoi(h.doi) === rec.doi);   // only enrich from the exact same paper
    if (hit) {
      const e = fromEpmc(hit);
      rec.pmid = e.pmid;
      rec.abstract = rec.abstract || e.abstract;
      rec.pdf_url = e.pdf_url;
      rec.tags = e.tags;
    }
  } catch { /* enrichment is optional */ }
  return rec;
}

export async function fetchByPmid(pmid) {
  const [hit] = await epmcQuery(`EXT_ID:${pmid} AND SRC:MED`);
  if (!hit) throw new Error(`PMID ${pmid} not found`);
  return fromEpmc(hit);
}

export async function fetchByPmcid(pmcid) {
  const [hit] = await epmcQuery(`PMCID:${pmcid}`);
  if (!hit) throw new Error(`${pmcid} not found`);
  return fromEpmc(hit);
}

export async function fetchByArxiv(id) {
  const j = await getJSON(`https://api.datacite.org/dois/10.48550/arxiv.${id}`);
  const a = j.data.attributes;
  return {
    title: a.titles?.[0]?.title || '',
    authors: (a.creators || []).map((c) => c.name).join('; '),
    journal: 'arXiv',
    year: a.publicationYear || null,
    abstract: (a.descriptions || []).find((d) => d.descriptionType === 'Abstract')?.description?.trim() || null,
    doi: `10.48550/arxiv.${id}`,
    arxiv_id: id,
    url: `https://arxiv.org/abs/${id}`,
    pdf_url: `https://arxiv.org/pdf/${id}`,
    entry_type: 'misc',
    tags: (a.subjects || []).map((s) => s.subject.toLowerCase()).slice(0, 5),
  };
}

export async function lookup(input) {
  const id = parseIdentifier(input);
  if (!id) throw new Error('Enter a DOI, PMID, PMCID or arXiv ID');
  switch (id.type) {
    case 'doi': return fetchByDoi(id.id);
    case 'pmid': return fetchByPmid(id.id);
    case 'pmcid': return fetchByPmcid(id.id);
    case 'arxiv': return fetchByArxiv(id.id);
    default: throw new Error('Not an identifier — use “Search literature” instead');
  }
}

// Any input: DOI / PMID / PMCID / arXiv ID, or an article web page link.
// Returns { rec, via } or { candidates, via } (when only a search could match the link).
export async function lookupAny(input, { sb = null } = {}) {
  const s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) {
    return resolveUrl(s, { sb, fetchers: { doi: fetchByDoi, pmid: fetchByPmid, pmcid: fetchByPmcid, arxiv: fetchByArxiv } });
  }
  return { rec: await lookup(s), via: 'identifier' };
}

// Free-text literature search (Europe PMC covers PubMed, PMC, bioRxiv/medRxiv preprints)
export async function searchLiterature(query, n = 15) {
  const res = await epmcQuery(query, n);
  return res.map(fromEpmc);
}
