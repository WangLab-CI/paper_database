// BibTeX & RIS parsing (Zotero/Mendeley/EndNote exports) and BibTeX export.
import { normalizeDoi } from './util.js';

const ACCENTS = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆', H: '̋' };

export function delatex(s) {
  if (!s) return s;
  return s
    .replace(/\\([\"'`^~=.])\s*\{?\\?([a-zA-Z])\}?/g, (_, a, ch) => (ch + ACCENTS[a]).normalize('NFC'))
    .replace(/\\([cvuH])\{([a-zA-Z])\}/g, (_, a, ch) => (ch + ACCENTS[a]).normalize('NFC'))
    .replace(/\\ss\b\{?\}?/g, 'ß').replace(/\\o\b\{?\}?/g, 'ø').replace(/\\aa\b\{?\}?/g, 'å').replace(/\\ae\b\{?\}?/g, 'æ')
    .replace(/\\textendash\{?\}?|--/g, '–').replace(/\\textemdash\{?\}?|---/g, '—')
    .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\\$/g, '$').replace(/\\#/g, '#')
    .replace(/\\(?:emph|textit|textbf|mathrm|mathbf|textsuperscript|textsubscript)\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:it|bf|em|sc|rm|tt|sl|sf|small|footnotesize)\b\s*/g, '')
    .replace(/\\(?:text[a-z]+|mbox|url)\{([^{}]*)\}/g, '$1')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse a BibTeX string → array of {type, key, fields{}}
export function parseBibtexRaw(src) {
  const out = [];
  const strings = {};
  let i = 0;
  const n = src.length;
  while (i < n) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const tm = /^([a-zA-Z]+)\s*([{(])/.exec(src.slice(i, i + 40));
    if (!tm) continue;
    const type = tm[1].toLowerCase();
    const close = tm[2] === '{' ? '}' : ')';
    i += tm[0].length;
    // find matching close
    let depth = 1, j = i, inQuote = false;
    while (j < n && depth > 0) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '"' && depth === 1) inQuote = !inQuote;
      else if (!inQuote && (c === '{' || (close === ')' && c === '('))) depth++;
      else if (!inQuote && (c === '}' || (close === ')' && c === ')'))) depth--;
      j++;
    }
    const body = src.slice(i, j - 1);
    i = j;
    if (type === 'comment' || type === 'preamble') continue;
    if (type === 'string') {
      const f = parseFields(body, strings);
      Object.assign(strings, f);
      continue;
    }
    const comma = body.indexOf(',');
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    const fields = comma < 0 ? {} : parseFields(body.slice(comma + 1), strings);
    out.push({ type, key, fields });
  }
  return out;
}

function parseFields(s, strings) {
  const fields = {};
  let i = 0;
  const n = s.length;
  while (i < n) {
    const m = /^\s*,?\s*([A-Za-z0-9_\-:.]+)\s*=\s*/.exec(s.slice(i));
    if (!m) break;
    const name = m[1].toLowerCase();
    i += m[0].length;
    let value = '';
    // value = part (# part)*
    for (;;) {
      while (/\s/.test(s[i])) i++;
      if (s[i] === '{') {
        let d = 1, j = i + 1;
        while (j < n && d > 0) { if (s[j] === '\\') { j += 2; continue; } if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
        value += s.slice(i + 1, j - 1); i = j;
      } else if (s[i] === '"') {
        let d = 0, j = i + 1;
        while (j < n && !(s[j] === '"' && d === 0)) { if (s[j] === '\\') { j += 2; continue; } if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
        value += s.slice(i + 1, j); i = j + 1;
      } else {
        const w = /^[A-Za-z0-9_\-:.]+/.exec(s.slice(i));
        if (!w) break;
        value += strings[w[0].toLowerCase()] ?? w[0]; i += w[0].length;
      }
      while (/\s/.test(s[i])) i++;
      if (s[i] === '#') { i++; continue; }
      break;
    }
    fields[name] = value;
    while (i < n && s[i] !== ',') i++;
  }
  return fields;
}

function splitAuthors(a) {
  if (!a) return null;
  return delatex(a).split(/\s+and\s+/i).map((x) => {
    x = x.trim();
    if (x.includes(',')) return x;
    const parts = x.split(/\s+/);
    if (parts.length < 2) return x;
    return `${parts.pop()}, ${parts.join(' ')}`;
  }).join('; ');
}

const tagSplit = (s) => (s ? delatex(s).split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean) : []);

export function bibEntryToPaper(e) {
  const f = e.fields;
  let arxiv = null;
  if ((f.archiveprefix || f.eprinttype || '').toLowerCase() === 'arxiv' && f.eprint) arxiv = f.eprint.replace(/v\d+$/, '').trim();
  const am = !arxiv && (f.journal || f.url || '').match(/arxiv[^\d]*(\d{4}\.\d{4,5})/i);
  if (am) arxiv = am[1];
  const pm = (f.pmid || f.note || f.extra || '').match(/PMID:?\s*(\d+)/i) || (f.pmid ? [null, f.pmid] : null);
  const year = parseInt((f.year || f.date || '').match(/\d{4}/)?.[0], 10);
  return {
    title: delatex(f.title) || '(untitled)',
    authors: splitAuthors(f.author || f.editor),
    journal: delatex(f.journal || f.journaltitle || f.booktitle || f.publisher || f.school || f.institution) || null,
    year: Number.isFinite(year) ? year : null,
    abstract: delatex(f.abstract) || null,
    doi: normalizeDoi(f.doi),
    pmid: pm ? String(pm[1]).trim() : null,
    arxiv_id: arxiv,
    url: f.url || null,
    pdf_url: null,
    bibtex_key: e.key || null,
    entry_type: e.type,
    tags: [...new Set([...tagSplit(f.keywords), ...tagSplit(f['mendeley-tags'])])],
  };
}

export const parseBibtex = (src) => parseBibtexRaw(src).map(bibEntryToPaper);

// ---------------------------------------------------------------- RIS
const RIS_TYPES = { JOUR: 'article', BOOK: 'book', CHAP: 'incollection', CONF: 'inproceedings', CPAPER: 'inproceedings', THES: 'phdthesis', RPRT: 'techreport', UNPB: 'unpublished', ELEC: 'misc', GEN: 'misc' };

export function parseRis(src) {
  const out = [];
  let cur = null, lastTag = null;
  for (const raw of src.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])  -\s?(.*)$/.exec(raw);
    if (!m) { if (cur && lastTag && raw.trim()) cur[lastTag][cur[lastTag].length - 1] += ' ' + raw.trim(); continue; }
    const [, tag, val] = m;
    if (tag === 'TY') { cur = { TY: [val.trim()] }; lastTag = 'TY'; continue; }
    if (!cur) continue;
    if (tag === 'ER') { out.push(cur); cur = null; lastTag = null; continue; }
    (cur[tag] ||= []).push(val.trim());
    lastTag = tag;
  }
  return out.map((r) => {
    const g = (...tags) => { for (const t of tags) if (r[t]?.length) return r[t][0]; return null; };
    const yr = parseInt((g('PY', 'Y1', 'DA') || '').match(/\d{4}/)?.[0], 10);
    const notes = (r.N1 || []).join(' ') + ' ' + (r.AN || []).join(' ');
    const pm = notes.match(/PMID:?\s*(\d+)/i) || (/^\d+$/.test(g('AN') || '') ? [null, g('AN')] : null);
    const doi = normalizeDoi(g('DO')) || normalizeDoi((r.UR || []).find((u) => /doi\.org/.test(u)));
    const ar = (r.UR || []).join(' ').match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
    return {
      title: g('TI', 'T1', 'CT') || '(untitled)',
      authors: [...(r.AU || []), ...(r.A1 || [])].join('; ') || null,
      journal: g('T2', 'JO', 'JF', 'JA', 'BT', 'PB'),
      year: Number.isFinite(yr) ? yr : null,
      abstract: g('AB', 'N2'),
      doi,
      pmid: pm ? pm[1] : null,
      arxiv_id: ar ? ar[1] : null,
      url: g('UR'),
      pdf_url: null,
      bibtex_key: null,
      entry_type: RIS_TYPES[r.TY[0]] || 'article',
      tags: [...new Set((r.KW || []).map((k) => k.toLowerCase().trim()).filter(Boolean))],
    };
  });
}

export function parseReferences(text, filename = '') {
  if (/\.ris$|\.txt$/i.test(filename) || /^TY  -/m.test(text)) return parseRis(text);
  return parseBibtex(text);
}

// ---------------------------------------------------------------- export
const bibEsc = (s) => String(s).replace(/([&%#_])/g, '\\$1');

export function makeKey(p, used = new Set()) {
  const fam = (p.authors || 'anon').split(';')[0].split(',')[0].normalize('NFD').replace(/[^\w]/g, '').toLowerCase() || 'anon';
  const word = (p.title || '').toLowerCase().split(/\W+/).find((w) => w.length > 3 && !['with', 'from', 'that', 'this', 'into'].includes(w)) || 'x';
  let key = `${fam}${p.year || ''}${word}`;
  let k = key, i = 1;
  while (used.has(k)) k = key + String.fromCharCode(96 + ++i);
  used.add(k);
  return k;
}

export function toBibtex(papers) {
  const used = new Set();
  return papers.map((p) => {
    const key = p.bibtex_key && !used.has(p.bibtex_key) ? (used.add(p.bibtex_key), p.bibtex_key) : makeKey(p, used);
    const f = [];
    const add = (k, v) => { if (v) f.push(`  ${k} = {${v}}`); };
    add('title', p.title && bibEsc(p.title));
    add('author', p.authors ? p.authors.split(';').map((a) => a.trim()).filter(Boolean).join(' and ') : null);
    add(p.entry_type === 'inproceedings' || p.entry_type === 'incollection' ? 'booktitle' : 'journal', p.journal && bibEsc(p.journal));
    add('year', p.year);
    add('doi', p.doi);
    add('pmid', p.pmid);
    if (p.arxiv_id) { add('eprint', p.arxiv_id); add('archiveprefix', 'arXiv'); }
    add('url', p.url);
    add('keywords', (p.tags || []).join(', '));
    add('abstract', p.abstract && bibEsc(p.abstract));
    return `@${p.entry_type || 'article'}{${key},\n${f.join(',\n')}\n}`;
  }).join('\n\n') + '\n';
}
