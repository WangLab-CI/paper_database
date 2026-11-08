// Shared: resolve a DOI / PMID / article link to a record (letting the user pick
// when only a search matched), then find-or-create the library paper.
import { sb, check, cleanPaper, findExisting } from '../db.js';
import { esc } from '../util.js';
import { lookupAny, lookup } from '../metadata.js';
import { modal } from '../ui.js';

// Returns { rec, via } or null if the user cancelled the candidate chooser.
export async function resolveInput(input) {
  const r = await lookupAny(input, { sb });
  if (r.rec) return r;
  return new Promise((resolve) => {
    const m = modal('Which paper is it?', `
      <p class="muted small">The link has no DOI or PMID${r.tried?.length ? ' and the page could not be read' : ''}. These papers match ${esc(r.via.replace(/^Crossref search for /, ''))}:</p>
      <ul class="list">${r.candidates.map((c, i) => `<li><a href="#" data-i="${i}"><b>${esc(c.title)}</b></a>
        <div class="meta">${esc(c.authors)} ${c.year || ''} ${c.journal ? '· <i>' + esc(c.journal) + '</i>' : ''} · ${esc(c.doi)}</div></li>`).join('')}</ul>
      <div class="row end"><button class="ghost" id="none">None of these</button></div>`, { wide: true });
    m.el.querySelectorAll('[data-i]').forEach((a) => (a.onclick = async (e) => {
      e.preventDefault();
      m.el.innerHTML = '<div class="loading">Fetching metadata…</div>';
      try { resolve({ rec: { ...(await lookup(r.candidates[+a.dataset.i].doi)), url: input }, via: 'chosen from Crossref search' }); }
      catch { resolve(null); }
      m.close();
    }));
    m.el.querySelector('#none').onclick = () => { m.close(); resolve(null); };
  });
}

// Returns { id, title, existed }
export async function findOrCreatePaper(rec, extraTags = []) {
  const p = cleanPaper({ ...rec, tags: [...new Set([...(rec.tags || []), ...extraTags])] });
  const ex = await findExisting(p);
  if (ex) return { id: ex.id, title: ex.title, existed: true };
  const row = check(await sb.from('papers').insert(p).select('id,title').single());
  return { ...row, existed: false };
}
