// Pure analysis functions for the Insights page. Input: papers with oa_meta
// (see links.js oaRecord). No DOM, no network: unit-tested in tests/insights.test.mjs.

const yearOf = (p) => p.oa_meta?.year ?? p.year ?? null;

// Which label(s) a paper contributes at the chosen level.
//   level: 'topic' | 'subfield' | 'field' | 'tag'. Primary topic only for OpenAlex levels
//   (fractional assignment across 3 topics would blur trends; primary topic is OpenAlex's best match).
export function labelsOf(p, level) {
  const m = p.oa_meta || {};
  if (level === 'tag') return [...new Set(p.tags || [])];
  if (level === 'topic_all') return [...new Set((m.topics || []).map((t) => t.name))];
  if (level === 'keyword') return [...new Set((m.keywords || []).map((k) => k.name))];
  if (level === 'mesh') return [...new Set((m.mesh || []).filter((x) => x.major).map((x) => x.name))];
  if (level === 'mesh_all') return [...new Set((m.mesh || []).map((x) => x.name))];
  const t = m.topics?.[0];
  if (!t) return [];
  return [level === 'topic' ? t.name : t[level]].filter(Boolean);
}

// "parp, brca" → keep labels containing any of the terms (case-insensitive)
export function labelFilter(text) {
  const terms = String(text || '').toLowerCase().split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  return terms.length ? (l) => terms.some((t) => l.toLowerCase().includes(t)) : () => true;
}
const labelsFiltered = (p, level, keep) => labelsOf(p, level).filter(keep);

export function topicIdOf(papers, name) {
  for (const p of papers) for (const t of p.oa_meta?.topics || []) if (t.name === name) return t.id;
  return null;
}

// Topic × year counts. Returns { years, rows:[{label, total, counts:[...]}], yearTotals }
export function topicYearMatrix(papers, { level = 'subfield', top = 15, from = null, to = null, filter = '' } = {}) {
  const keep = labelFilter(filter);
  const ps = papers.filter((p) => yearOf(p) && (!from || yearOf(p) >= from) && (!to || yearOf(p) <= to));
  if (!ps.length) return { years: [], rows: [], yearTotals: [] };
  const ys = ps.map(yearOf);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  const yearTotals = years.map((y) => ps.filter((p) => yearOf(p) === y).length);
  const byLabel = new Map();
  for (const p of ps) for (const l of labelsFiltered(p, level, keep)) {
    const r = byLabel.get(l) || byLabel.set(l, { label: l, total: 0, counts: years.map(() => 0) }).get(l);
    r.total++; r.counts[yearOf(p) - y0]++;
  }
  const rows = [...byLabel.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)).slice(0, top);
  // order rows by "centre of mass" year so the heatmap reads as a timeline (older topics on top)
  for (const r of rows) r.meanYear = r.counts.reduce((s, c, i) => s + c * years[i], 0) / r.total;
  rows.sort((a, b) => a.meanYear - b.meanYear);
  return { years, rows, yearTotals };
}

// Group × topic counts with whole counting: a paper counts once for every distinct
// country (or institution) among its authors.
export function groupTopicMatrix(papers, { by = 'country', level = 'field', topRows = 15, topCols = 10, filter = '' } = {}) {
  const keep = labelFilter(filter);
  const cell = new Map(), rowTot = new Map(), colTot = new Map(), names = new Map();
  let nPapers = 0;
  for (const p of papers) {
    const labels = labelsFiltered(p, level, keep);
    if (!labels.length || !p.oa_meta?.authors?.length) continue;
    const groups = new Set();
    for (const a of p.oa_meta.authors) for (const i of a.inst || []) {
      const key = by === 'country' ? i.country : i.id;
      if (!key) continue;
      groups.add(key);
      if (by !== 'country') names.set(key, i.name);
    }
    if (!groups.size) continue;
    nPapers++;
    for (const g of groups) {
      rowTot.set(g, (rowTot.get(g) || 0) + 1);
      for (const l of labels) cell.set(g + '\u0000' + l, (cell.get(g + '\u0000' + l) || 0) + 1);
    }
    for (const l of labels) colTot.set(l, (colTot.get(l) || 0) + 1);
  }
  const rows = [...rowTot].sort((a, b) => b[1] - a[1]).slice(0, topRows).map(([k, n]) => ({ key: k, label: names.get(k) || k, total: n }));
  const cols = [...colTot].sort((a, b) => b[1] - a[1]).slice(0, topCols).map(([l, n]) => ({ label: l, total: n }));
  const values = rows.map((r) => cols.map((c) => cell.get(r.key + '\u0000' + c.label) || 0));
  return { rows, cols, values, nPapers };
}

