// Suggest library papers for a project. Pure function (unit-tested).
// Score = text + tags + network, each component reported so users see *why*:
//   text    — TF-IDF cosine between project text and paper title(×2)+abstract (IDF over the library)
//   tags    — project tags found in the paper's tags / OpenAlex topics / keywords / MeSH (0.12 each, max 3)
//   network — citation or shared-reference links to papers already linked to the project (0.08 each, max 4)
import { tokenize } from './links.js';
import { PROJECT_FIELDS } from './util.js';

const W_TAG = 0.12, W_NET = 0.08;

function tf(tokens, weight = 1, into = new Map()) {
  for (const t of tokens) into.set(t, (into.get(t) || 0) + weight);
  return into;
}

export function projectText(p) {
  return [p.title, p.title, ...PROJECT_FIELDS.map(([k]) => p[k] || '')].join('\n');
}

export function suggestPapers(project, papers, { linkedIds = new Set(), paperLinks = [], dismissed = new Set(), top = 15, minScore = 0.05 } = {}) {
  const candidates = papers.filter((p) => !linkedIds.has(p.id) && !dismissed.has(p.id));
  if (!candidates.length) return [];

  // ---- text: IDF over the whole library
  const docs = new Map(papers.map((p) => [p.id, tf(tokenize(p.abstract), 1, tf(tokenize(p.title), 2))]));
  const N = papers.length + 1;
  const df = new Map();
  for (const d of docs.values()) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
  const q = tf(tokenize(projectText(project)));
  for (const tag of project.tags || []) tf(tokenize(tag), 2, q);          // tags count double in the query
  const weigh = (m) => {
    const v = new Map(); let n = 0;
    for (const [t, c] of m) {
      const d = df.get(t) || 0;
      if (d > N * 0.4) continue;                                             // near-ubiquitous terms carry no signal
      const w = (1 + Math.log(c)) * Math.log((N + 1) / (d + 1));
      v.set(t, w); n += w * w;
    }
    n = Math.sqrt(n) || 1;
    for (const [t, w] of v) v.set(t, w / n);
    return v;
  };
  const qv = weigh(q);

  // ---- network: neighbours of already-linked papers
  const net = new Map();
  for (const l of paperLinks) {
    if (l.kind === 'similar') continue;                                      // lexical links would double-count the text signal
    const [a, b] = [l.source_id, l.target_id];
    const other = linkedIds.has(a) && !linkedIds.has(b) ? b : linkedIds.has(b) && !linkedIds.has(a) ? a : null;
    if (!other) continue;
    const e = net.get(other) || net.set(other, { cites: 0, citedBy: 0, coupled: 0 }).get(other);
    if (l.kind === 'coupled') e.coupled++;
    else if (l.kind === 'cites' || l.kind === 'manual') { if (other === a) e.cites++; else e.citedBy++; }
  }

  const ptags = (project.tags || []).map((t) => t.toLowerCase());
  const out = [];
  for (const p of candidates) {
    const pv = weigh(docs.get(p.id));
    let text = 0;
    const shared = [];
    for (const [t, w] of qv) { const x = pv.get(t); if (x) { text += w * x; shared.push([t, w * x]); } }
    const labels = [...(p.tags || []), ...(p.topics || []).map((t) => t.name), ...(p.keywords || []).map((k) => k.name), ...(p.mesh || []).map((m) => m.name)]
      .map((x) => String(x).toLowerCase());
    const tagHits = ptags.filter((t) => labels.some((l) => l === t || l.includes(t) || t.includes(l) && l.length > 3));
    const n = net.get(p.id);
    const netHits = n ? n.cites + n.citedBy + n.coupled : 0;
    const score = text + W_TAG * Math.min(3, tagHits.length) + W_NET * Math.min(4, netHits);
    if (score < minScore) continue;
    const reasons = [];
    if (shared.length) reasons.push(`text: ${shared.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t).join(', ')}`);
    if (tagHits.length) reasons.push(`tags/topics: ${tagHits.join(', ')}`);
    if (n) {
      const parts = [];
      if (n.cites) parts.push(`cites ${n.cites} linked paper${n.cites > 1 ? 's' : ''}`);
      if (n.citedBy) parts.push(`cited by ${n.citedBy} linked paper${n.citedBy > 1 ? 's' : ''}`);
      if (n.coupled) parts.push(`shares references with ${n.coupled} linked paper${n.coupled > 1 ? 's' : ''}`);
      reasons.push(parts.join('; '));
    }
    out.push({ paper: p, score: +score.toFixed(3), parts: { text: +text.toFixed(3), tags: tagHits.length, network: netHits }, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, top);
}
