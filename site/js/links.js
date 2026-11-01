// Automatic paper ↔ paper links.
//   cites    — A's reference list (OpenAlex) contains B                       [direct evidence]
//   coupled  — A and B cite ≥ k of the same works (bibliographic coupling,
//              Kessler 1963); score = shared / sqrt(|refs A|·|refs B|)       [bibliometric relatedness]
//   similar  — TF-IDF cosine of title (×2) + abstract ≥ threshold             [lexical only, not semantic]
import { normalizeDoi } from './util.js';

const OA = 'https://api.openalex.org/works';
const OA_SELECT = 'id,doi,ids,referenced_works,cited_by_count,topics,authorships,publication_year,related_works';
const shortOa = (u) => (u ? String(u).replace('https://openalex.org/', '') : null);

async function oaFilter(key, values) {
  const url = `${OA}?filter=${key}:${values.map(encodeURIComponent).join('|')}&per-page=${values.length}&select=${OA_SELECT}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OpenAlex ${r.status}`);
  return (await r.json()).results || [];
}

// Compact author list: consortium papers keep the first 20 and last 10 authors (PIs are usually last).
function compactAuthors(auths = []) {
  const keep = auths.length > 30 ? [...auths.slice(0, 20), ...auths.slice(-10)] : auths;
  return keep.map((a) => ({
    id: shortOa(a.author?.id), name: a.author?.display_name || a.raw_author_name || '',
    pos: a.author_position,
    inst: (a.institutions || []).slice(0, 3).map((i) => ({ id: shortOa(i.id), name: i.display_name, country: i.country_code || null })),
    countries: a.countries || [],
  }));
}

export function oaRecord(w) {
  return {
    openalex_id: shortOa(w.id),
    refs: (w.referenced_works || []).map(shortOa),
    cited_by_count: w.cited_by_count ?? null,
    oa_topics: (w.topics || []).slice(0, 3).map((t) => t.display_name),
    oa_meta: {
      year: w.publication_year ?? null,
      n_authors: (w.authorships || []).length,
      topics: (w.topics || []).slice(0, 3).map((t) => ({
        id: shortOa(t.id), name: t.display_name, score: t.score,
        subfield: t.subfield?.display_name || null, field: t.field?.display_name || null, domain: t.domain?.display_name || null,
      })),
      authors: compactAuthors(w.authorships),
      related: (w.related_works || []).map(shortOa),
    },
  };
}

export { shortOa };

// Look up papers (by DOI, else PMID) in OpenAlex. Returns Map paperId → record (missing = not found).
export async function fetchOpenAlex(papers, onProgress = () => {}) {
  const out = new Map();
  const byDoi = papers.filter((p) => p.doi);
  const byPmid = papers.filter((p) => !p.doi && p.pmid);
  let done = 0;
  for (let i = 0; i < byDoi.length; i += 40) {
    const chunk = byDoi.slice(i, i + 40);
    const res = await oaFilter('doi', chunk.map((p) => p.doi));
    const idx = new Map(res.map((w) => [normalizeDoi(w.doi), w]));
    for (const p of chunk) { const w = idx.get(p.doi); if (w) out.set(p.id, oaRecord(w)); }
    onProgress((done += chunk.length), papers.length);
  }
  for (let i = 0; i < byPmid.length; i += 40) {
    const chunk = byPmid.slice(i, i + 40);
    const res = await oaFilter('ids.pmid', chunk.map((p) => p.pmid));
    const idx = new Map(res.map((w) => [String(w.ids?.pmid || '').replace(/\D/g, ''), w]));
    for (const p of chunk) { const w = idx.get(String(p.pmid)); if (w) out.set(p.id, oaRecord(w)); }
    onProgress((done += chunk.length), papers.length);
  }
  return out;
}

// ---------------------------------------------------------------- link computation
const STOP = new Set(`a about above after again against all also am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having here how however i if in into is it its itself
just more most no nor not now of off on once only or other our out over own same should so some such than that the their them then there
these they this those through to too under until up very was we were what when where which while who whom why will with within without would
you your using used use based study studies show shows shown showed results result here we our paper approach method methods analysis data
new novel role roles via may can could found find finding findings among including include includes identified identify associated
significant significantly however furthermore moreover although whereas thus therefore two three one first second high higher low lower
increased decreased level levels different differences effect effects provide provides report reports reveal reveals revealed suggest
suggests suggesting demonstrate demonstrates demonstrated investigate investigated potential important key well known`.split(/\s+/));