// ------------------------------------------------------------ co-authorship
// Authors with ≥ minPapers library papers; edge weight = co-authored library papers.
// Papers with more than maxAuthors authors are skipped for edges (consortium papers
// would otherwise fuse everyone into one group) but still count toward paper totals.
export function coauthorGraph(papers, { minPapers = 2, maxAuthors = 30 } = {}) {
  const authors = new Map();
  for (const p of papers) for (const a of p.oa_meta?.authors || []) {
    if (!a.id) continue;
    const r = authors.get(a.id) || authors.set(a.id, { id: a.id, name: a.name, papers: new Set(), inst: new Map(), countries: new Map(), topics: new Map(), years: [] }).get(a.id);
    r.papers.add(p.id);
    for (const i of a.inst || []) { r.inst.set(i.name, (r.inst.get(i.name) || 0) + 1); if (i.country) r.countries.set(i.country, (r.countries.get(i.country) || 0) + 1); }
    const t = p.oa_meta?.topics?.[0]?.subfield; if (t) r.topics.set(t, (r.topics.get(t) || 0) + 1);
    if (yearOf(p)) r.years.push(yearOf(p));
  }
  const keep = new Map([...authors].filter(([, a]) => a.papers.size >= minPapers));
  const w = new Map();
  for (const p of papers) {
    const as = p.oa_meta?.authors || [];
    if ((p.oa_meta?.n_authors || as.length) > maxAuthors) continue;
    const ids = [...new Set(as.map((a) => a.id).filter((id) => keep.has(id)))].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j]; w.set(k, (w.get(k) || 0) + 1);
    }
  }
  const edges = [...w].map(([k, weight]) => { const [a, b] = k.split('|'); return { a, b, weight }; });
  return { nodes: [...keep.values()], edges };
}

// Louvain modularity optimisation (Blondel et al. 2008). Deterministic node order.
export function louvain(nodeIds, edges) {
  let comm = new Map(nodeIds.map((n) => [n, n]));          // original node → community
  let nodes = [...nodeIds];
  let links = edges.map((e) => [e.a, e.b, e.weight]);
  for (let level = 0; level < 10; level++) {
    const adj = new Map(nodes.map((n) => [n, new Map()]));
    let m2 = 0;
    for (const [a, b, wt] of links) {
      adj.get(a).set(b, (adj.get(a).get(b) || 0) + wt);
      adj.get(b).set(a, (adj.get(b).get(a) || 0) + wt);
      m2 += 2 * wt;
    }
    if (!m2) break;
    const k = new Map(nodes.map((n) => [n, [...adj.get(n).values()].reduce((s, x) => s + x, 0)]));
    const c = new Map(nodes.map((n) => [n, n]));
    const tot = new Map(nodes.map((n) => [n, k.get(n)]));
    let moved = true, any = false, guard = 0;
    while (moved && guard++ < 50) {
      moved = false;
      for (const n of nodes) {
        const cn = c.get(n), kn = k.get(n);
        const wTo = new Map();
        for (const [nb, wt] of adj.get(n)) if (nb !== n) wTo.set(c.get(nb), (wTo.get(c.get(nb)) || 0) + wt);
        tot.set(cn, tot.get(cn) - kn);
        let best = cn, bestGain = (wTo.get(cn) || 0) - (tot.get(cn) * kn) / m2;
        for (const [cc, wt] of wTo) {
          const gain = wt - (tot.get(cc) * kn) / m2;
          if (gain > bestGain + 1e-12) { best = cc; bestGain = gain; }
        }
        tot.set(best, tot.get(best) + kn);
        if (best !== cn) { c.set(n, best); moved = true; any = true; }
      }
    }
    for (const [orig, cc] of comm) comm.set(orig, c.get(cc));
    if (!any) break;
    // aggregate
    const agg = new Map();
    for (const [a, b, wt] of links) {
      const ca = c.get(a), cb = c.get(b);
      const key = ca < cb ? ca + '|' + cb : cb + '|' + ca;
      agg.set(key, (agg.get(key) || 0) + wt);
    }
    nodes = [...new Set(c.values())];
    // internal edges become a self-loop carrying their summed weight
    links = [...agg].map(([key, wt]) => { const [a, b] = key.split('|'); return [a, b, wt]; });
  }
  return comm;
}

