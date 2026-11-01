// Shared helpers: escaping, markdown, toasts, formatting.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function md(text) {
  if (!text) return '';
  const html = window.marked ? window.marked.parse(String(text), { breaks: true }) : esc(text);
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : esc(text);
}

export function toast(msg, kind = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function fail(err, ctx = '') {
  console.error(ctx, err);
  toast(`${ctx ? ctx + ': ' : ''}${err?.message || err}`, 'error', 6000);
}

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function normalizeDoi(doi) {
  if (!doi) return null;
  const m = String(doi).trim().match(/10\.\d{4,9}\/\S+/i);
  return m ? m[0].replace(/[.,;]+$/, '').toLowerCase() : null;
}

export function parseTags(s) {
  return [...new Set(String(s || '').split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

export function authorsShort(authors, n = 3) {
  if (!authors) return '';
  const list = authors.split(';').map((a) => a.trim()).filter(Boolean);
  const fam = list.map((a) => a.split(',')[0].trim());
  return fam.length > n ? `${fam.slice(0, n).join(', ')} et al.` : fam.join(', ');
}

export function tagChips(tags, linkBase = '#/papers?tag=') {
  return (tags || []).map((t) => `<a class="tag" href="${linkBase}${encodeURIComponent(t)}">${esc(t)}</a>`).join(' ');
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const STATUSES = ['idea', 'exploring', 'pilot', 'active', 'paused', 'completed', 'archived'];
export const RELATIONS = ['background', 'supports', 'contradicts', 'method', 'dataset', 'inspiration'];
export const PROJECT_FIELDS = [
  ['summary', 'Summary', 'One-paragraph overview of the idea.'],
  ['hypothesis', 'Hypothesis', 'Testable statement(s). What would falsify it?'],
  ['rationale', 'Rationale & evidence', 'Why now? Key prior findings (cite linked papers).'],
  ['aims', 'Aims / approach', 'Experiments, models, cohorts, data sets.'],
  ['open_questions', 'Open questions & risks', 'Unknowns, confounders, technical risks.'],
  ['next_steps', 'Next steps', 'Concrete actions, owners, dates.'],
];
