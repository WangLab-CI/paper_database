import { sb, state, check, personName, PAPER_COLS, cleanPaper, allTags } from '../db.js';
import { esc, md, fmtDate, authorsShort, tagChips, toast, fail, qs, download, RELATIONS, debounce } from '../util.js';
import { modal, confirmDialog, tagInputHtml, readTags, formData } from '../ui.js';
import { toBibtex } from '../bibtex.js';

const PAGE = 50;

// =================================================================== list
export async function papersView(root, { params }) {
  const q = params.q || '', tag = params.tag || '', sort = params.sort || 'added', rs = params.rs || '';
  const page = Math.max(0, parseInt(params.page || '0', 10));
  const go = (o) => { location.hash = '#/papers' + qs({ q, tag, sort, rs, ...o, page: o.page ?? 0 }); };

  const tags = await allTags();
  const buildQuery = (cols, opts) => {
    let sel = cols;
    if (rs) sel += ',mine:paper_notes!inner(reading_status,user_id)';
    let query = sb.from('papers').select(sel, opts);
    if (q) query = query.textSearch('search', q, { type: 'websearch', config: 'english' });
    if (tag) query = query.contains('tags', [tag]);
    if (rs) query = query.eq('mine.user_id', state.user.id).eq('mine.reading_status', rs);
    const order = { added: ['created_at', false], year: ['year', false], title: ['title', true], updated: ['updated_at', false] }[sort] || ['created_at', false];
    return query.order(order[0], { ascending: order[1], nullsFirst: false });
  };
  const { data: rows, count } = check(await buildQuery('id,title,authors,journal,year,tags,doi,pmid,arxiv_id,added_by,created_at,notes:paper_notes(user_id,rating,reading_status)', { count: 'exact' })
    .range(page * PAGE, page * PAGE + PAGE - 1));

  const topTags = [...tags].sort((a, b) => b.n_papers - a.n_papers).filter((t) => t.n_papers > 0).slice(0, 30);
  const pages = Math.ceil((count || 0) / PAGE);

  root.innerHTML = `
    <div class="page-head">
      <h1>Papers <span class="muted">${count ?? 0}</span></h1>
      <div class="row">
        <a class="button primary" href="#/import">+ Add paper</a>
        <button id="export">Export BibTeX</button>
      </div>
    </div>
    <form class="filters" id="filters">
      <input name="q" value="${esc(q)}" placeholder="Search title, authors, journal, abstract  (e.g. &quot;tumour evolution&quot; -review)">
      <select name="sort">
        ${[['added', 'Newest added'], ['updated', 'Recently edited'], ['year', 'Publication year'], ['title', 'Title A–Z']].map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <select name="rs">
        <option value="">All papers</option>
        ${[['to_read', 'My: to read'], ['reading', 'My: reading'], ['read', 'My: read']].map(([v, l]) => `<option value="${v}" ${v === rs ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button>Search</button>
    </form>
    <div class="tagbar">
      ${tag ? `<span class="tag active">${esc(tag)} <a href="#/papers${qs({ q, sort, rs })}" title="clear">✕</a></span>` : ''}
      ${topTags.filter((t) => t.tag !== tag).map((t) => `<a class="tag" href="#/papers${qs({ q, sort, rs, tag: t.tag })}">${esc(t.tag)} <small>${t.n_papers}</small></a>`).join(' ')}
    </div>
    <div class="paper-list">
      ${rows.length ? rows.map((p) => paperRow(p)).join('') : '<p class="muted card">No papers match.</p>'}
    </div>
    ${pages > 1 ? `<div class="pager">
      ${page > 0 ? `<a class="button" href="#/papers${qs({ q, tag, sort, rs, page: page - 1 })}">← Prev</a>` : ''}
      <span>Page ${page + 1} of ${pages}</span>
      ${page < pages - 1 ? `<a class="button" href="#/papers${qs({ q, tag, sort, rs, page: page + 1 })}">Next →</a>` : ''}
    </div>` : ''}`;

  const f = root.querySelector('#filters');
  f.onsubmit = (e) => { e.preventDefault(); go({ q: f.q.value.trim(), sort: f.sort.value, rs: f.rs.value }); };
  f.sort.onchange = f.rs.onchange = () => f.requestSubmit();

  root.querySelector('#export').onclick = async () => {
    try {
      const all = [];
      for (let from = 0; ; from += 1000) {
        const rows = check(await buildQuery(PAPER_COLS).range(from, from + 999));
        all.push(...rows);
        if (rows.length < 1000) break;
      }
      download(`papers${tag ? '-' + tag : ''}.bib`, toBibtex(all), 'application/x-bibtex');
      toast(`Exported ${all.length} references`);
    } catch (e) { fail(e, 'Export'); }
  };
}

function paperRow(p) {
  const notes = p.notes || [];
  const ratings = notes.map((n) => n.rating).filter(Boolean);
  const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
  const mine = notes.find((n) => n.user_id === state.user.id);
  return `
    <article class="paper-row">
      <div class="main">
        <a class="title" href="#/paper/${p.id}">${esc(p.title)}</a>
        <div class="meta">${esc(authorsShort(p.authors))}${p.year ? ' · ' + p.year : ''}${p.journal ? ' · <i>' + esc(p.journal) + '</i>' : ''}</div>
        <div>${tagChips(p.tags)}</div>
      </div>
      <div class="side">
        ${mine ? `<span class="rs rs-${mine.reading_status}">${mine.reading_status.replace('_', ' ')}</span>` : ''}
        ${avg ? `<span title="${ratings.length} rating(s)">★ ${avg}</span>` : ''}
        ${notes.length ? `<span title="lab annotations">💬 ${notes.length}</span>` : ''}
        <span class="muted small">${esc(personName(p.added_by))}</span>
      </div>
    </article>`;
}

// ================================================================= detail
export async function paperView(root, { id }) {
  const [paper, notes, links, projects, tags, related] = await Promise.all([
    sb.from('papers').select(PAPER_COLS + ',openalex_id,cited_by_count,oa_topics').eq('id', id).maybeSingle().then(check),
    sb.from('paper_notes').select('*').eq('paper_id', id).order('updated_at', { ascending: false }).then(check),
    sb.from('project_papers').select('relation,note,project:projects(id,title,status)').eq('paper_id', id).then(check),
    sb.from('projects').select('id,title,status').order('title').then(check),
    allTags(),
    relatedPapers(id),
  ]);
  if (!paper) { root.innerHTML = '<div class="card">Paper not found. <a href="#/papers">Back</a></div>'; return; }

  const my = notes.find((n) => n.user_id === state.user.id) || { body: '', rating: null, reading_status: 'to_read', _new: true };
  const others = notes.filter((n) => n.user_id !== state.user.id);
  const canDelete = state.profile.role === 'admin' || paper.added_by === state.user.id;

  root.innerHTML = `
    <div class="crumbs"><a href="#/papers">Papers</a> /</div>
    <article class="card paper-detail">
      <h1>${esc(paper.title)}</h1>
      <p class="authors">${esc((paper.authors || '').split(';').map((a) => a.trim()).join(', '))}</p>
      <p class="meta">${paper.journal ? `<i>${esc(paper.journal)}</i>` : ''} ${paper.year || ''}
        · added by ${esc(personName(paper.added_by))} on ${fmtDate(paper.created_at)}</p>
      <div class="links">
        ${paper.doi ? `<a target="_blank" rel="noopener" href="https://doi.org/${esc(paper.doi)}">DOI: ${esc(paper.doi)}</a>` : ''}
        ${paper.pmid ? `<a target="_blank" rel="noopener" href="https://pubmed.ncbi.nlm.nih.gov/${esc(paper.pmid)}/">PubMed ${esc(paper.pmid)}</a>` : ''}
        ${paper.arxiv_id ? `<a target="_blank" rel="noopener" href="https://arxiv.org/abs/${esc(paper.arxiv_id)}">arXiv ${esc(paper.arxiv_id)}</a>` : ''}
        ${paper.pdf_url ? `<a target="_blank" rel="noopener" href="${esc(paper.pdf_url)}">PDF</a>` : ''}
        ${paper.url && !paper.doi ? `<a target="_blank" rel="noopener" href="${esc(paper.url)}">Link</a>` : ''}
        ${paper.openalex_id ? `<a target="_blank" rel="noopener" href="https://openalex.org/${esc(paper.openalex_id)}">OpenAlex</a>
          <span class="muted">cited by ${paper.cited_by_count ?? '?'}</span>` : ''}
      </div>
      ${paper.oa_topics?.length ? `<p class="meta">OpenAlex topics: ${paper.oa_topics.map(esc).join(' · ')}</p>` : ''}
      <div class="tagline">${tagChips(paper.tags)} <button class="ghost small" id="edit-tags">✎ tags</button></div>
      ${paper.abstract ? `<details open><summary>Abstract</summary><p class="abstract">${esc(paper.abstract)}</p></details>` : '<p class="muted">No abstract stored.</p>'}
      <div class="row">
        <button id="edit">Edit metadata</button>
        <button id="bib">Copy BibTeX</button>
        ${canDelete ? '<button class="danger ghost" id="del">Delete</button>' : ''}
      </div>
    </article>

    <div class="grid-2">
      <section class="card">
        <h2>My notes</h2>
        <form id="my-note">
          <div class="row">
            <label>Status <select name="reading_status">
              ${['to_read', 'reading', 'read'].map((s) => `<option value="${s}" ${s === my.reading_status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
            </select></label>
            <label>Rating <select name="rating"><option value="">–</option>
              ${[1, 2, 3, 4, 5].map((r) => `<option value="${r}" ${r === my.rating ? 'selected' : ''}>${'★'.repeat(r)}</option>`).join('')}
            </select></label>
          </div>
          <textarea name="body" rows="8" placeholder="Key findings, methods, caveats, relevance to our work… (Markdown supported)">${esc(my.body)}</textarea>
          <div class="row end">${!my._new ? '<button type="button" class="ghost" id="del-note">Remove</button>' : ''}<button class="primary">Save note</button></div>
        </form>
      </section>
      <section class="card">
        <h2>Linked projects</h2>
        ${links.length ? `<ul class="list">${links.filter((l) => l.project).map((l) => `
          <li><span class="rel rel-${l.relation}">${l.relation}</span> <a href="#/project/${l.project.id}">${esc(l.project.title)}</a>
          <span class="status s-${l.project.status}">${l.project.status}</span>${l.note ? `<div class="meta">${esc(l.note)}</div>` : ''}</li>`).join('')}</ul>`
          : '<p class="muted">Not linked to any project.</p>'}
        <form id="link" class="row wrap">
          <select name="project" required><option value="">Link to project…</option>
            ${projects.filter((p) => !links.some((l) => l.project?.id === p.id)).map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select>
          <select name="relation">${RELATIONS.map((r) => `<option>${r}</option>`).join('')}</select>
          <input name="note" placeholder="Why relevant? (optional)">
          <button>Link</button>
        </form>
        <h2>Lab notes</h2>
        ${others.length ? others.map((n) => `
          <div class="note">
            <div class="meta"><b>${esc(personName(n.user_id))}</b> · ${n.reading_status.replace('_', ' ')} ${n.rating ? '· ' + '★'.repeat(n.rating) : ''} · ${fmtDate(n.updated_at)}</div>
            <div class="md">${md(n.body) || '<span class="muted">(no text)</span>'}</div>
          </div>`).join('') : '<p class="muted">No one else has annotated this paper yet.</p>'}
      </section>
    </div>
    <section class="card" id="related">${relatedHtml(related)}</section>`;

  const reload = () => paperView(root, { id });

  root.querySelector('#add-rel').onclick = () => paperPicker((otherId) => {
    const m = modal('Link related paper', `<form>
      <label>Why are they related? <input name="note" placeholder="e.g. replicates Fig. 3 in a different cohort"></label>
      <div class="row end"><button class="primary">Link</button></div></form>`);
    m.el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        check(await sb.from('paper_links').insert({ source_id: id, target_id: otherId, kind: 'manual', note: e.target.note.value || null }));
        m.close(); reload();
      } catch (err) { fail(err, 'Link'); }
    };
  }, new Set([id, ...related.map((r) => r.other.id)]));
  root.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = async () => {
    const [src, tgt] = b.dataset.unlink.split('|');
    try { check(await sb.from('paper_links').delete().eq('source_id', src).eq('target_id', tgt).eq('kind', 'manual')); reload(); }
    catch (err) { fail(err); }
  }));

  root.querySelector('#my-note').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      check(await sb.from('paper_notes').upsert({
        paper_id: id, user_id: state.user.id, body: d.body, reading_status: d.reading_status, rating: d.rating ? +d.rating : null,
      }, { onConflict: 'paper_id,user_id' }));
      toast('Note saved', 'ok');
      reload();
    } catch (err) { fail(err, 'Save note'); }
  };
  root.querySelector('#del-note')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove your note and rating for this paper?'))) return;
    try { check(await sb.from('paper_notes').delete().eq('paper_id', id).eq('user_id', state.user.id)); reload(); } catch (err) { fail(err); }
  });

  root.querySelector('#link').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      check(await sb.from('project_papers').insert({ project_id: d.project, paper_id: id, relation: d.relation, note: d.note || null }));
      toast('Linked', 'ok');
      reload();
    } catch (err) { fail(err, 'Link'); }
  };

  root.querySelector('#bib').onclick = async () => {
    await navigator.clipboard.writeText(toBibtex([paper]));
    toast('BibTeX copied');
  };

  root.querySelector('#edit-tags').onclick = () => {
    const m = modal('Edit tags', `<form>${tagInputHtml('tags', paper.tags, tags.map((t) => t.tag))}
      <div class="row end"><button class="primary">Save</button></div></form>`);
    m.el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      try { check(await sb.from('papers').update({ tags: readTags(e.target) }).eq('id', id)); m.close(); reload(); } catch (err) { fail(err); }
    };
  };

  root.querySelector('#edit').onclick = () => editPaperModal(paper, tags.map((t) => t.tag), reload);

  root.querySelector('#del')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this paper, its notes and its project links for everyone?'))) return;
    try { check(await sb.from('papers').delete().eq('id', id)); toast('Deleted'); location.hash = '#/papers'; } catch (err) { fail(err); }
  });
}