export function modularity(edges, comm) {
  let m2 = 0;
  const k = new Map(), inW = new Map(), totW = new Map();
  for (const { a, b, weight } of edges) { m2 += 2 * weight; k.set(a, (k.get(a) || 0) + weight); k.set(b, (k.get(b) || 0) + weight); }
  if (!m2) return 0;
  for (const { a, b, weight } of edges) if (comm.get(a) === comm.get(b)) inW.set(comm.get(a), (inW.get(comm.get(a)) || 0) + 2 * weight);
  for (const [n, kn] of k) totW.set(comm.get(n), (totW.get(comm.get(n)) || 0) + kn);
  let q = 0;
  for (const [c, t] of totW) q += (inW.get(c) || 0) / m2 - (t / m2) ** 2;
  return q;
}

const topN = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

// Groups: communities with ≥ minSize authors, ranked by distinct library papers.
export function collaborationGroups(papers, opts = {}) {
  const g = coauthorGraph(papers, opts);
  const connected = new Set(g.edges.flatMap((e) => [e.a, e.b]));
  const comm = louvain([...connected].sort(), g.edges);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const groups = new Map();
  for (const [id, c] of comm) (groups.get(c) || groups.set(c, []).get(c)).push(byId.get(id));
  const out = [...groups.values()].filter((ms) => ms.length >= (opts.minSize || 2)).map((ms) => {
    const paperIds = new Set(ms.flatMap((m) => [...m.papers]));
    const agg = (field) => { const t = new Map(); for (const m of ms) for (const [k, v] of m[field]) t.set(k, (t.get(k) || 0) + v); return t; };
    const years = ms.flatMap((m) => m.years);
    return {
      members: ms.sort((a, b) => b.papers.size - a.papers.size || a.name.localeCompare(b.name)),
      nPapers: paperIds.size, paperIds: [...paperIds],
      institutions: topN(agg('inst'), 3), countries: topN(agg('countries'), 3), topics: topN(agg('topics'), 3),
      years: years.length ? [Math.min(...years), Math.max(...years)] : null,
    };
  }).sort((a, b) => b.nPapers - a.nPapers || b.members.length - a.members.length);
  out.forEach((grp, i) => { grp.index = i; for (const m of grp.members) m.group = i; });
  return { groups: out, edges: g.edges, modularity: modularity(g.edges, comm), isolated: g.nodes.length - connected.size };
}

// ------------------------------------------------------------ works not in library
// Works cited by ≥ minCount library papers but absent from the library ("foundational").
export function frequentlyCited(papers, { minCount = 2, top = 40 } = {}) {
  const inLib = new Set(papers.map((p) => p.openalex_id).filter(Boolean));
  const n = new Map();
  for (const p of papers) for (const r of new Set(p.refs || [])) if (!inLib.has(r)) n.set(r, (n.get(r) || 0) + 1);
  return [...n].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top)
    .map(([id, count]) => ({ id, count }));
}

// Works OpenAlex lists as "related" to ≥ minCount library papers but absent from the library.
export function frequentlyRelated(papers, { minCount = 2, top = 40 } = {}) {
  const inLib = new Set(papers.map((p) => p.openalex_id).filter(Boolean));
  const n = new Map();
  for (const p of papers) for (const r of new Set(p.oa_meta?.related || [])) if (!inLib.has(r)) n.set(r, (n.get(r) || 0) + 1);
  return [...n].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top)
    .map(([id, count]) => ({ id, count }));
}

// Recent works citing library papers: count how many library papers each one cites.
export function rankCiting(works, papers, { minCount = 2 } = {}) {
  const inLib = new Set(papers.map((p) => p.openalex_id).filter(Boolean));
  return works.filter((w) => !inLib.has(w.id))
    .map((w) => ({ ...w, count: (w.refs || []).filter((r) => inLib.has(r)).length }))
    .filter((w) => w.count >= minCount)
    .sort((a, b) => b.count - a.count || (b.year || 0) - (a.year || 0));
}
