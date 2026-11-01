// In-memory stand-in for @supabase/supabase-js used ONLY by the browser smoke
// test. Implements the subset of the PostgREST query builder the portal uses
// and mimics the schema's triggers (project versioning, profiles, tag view).
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const ME = '00000000-0000-0000-0000-00000000000a';
const DB = window.__MOCK_DB__ = {
  profiles: [
    { id: ME, email: 'pi@lab.org', full_name: 'Test PI', role: 'admin', created_at: now() },
    { id: '00000000-0000-0000-0000-00000000000b', email: 'stu@lab.org', full_name: 'Student B', role: 'member', created_at: now() },
    { id: '00000000-0000-0000-0000-00000000000c', email: 'new@x.org', full_name: 'Newcomer', role: 'pending', created_at: now() },
  ],
  allowlist: [{ email: 'pi@lab.org', role: 'admin', created_at: now() }, { email: 'stu@lab.org', role: 'member', created_at: now() }],
  papers: [], paper_notes: [], paper_links: [], projects: [], project_versions: [], project_papers: [], project_updates: [],
};
const P1 = uuid(), P2 = uuid(), PR1 = uuid();
DB.papers.push(
  { id: P1, title: 'TP53 loss drives organoid fitness', authors: 'Smith, John; Doe, Ann', journal: 'Nature', year: 2021, abstract: 'An abstract about TP53.', doi: '10.1000/a', pmid: '111', arxiv_id: null, url: null, pdf_url: null, bibtex_key: null, entry_type: 'article', tags: ['tp53', 'organoids'], added_by: ME, created_at: now(), updated_at: now() },
  { id: P2, title: 'Spatial atlas of PDAC', authors: 'Lee, K', journal: 'Cell', year: 2024, abstract: null, doi: '10.1000/b', pmid: null, arxiv_id: null, url: null, pdf_url: null, bibtex_key: null, entry_type: 'article', tags: ['pdac', 'organoids'], added_by: ME, created_at: now(), updated_at: now() },
);
DB.projects.push({ id: PR1, title: 'Organoid TP53 screen', status: 'idea', summary: 'Seed summary', hypothesis: 'H0', rationale: '', aims: '', open_questions: '', next_steps: '', tags: ['tp53'], owner_id: ME, collaborators: [], version: 1, last_change_note: null, last_edited_by: ME, created_at: now(), updated_at: now() });
DB.project_versions.push({ id: 1, project_id: PR1, version: 1, snapshot: { ...DB.projects[0] }, change_note: 'Created', edited_by: ME, created_at: now() });
DB.project_papers.push({ project_id: PR1, paper_id: P1, relation: 'supports', note: 'key', added_by: ME, created_at: now() });

const CONTENT = ['title', 'status', 'summary', 'hypothesis', 'rationale', 'aims', 'open_questions', 'next_steps', 'tags', 'collaborators', 'owner_id'];
const DEFAULTS = {
  papers: () => ({ id: uuid(), tags: [], entry_type: 'article', added_by: ME, created_at: now(), updated_at: now() }),
  paper_notes: () => ({ id: uuid(), user_id: ME, body: '', rating: null, reading_status: 'to_read', created_at: now(), updated_at: now() }),
  projects: () => ({ id: uuid(), status: 'idea', summary: '', hypothesis: '', rationale: '', aims: '', open_questions: '', next_steps: '', tags: [], owner_id: ME, collaborators: [], version: 1, last_edited_by: ME, created_at: now(), updated_at: now() }),
  project_papers: () => ({ relation: 'background', added_by: ME, created_at: now() }),
  project_updates: () => ({ id: uuid(), author_id: ME, created_at: now() }),
  allowlist: () => ({ role: 'member', created_at: now() }),
  paper_links: () => ({ created_by: ME, created_at: now(), score: null, shared: null, note: null }),
};
const UNIQUE = { papers: [['id'], ['doi'], ['pmid'], ['arxiv_id']], paper_links: [['source_id', 'target_id', 'kind']], paper_notes: [['paper_id', 'user_id']], project_papers: [['project_id', 'paper_id']], allowlist: [['email']] };