export function paperFormHtml(p, allTagNames) {
  const f = (name, label, type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${esc(p[name] ?? '')}"></label>`;
  return `
    <label>Title<textarea name="title" rows="2" required>${esc(p.title || '')}</textarea></label>
    <label>Authors <small class="muted">“Family, Given; Family, Given”</small><textarea name="authors" rows="2">${esc(p.authors || '')}</textarea></label>
    <div class="grid-3">${f('journal', 'Journal / venue')}${f('year', 'Year', 'number')}
      <label>Type<select name="entry_type">${['article', 'inproceedings', 'incollection', 'book', 'phdthesis', 'techreport', 'misc', 'unpublished'].map((t) => `<option ${t === (p.entry_type || 'article') ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
    <div class="grid-3">${f('doi', 'DOI')}${f('pmid', 'PMID')}${f('arxiv_id', 'arXiv ID')}</div>
    <div class="grid-2">${f('url', 'URL', 'url')}${f('pdf_url', 'PDF link (e.g. shared drive)', 'url')}</div>
    <label>Abstract<textarea name="abstract" rows="6">${esc(p.abstract || '')}</textarea></label>
    <label>Tags ${tagInputHtml('tags', p.tags, allTagNames)}</label>`;
}

export function readPaperForm(form) {
  const d = formData(form);
  d.tags = readTags(form);
  if (d.doi) d.doi = d.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
  return cleanPaper(d);
}

function editPaperModal(paper, allTagNames, done) {
  const m = modal('Edit paper', `<form>${paperFormHtml(paper, allTagNames)}<div class="row end"><button class="primary">Save</button></div></form>`, { wide: true });
  m.el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      check(await sb.from('papers').update(readPaperForm(e.target)).eq('id', paper.id));
      m.close(); toast('Saved', 'ok'); done();
    } catch (err) { fail(err, 'Save'); }
  };
}

// Paper picker used by project pages
export function paperPicker(onPick, exclude = new Set()) {
  const m = modal('Link a paper from the library', `
    <input id="pp-q" placeholder="Search library…" autocomplete="off">
    <div id="pp-res" class="picker"></div>
    <p class="muted small">Not in the library? <a href="#/import">Add it first</a>.</p>`, { wide: true });
  const input = m.el.querySelector('#pp-q');
  const res = m.el.querySelector('#pp-res');
  const search = debounce(async () => {
    let query = sb.from('papers').select('id,title,authors,year').limit(20);
    const q = input.value.trim();
    query = q ? query.textSearch('search', q, { type: 'websearch', config: 'english' }) : query.order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) return fail(error);
    res.innerHTML = data.map((p) => `<div class="pick ${exclude.has(p.id) ? 'disabled' : ''}" data-id="${p.id}">
      <b>${esc(p.title)}</b><div class="meta">${esc(authorsShort(p.authors))} ${p.year || ''}${exclude.has(p.id) ? ' · already linked' : ''}</div></div>`).join('') || '<p class="muted">No matches.</p>';
    res.querySelectorAll('.pick:not(.disabled)').forEach((el) => (el.onclick = () => { m.close(); onPick(el.dataset.id); }));
  }, 250);
  input.oninput = search;
  search();
}

// ---------------------------------------------------------- related papers
async function relatedPapers(id) {
  const [out, inn] = await Promise.all([
    sb.from('paper_links').select('*').eq('source_id', id).then(check),
    sb.from('paper_links').select('*').eq('target_id', id).then(check),
  ]);
  const links = [...out, ...inn];
  if (!links.length) return [];
  const ids = [...new Set(links.map((l) => (l.source_id === id ? l.target_id : l.source_id)))];
  const papers = [];
  for (let i = 0; i < ids.length; i += 100)
    papers.push(...check(await sb.from('papers').select('id,title,authors,year,journal').in('id', ids.slice(i, i + 100))));
  const byId = new Map(papers.map((p) => [p.id, p]));
  return links.map((l) => ({ ...l, outgoing: l.source_id === id, other: byId.get(l.source_id === id ? l.target_id : l.source_id) }))
    .filter((l) => l.other);
}

function relatedHtml(rel) {
  const groups = [
    ['Cites (in library)', rel.filter((l) => l.kind === 'cites' && l.outgoing), 'Its reference list includes these papers.'],
    ['Cited by (in library)', rel.filter((l) => l.kind === 'cites' && !l.outgoing), 'These papers cite it.'],
    ['Shares references', rel.filter((l) => l.kind === 'coupled').sort((a, b) => b.score - a.score), 'Bibliographic coupling: they cite many of the same works.'],
    ['Similar wording', rel.filter((l) => l.kind === 'similar').sort((a, b) => b.score - a.score), 'Title/abstract word overlap only. Check before relying on it.'],
    ['Linked by lab members', rel.filter((l) => l.kind === 'manual'), ''],
  ].filter(([, ls]) => ls.length);
  const item = (l) => `<li><a href="#/paper/${l.other.id}">${esc(l.other.title)}</a>
    <div class="meta">${esc(authorsShort(l.other.authors))} ${l.other.year || ''}
      ${l.kind === 'coupled' ? ` · ${l.shared} shared refs (score ${l.score})` : ''}
      ${l.kind === 'similar' ? ` · similarity ${l.score}` : ''}
      ${l.kind === 'manual' ? ` · by ${esc(personName(l.created_by))}${l.note ? ': ' + esc(l.note) : ''}
        <button class="ghost small" data-unlink="${l.source_id}|${l.target_id}">unlink</button>` : ''}</div></li>`;
  return `<div class="row between"><h2>Related in library</h2><button class="small" id="add-rel">+ Link related paper</button></div>
    ${groups.length ? `<div class="grid-2">${groups.map(([title, ls, hint]) => `
      <div><h3>${title} <small class="muted">${ls.length}</small></h3>${hint ? `<p class="muted small">${hint}</p>` : ''}
        <ul class="list">${ls.slice(0, 15).map(item).join('')}</ul>${ls.length > 15 ? `<p class="muted small">…and ${ls.length - 15} more (see Graph)</p>` : ''}</div>`).join('')}</div>`
      : '<p class="muted">No links yet. Use <a href="#/import">Import → Link papers automatically</a>, or add one by hand.</p>'}`;
}
