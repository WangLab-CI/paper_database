// Bulk-import planning: match file records to existing library papers instead of
// skipping them, so tags / project links / missing fields can still be applied.
// Pure functions (unit-tested in tests/importplan.test.mjs).

export const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ID_KEYS = ['doi', 'pmid', 'arxiv_id'];

// Fields copied from the file into an existing paper only when the existing value is empty.
export const FILLABLE = ['abstract', 'doi', 'pmid', 'arxiv_id', 'journal', 'year', 'authors', 'url', 'bibtex_key'];

// Returns one entry per file record:
//   { rec, status: 'new' }                              → will be inserted
//   { rec, status: 'existing', existing, matchedBy }    → already in library
//   { rec, status: 'repeat', firstIndex }               → same paper appears earlier in the file
export function planImport(recs, existing) {
  const idx = { doi: new Map(), pmid: new Map(), arxiv_id: new Map(), title: new Map() };
  for (const x of existing) {
    for (const k of ID_KEYS) if (x[k]) idx[k].set(x[k], x);
    const t = normTitle(x.title); if (t) idx.title.set(t, x);
  }
  const seen = { doi: new Map(), pmid: new Map(), arxiv_id: new Map(), title: new Map() };
  return recs.map((rec, i) => {
    for (const k of ID_KEYS) if (rec[k] && idx[k].has(rec[k])) return { rec, status: 'existing', existing: idx[k].get(rec[k]), matchedBy: k };
    const t = normTitle(rec.title);
    if (t && idx.title.has(t)) return { rec, status: 'existing', existing: idx.title.get(t), matchedBy: 'title' };
    for (const k of ID_KEYS) if (rec[k] && seen[k].has(rec[k])) return { rec, status: 'repeat', firstIndex: seen[k].get(rec[k]) };
    if (t && seen.title.has(t)) return { rec, status: 'repeat', firstIndex: seen.title.get(t) };
    for (const k of ID_KEYS) if (rec[k]) seen[k].set(rec[k], i);
    if (t) seen.title.set(t, i);
    return { rec, status: 'new' };
  });
}

// Patch for an existing paper: merged tags (+ optional file keywords) and empty fields filled.
// Returns null when nothing would change.
export function mergePatch(existing, rec, { extraTags = [], fileTags = false, fill = true } = {}) {
  const patch = {};
  const cur = existing.tags || [];
  const tags = [...new Set([...cur, ...extraTags, ...(fileTags ? rec.tags || [] : [])])];
  if (tags.length !== cur.length) patch.tags = tags;
  if (fill) for (const k of FILLABLE) {
    const empty = existing[k] == null || existing[k] === '';
    if (empty && rec[k] != null && rec[k] !== '') patch[k] = rec[k];
  }
  return Object.keys(patch).length ? patch : null;
}
