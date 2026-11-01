// Supabase client + shared data helpers.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const cfg = window.PORTAL_CONFIG || {};
export const configured = !!cfg.SUPABASE_URL && !String(cfg.SUPABASE_URL).startsWith('__');
export const sb = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

export const state = { user: null, profile: null, profiles: new Map() };

export const PAPER_COLS = 'id,title,authors,journal,year,abstract,doi,pmid,arxiv_id,url,pdf_url,bibtex_key,entry_type,tags,added_by,created_at,updated_at';

export function check({ data, error, count }) {
  if (error) throw error;
  return count !== undefined && count !== null ? { data, count } : data;
}

export async function loadProfiles() {
  const rows = check(await sb.from('profiles').select('id,email,full_name,avatar_url,role,created_at').order('full_name'));
  state.profiles = new Map(rows.map((r) => [r.id, r]));
  return rows;
}

export const personName = (id) => {
  const p = state.profiles.get(id);
  return p ? p.full_name || p.email.split('@')[0] : '—';
};

export const members = () => [...state.profiles.values()].filter((p) => p.role !== 'pending');

// Fetch all rows of a query in pages of 1000 (PostgREST default max).
export async function fetchAll(table, select, modify = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await modify(sb.from(table).select(select)).range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// Look for an existing paper sharing DOI / PMID / arXiv ID / exact title.
export async function findExisting(p) {
  for (const [col, val] of [['doi', p.doi], ['pmid', p.pmid], ['arxiv_id', p.arxiv_id]]) {
    if (!val) continue;
    const rows = check(await sb.from('papers').select('id,title').eq(col, val).limit(1));
    if (rows.length) return rows[0];
  }
  if (p.title) {
    const rows = check(await sb.from('papers').select('id,title').ilike('title', p.title.replace(/[%_\\]/g, '\\$&')).limit(1));
    if (rows.length) return rows[0];
  }
  return null;
}

export function cleanPaper(p) {
  const out = {};
  for (const k of ['title', 'authors', 'journal', 'year', 'abstract', 'doi', 'pmid', 'arxiv_id', 'url', 'pdf_url', 'bibtex_key', 'entry_type', 'tags']) {
    let v = p[k];
    if (typeof v === 'string') v = v.trim();
    out[k] = v === '' || v === undefined ? null : v;
  }
  out.tags = out.tags || [];
  out.entry_type = out.entry_type || 'article';
  out.year = out.year ? parseInt(out.year, 10) || null : null;
  return out;
}

export async function allTags() {
  const rows = check(await sb.from('tag_counts').select('*').order('tag'));
  return rows;
}