function snapshot(p, note) {
  const { last_change_note, version, created_at, updated_at, last_edited_by, ...snap } = p;
  DB.project_versions.push({ id: DB.project_versions.length + 1, project_id: p.id, version: p.version, snapshot: structuredClone(snap), change_note: note, edited_by: ME, created_at: now() });
}

function tagCounts() {
  const m = new Map();
  for (const p of DB.papers) for (const t of p.tags) { const r = m.get(t) || { tag: t, n_papers: 0, n_projects: 0 }; r.n_papers++; m.set(t, r); }
  for (const p of DB.projects) for (const t of p.tags) { const r = m.get(t) || { tag: t, n_papers: 0, n_projects: 0 }; r.n_projects++; m.set(t, r); }
  return [...m.values()];
}

const table = (t) => (t === 'tag_counts' ? tagCounts() : DB[t]);
const singular = (t) => t.replace(/s$/, '');

function splitTop(s) {
  const out = []; let d = 0, cur = '';
  for (const c of s) { if (c === '(') d++; if (c === ')') d--; if (c === ',' && !d) { out.push(cur.trim()); cur = ''; } else cur += c; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function project(row, srcTable, cols) {
  if (!cols || cols === '*') return { ...row };
  const out = {};
  for (const c of splitTop(cols)) {
    const m = c.match(/^(?:(\w+):)?(\w+)(!inner)?\((.*)\)$/s);
    if (!m) { if (c === '*') Object.assign(out, row); else out[c] = row[c]; continue; }
    const [, alias, tgt, , sub] = m;
    const fk = `${singular(tgt)}_id`;
    if (fk in row) {
      const parent = DB[tgt].find((r) => r.id === row[fk]);
      out[alias || tgt] = parent ? project(parent, tgt, sub) : null;
    } else {
      const back = `${singular(srcTable)}_id`;
      out[alias || tgt] = DB[tgt].filter((r) => r[back] === row.id).map((r) => project(r, tgt, sub));
    }
  }
  return out;
}

class Q {
  constructor(t) { Object.assign(this, { t, op: 'select', filters: [], embedFilters: [], orders: [], from: 0, to: Infinity, cols: '*', returning: false }); }
  select(cols = '*', opts = {}) { if (this.op === 'select') { this.cols = cols; this.opts = opts; } else { this.returning = true; this.cols = cols; } return this; }
  insert(rows) { this.op = 'insert'; this.payload = [].concat(rows); return this; }
  upsert(rows) { this.op = 'upsert'; this.payload = [].concat(rows); return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  _f(col, fn) { if (col.includes('.')) { const [a, c] = col.split('.'); this.embedFilters.push([a, c, fn]); } else this.filters.push((r) => fn(r[col])); return this; }
  eq(c, v) { return this._f(c, (x) => x === v); }
  gte(c, v) { return this._f(c, (x) => x >= v); }
  in(c, vs) { return this._f(c, (x) => vs.includes(x)); }
  not(c, op, v) { return this._f(c, (x) => (op === 'is' && v === null ? x != null : x !== v)); }
  contains(c, vs) { return this._f(c, (x) => vs.every((v) => (x || []).includes(v))); }
  ilike(c, pat) { const re = new RegExp('^' + pat.replace(/\\([%_\\])/g, '$1').replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); return this._f(c, (x) => re.test(x || '')); }
  textSearch(c, q) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w && !w.startsWith('-'));
    this.filters.push((r) => { const hay = [r.title, r.authors, r.journal, r.abstract].join(' ').toLowerCase(); return words.every((w) => hay.includes(w.replace(/"/g, ''))); });
    return this;
  }
  order(c, { ascending = true } = {}) { this.orders.push([c, ascending]); return this; }
  range(a, b) { this.from = a; this.to = b; return this; }
  limit(n) { this.to = this.from + n - 1; return this; }
  maybeSingle() { this.single_ = 'maybe'; return this; }
  single() { this.single_ = 'one'; return this; }
  then(res, rej) { try { return Promise.resolve(this.exec()).then(res, rej); } catch (e) { return Promise.resolve({ data: null, error: { message: e.message } }).then(res, rej); } }

  matchRows() { return table(this.t).filter((r) => this.filters.every((f) => f(r))); }
  violates(row, self) {
    for (const cols of UNIQUE[this.t] || []) {
      if (cols.some((c) => row[c] == null)) continue;
      if (DB[this.t].some((r) => r !== self && cols.every((c) => r[c] === row[c]))) return cols;
    }
  }
  exec() {
    let rows;
    if (this.op === 'select') {
      rows = this.matchRows();
      let out = rows.map((r) => project(r, this.t, this.cols));
      for (const [alias, col, fn] of this.embedFilters) out = out.map((r) => ({ ...r, [alias]: r[alias].filter((x) => fn(x[col])) }));
      if (/!inner/.test(this.cols)) for (const m of this.cols.matchAll(/(\w+):\w+!inner/g)) out = out.filter((r) => r[m[1]].length);
      for (const [c, asc] of [...this.orders].reverse()) out.sort((a, b) => ((a[c] ?? '') > (b[c] ?? '') ? 1 : (a[c] ?? '') < (b[c] ?? '') ? -1 : 0) * (asc ? 1 : -1));
      const count = out.length;
      out = out.slice(this.from, this.to + 1);
      if (this.opts?.head) return { data: null, count, error: null };
      return this.finish(out, this.opts?.count ? count : null);
    }
    if (this.op === 'insert' || this.op === 'upsert') {
      const made = [];
      for (const p of this.payload) {
        const row = { ...(DEFAULTS[this.t]?.() || {}), ...p };
        const clash = this.violates(row);
        if (clash) {
          if (this.op === 'upsert') { const ex = DB[this.t].find((r) => clash.every((c) => r[c] === row[c])); Object.assign(ex, p, { updated_at: now() }); made.push(ex); continue; }
          return { data: null, error: { message: `duplicate key value violates unique constraint (${clash})` } };
        }
        DB[this.t].push(row); made.push(row);
        if (this.t === 'projects') snapshot(row, 'Created');
        if (this.t === 'allowlist') DB.profiles.filter((x) => x.email === row.email).forEach((x) => (x.role = row.role));
      }
      return this.finish(made.map((r) => project(r, this.t, this.cols)));
    }
    if (this.op === 'update') {
      rows = this.matchRows();
      for (const r of rows) {
        const before = structuredClone(r);
        Object.assign(r, this.payload);
        if (this.t === 'projects') {
          if (CONTENT.some((k) => JSON.stringify(before[k]) !== JSON.stringify(r[k]))) { r.version = before.version + 1; r.updated_at = now(); snapshot(r, r.last_change_note); }
          else r.version = before.version;
        }
        if (this.t === 'allowlist') DB.profiles.filter((p) => p.email === r.email).forEach((p) => (p.role = r.role));
      }
      return this.finish(rows.map((r) => project(r, this.t, this.cols)));
    }
    if (this.op === 'delete') {
      rows = this.matchRows();
      DB[this.t] = DB[this.t].filter((r) => !rows.includes(r));
      if (this.t === 'allowlist') rows.forEach((a) => DB.profiles.filter((p) => p.email === a.email).forEach((p) => (p.role = 'pending')));
      return { data: null, error: null };
    }
  }
  finish(out, count = null) {
    if (this.op !== 'select' && !this.returning && !this.single_) return { data: null, error: null };
    if (this.single_ === 'one') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: `expected 1 row, got ${out.length}` } };
    if (this.single_ === 'maybe') return { data: out[0] ?? null, error: null };
    return { data: out, count, error: null };
  }
}

export function createClient() {
  const session = { user: { id: ME, email: 'pi@lab.org' } };
  let listener = null;
  // Simulate a signed-out visitor returning from an expired email link.
  const signedOut = /error_code=/.test(location.hash);
  return {
    from: (t) => new Q(t),
    auth: {
      onAuthStateChange(cb) { listener = cb; setTimeout(() => cb('INITIAL_SESSION', signedOut ? null : session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: async () => ({ error: null }),
      signInWithOAuth: async () => ({ error: null }),
      signInWithOtp: async () => ({ error: null }),
      verifyOtp: async ({ token }) => {
        if (token !== '123456') return { data: null, error: { message: 'Token has expired or is invalid' } };
        setTimeout(() => listener?.('SIGNED_IN', session), 0);
        return { data: { session }, error: null };
      },
    },
  };
}