export function tokenize(text) {
  return (String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .match(/[a-z][a-z0-9-]*[a-z0-9]|[a-z0-9]*\d[a-z0-9-]*[a-z]+[a-z0-9]*/g) || [])
    .map((t) => t.replace(/-+$/, ''))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

// Returns undirected similar pairs [{a, b, score}] (a < b), at most maxPerPaper neighbours per paper.
export function textSimilarity(papers, { minScore = 0.25, maxPerPaper = 5 } = {}) {
  const docs = papers.map((p) => {
    const tf = new Map();
    for (const t of tokenize(p.title)) tf.set(t, (tf.get(t) || 0) + 2);
    for (const t of tokenize(p.abstract)) tf.set(t, (tf.get(t) || 0) + 1);
    return { id: p.id, tf };
  }).filter((d) => d.tf.size >= 4);
  const N = docs.length;
  if (N < 2) return [];
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const maxDf = Math.max(2, Math.floor(N * 0.3));
  const postings = new Map();
  const vecs = docs.map((d, i) => {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of d.tf) {
      const n = df.get(t);
      if (n < 2 || n > maxDf) continue;            // unique terms cannot match; ubiquitous ones carry no signal
      const w = (1 + Math.log(c)) * Math.log(N / n);
      v.set(t, w); norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) { const x = w / norm; v.set(t, x); (postings.get(t) || postings.set(t, []).get(t)).push([i, x]); }
    return v;
  });
  const best = new Map();
  for (let i = 0; i < N; i++) {
    const acc = new Map();
    for (const [t, x] of vecs[i]) for (const [j, y] of postings.get(t)) if (j !== i) acc.set(j, (acc.get(j) || 0) + x * y);
    const top = [...acc].filter(([, s]) => s >= minScore).sort((a, b) => b[1] - a[1]).slice(0, maxPerPaper);
    for (const [j, s] of top) {
      const [a, b] = docs[i].id < docs[j].id ? [docs[i].id, docs[j].id] : [docs[j].id, docs[i].id];
      const k = a + '|' + b;
      if (!best.has(k) || best.get(k).score < s) best.set(k, { a, b, score: +s.toFixed(3) });
    }
  }
  return [...best.values()];
}

export function citationLinks(papers) {
  const byOa = new Map(papers.filter((p) => p.openalex_id).map((p) => [p.openalex_id, p.id]));
  const out = [];
  for (const p of papers) for (const r of p.refs || []) {
    const q = byOa.get(r);
    if (q && q !== p.id) out.push({ source_id: p.id, target_id: q, kind: 'cites', score: 1 });
  }
  return out;
}

export function couplingLinks(papers, { minShared = 3, minScore = 0.05 } = {}) {
  const withRefs = papers.filter((p) => p.refs?.length);
  const citers = new Map();
  for (const p of withRefs) for (const r of new Set(p.refs)) (citers.get(r) || citers.set(r, []).get(r)).push(p);
  const shared = new Map();
  for (const list of citers.values()) {
    if (list.length < 2 || list.length > 200) continue;   // skip refs cited by nearly everything (e.g. reference genomes)
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [a, b] = list[i].id < list[j].id ? [list[i], list[j]] : [list[j], list[i]];
      const k = a.id + '|' + b.id;
      const e = shared.get(k) || shared.set(k, { a, b, n: 0 }).get(k);
      e.n++;
    }
  }
  const out = [];
  for (const { a, b, n } of shared.values()) {
    if (n < minShared) continue;
    const score = n / Math.sqrt(new Set(a.refs).size * new Set(b.refs).size);
    if (score >= minScore) out.push({ source_id: a.id, target_id: b.id, kind: 'coupled', score: +score.toFixed(3), shared: n });
  }
  return out;
}

export function computeLinks(papers, opts = {}) {
  return [
    ...citationLinks(papers),
    ...couplingLinks(papers, opts),
    ...textSimilarity(papers, opts.text).map(({ a, b, score }) => ({ source_id: a, target_id: b, kind: 'similar', score })),
  ];
}
