import { sb, state, check, personName, members, allTags } from '../db.js';
import { esc, md, fmtDate, fmtDateTime, authorsShort, tagChips, toast, fail, STATUSES, RELATIONS, PROJECT_FIELDS } from '../util.js';
import { modal, confirmDialog, tagInputHtml, readTags, formData } from '../ui.js';
import { paperPicker } from './papers.js';
import { diffWords } from '../diff.js';
import { fetchAll } from '../db.js';
import { suggestPapers } from '../suggest.js';
import { techForProject } from './products.js';

// ================================================================== board
export async function projectsView(root, { params }) {
  const showArchived = params.archived === '1';
  const [projects, links] = await Promise.all([
    sb.from('projects').select('id,title,status,summary,tags,owner_id,collaborators,updated_at,version').order('updated_at', { ascending: false }).then(check),
    sb.from('project_papers').select('project_id').then(check),
  ]);
  const nPapers = links.reduce((m, l) => m.set(l.project_id, (m.get(l.project_id) || 0) + 1), new Map());
  const cols = STATUSES.filter((s) => showArchived || s !== 'archived');

  root.innerHTML = `
    <div class="page-head">
      <h1>Projects & ideas</h1>
      <div class="row">
        <a class="button ghost" href="#/projects${showArchived ? '' : '?archived=1'}">${showArchived ? 'Hide' : 'Show'} archived</a>
        <button class="primary" id="new">+ New idea</button>
      </div>
    </div>
    <p class="muted small">Drag cards between columns to change status. Every edit is versioned.</p>
    <div class="board">
      ${cols.map((s) => `
        <div class="col" data-status="${s}">
          <h3><span class="status s-${s}">${s}</span> <small>${projects.filter((p) => p.status === s).length}</small></h3>
          ${projects.filter((p) => p.status === s).map((p) => `
            <div class="pcard" draggable="true" data-id="${p.id}">
              <a href="#/project/${p.id}" class="title">${esc(p.title)}</a>
              ${p.summary ? `<p class="clamp">${esc(p.summary.slice(0, 220))}</p>` : ''}
              <div>${tagChips(p.tags, '#/graph?focus=tag:')}</div>
              <div class="meta">${esc(personName(p.owner_id))}${p.collaborators?.length ? ` +${p.collaborators.length}` : ''}
                · 📄 ${nPapers.get(p.id) || 0} · v${p.version} · ${fmtDate(p.updated_at)}</div>
            </div>`).join('')}
        </div>`).join('')}
    </div>`;

  root.querySelector('#new').onclick = () => newProjectModal();

  let dragId = null;
  root.querySelectorAll('.pcard').forEach((c) => {
    c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  });
  root.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault(); col.classList.remove('over');
      const p = projects.find((x) => x.id === dragId);
      const status = col.dataset.status;
      if (!p || p.status === status) return;
      try {
        check(await sb.from('projects').update({ status, last_change_note: `Status: ${p.status} → ${status}` }).eq('id', p.id));
        projectsView(root, { params });
      } catch (err) { fail(err, 'Move'); }
    });
  });
}

async function newProjectModal() {
  const tags = (await allTags()).map((t) => t.tag);
  const m = modal('New project idea', `<form>
    <label>Title<input name="title" required placeholder="Short, specific working title"></label>
    <label>Summary<textarea name="summary" rows="4" placeholder="What is the idea, in a paragraph?"></textarea></label>
    <label>Hypothesis<textarea name="hypothesis" rows="3"></textarea></label>
    <label>Tags ${tagInputHtml('tags', [], tags)}</label>
    <div class="row end"><button class="primary">Create</button></div></form>`, { wide: true });
  m.el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      const row = check(await sb.from('projects').insert({ title: d.title.trim(), summary: d.summary, hypothesis: d.hypothesis, tags: readTags(e.target) }).select('id').single());
      m.close();
      location.hash = `#/project/${row.id}?tab=papers`;   // land on suggestions
    } catch (err) { fail(err, 'Create'); }
  };
}

// ================================================================= detail
export async function projectView(root, { id, params }) {
  const tab = params.tab || 'overview';
  const [p, links, updates, versions, tech] = await Promise.all([
    sb.from('projects').select('*').eq('id', id).maybeSingle().then(check),
    sb.from('project_papers').select('relation,note,created_at,added_by,paper:papers(id,title,authors,year,journal,tags)').eq('project_id', id).order('created_at').then(check),
    sb.from('project_updates').select('*').eq('project_id', id).order('created_at', { ascending: false }).then(check),
    sb.from('project_versions').select('id,version,change_note,edited_by,created_at').eq('project_id', id).order('version', { ascending: false }).then(check),
    techForProject(id).catch(() => []),
  ]);
  if (!p) { root.innerHTML = '<div class="card">Project not found. <a href="#/projects">Back</a></div>'; return; }
  const reload = (t = tab) => { const h = `#/project/${id}?tab=${t}`; if (location.hash === h) projectView(root, { id, params: { tab: t } }); else location.hash = h; };
  const canDelete = state.profile.role === 'admin' || p.owner_id === state.user.id;

  const tabs = [['overview', 'Overview'], ['papers', `Papers (${links.length})`], ['timeline', `Timeline (${updates.length})`], ['history', `History (v${p.version})`]];
  root.innerHTML = `
    <div class="crumbs"><a href="#/projects">Projects</a> /</div>
    <div class="card project-head">
      <div class="row between">
        <h1>${esc(p.title)}</h1>
        <select id="status" class="status-select s-${p.status}">${STATUSES.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div class="meta">Lead: <b>${esc(personName(p.owner_id))}</b>
        ${p.collaborators?.length ? ` · with ${p.collaborators.map((c) => esc(personName(c))).join(', ')}` : ''}
        · created ${fmtDate(p.created_at)} · last edit ${fmtDateTime(p.updated_at)} by ${esc(personName(p.last_edited_by))}</div>
      <div class="tagline">${tagChips(p.tags, '#/graph?focus=tag:')}</div>
      ${tech.length ? `<p class="small">Technologies: ${tech.map((t) => `<a href="#/tech/${t.id}">${esc(t.name)}</a>`).join(', ')}</p>` : ''}
      <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/project/${id}?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}
        <a href="#/graph?focus=project:${id}">Graph ↗</a></nav>
    </div>
    <div id="tab"></div>`;

  root.querySelector('#status').onchange = async (e) => {
    try { check(await sb.from('projects').update({ status: e.target.value, last_change_note: `Status: ${p.status} → ${e.target.value}` }).eq('id', id)); toast('Status updated', 'ok'); reload(); }
    catch (err) { fail(err); }
  };

  const el = root.querySelector('#tab');
  if (tab === 'overview') overviewTab(el, p, reload, canDelete);
  else if (tab === 'papers') papersTab(el, p, links, reload);
  else if (tab === 'timeline') timelineTab(el, p, updates, versions, reload);
  else if (tab === 'history') historyTab(el, p, versions);
}

function overviewTab(el, p, reload, canDelete) {
  el.innerHTML = `
    <div class="card">
      <div class="row end"><button class="primary" id="edit">✎ Edit</button>${canDelete ? '<button class="danger ghost" id="del">Delete</button>' : ''}</div>
      ${PROJECT_FIELDS.map(([k, label]) => `
        <section class="pfield"><h3>${label}</h3>${p[k] ? `<div class="md">${md(p[k])}</div>` : '<p class="muted">—</p>'}</section>`).join('')}
    </div>`;
  el.querySelector('#edit').onclick = () => editProjectModal(p, reload);
  el.querySelector('#del')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete “${p.title}” including its full history? Consider setting status to “archived” instead.`))) return;
    try { check(await sb.from('projects').delete().eq('id', p.id)); location.hash = '#/projects'; } catch (err) { fail(err); }
  });
}

async function editProjectModal(p, reload) {
  const tags = (await allTags()).map((t) => t.tag);
  const people = members();
  const m = modal(`Edit — ${p.title}`, `<form>
    <label>Title<input name="title" value="${esc(p.title)}" required></label>
    ${PROJECT_FIELDS.map(([k, label, hint]) => `<label>${label} <small class="muted">${hint}</small>
      <textarea name="${k}" rows="${k === 'summary' ? 4 : 5}">${esc(p[k])}</textarea></label>`).join('')}
    <label>Tags ${tagInputHtml('tags', p.tags, tags)}</label>
    <div class="grid-2">
      <label>Lead<select name="owner_id">${people.map((u) => `<option value="${u.id}" ${u.id === p.owner_id ? 'selected' : ''}>${esc(u.full_name || u.email)}</option>`).join('')}</select></label>
      <label>Collaborators<select name="collaborators" multiple size="4">${people.map((u) => `<option value="${u.id}" ${p.collaborators?.includes(u.id) ? 'selected' : ''}>${esc(u.full_name || u.email)}</option>`).join('')}</select></label>
    </div>
    <label>What changed and why? <small class="muted">(saved in the history)</small>
      <input name="change_note" placeholder="e.g. Narrowed hypothesis after pilot RNA-seq; dropped Aim 3"></label>
    <div class="row end"><button class="primary">Save new version</button></div></form>`, { wide: true });
  const form = m.el.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    const upd = { title: d.title.trim(), tags: readTags(form), owner_id: d.owner_id || null,
      collaborators: [...form.elements.collaborators.selectedOptions].map((o) => o.value),
      last_change_note: d.change_note.trim() || null };
    for (const [k] of PROJECT_FIELDS) upd[k] = d[k];
    try {
      // optimistic concurrency: only update if nobody saved in the meantime
      const rows = check(await sb.from('projects').update(upd).eq('id', p.id).eq('version', p.version).select('version'));
      if (!rows.length) {
        toast('Someone else saved this project while you were editing. Copy your text, reload, and re-apply.', 'error', 10000);
        return;
      }
      m.close(); toast(`Saved as v${rows[0].version}`, 'ok'); reload('overview');
    } catch (err) { fail(err, 'Save'); }
  };
}

function papersTab(el, p, links, reload) {
  const by = RELATIONS.map((r) => [r, links.filter((l) => l.relation === r && l.paper)]).filter(([, l]) => l.length);
  el.innerHTML = `
    <div class="card">
      <div class="row between"><p class="muted">Literature supporting, contradicting or enabling this project.</p>
        <div class="row"><a class="button" href="#/import?project=${p.id}" title="Import a Zotero/BibTeX/RIS file and link every paper in it to this project">Import file into project</a>
        <button class="primary" id="add">+ Link paper</button></div></div>
      ${by.length ? by.map(([rel, ls]) => `
        <h3><span class="rel rel-${rel}">${rel}</span> <small>${ls.length}</small></h3>
        <ul class="list">${ls.map((l) => `
          <li data-pid="${l.paper.id}">
            <a href="#/paper/${l.paper.id}">${esc(l.paper.title)}</a>
            <div class="meta">${esc(authorsShort(l.paper.authors))} ${l.paper.year || ''} ${l.paper.journal ? '· <i>' + esc(l.paper.journal) + '</i>' : ''}</div>
            ${l.note ? `<div class="linknote">${esc(l.note)}</div>` : ''}
            <div class="row small">
              <select class="rel-sel">${RELATIONS.map((r) => `<option ${r === l.relation ? 'selected' : ''}>${r}</option>`).join('')}</select>
              <button class="ghost small note-btn">✎ note</button>
              <button class="ghost small unlink">unlink</button>
            </div>
          </li>`).join('')}</ul>`).join('') : '<p class="muted">No papers linked yet. See the suggestions below.</p>'}
    </div>
    <section class="card" id="suggest"><div class="loading">Finding related papers in the library…</div></section>`;
  renderSuggestions(el.querySelector('#suggest'), p, links, reload);

  el.querySelector('#add').onclick = () => paperPicker(async (paperId) => {
    const m = modal('How does this paper relate?', `<form>
      <label>Relation<select name="relation">${RELATIONS.map((r) => `<option>${r}</option>`).join('')}</select></label>
      <label>Note<input name="note" placeholder="e.g. shows the same effect in PDAC organoids"></label>
      <div class="row end"><button class="primary">Link</button></div></form>`);
    m.el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      try { check(await sb.from('project_papers').insert({ project_id: p.id, paper_id: paperId, relation: d.relation, note: d.note || null })); m.close(); reload('papers'); }
      catch (err) { fail(err, 'Link'); }
    };
  }, new Set(links.map((l) => l.paper?.id)));

  const upd = (pid, patch) => sb.from('project_papers').update(patch).eq('project_id', p.id).eq('paper_id', pid).then(check);
  el.querySelectorAll('li[data-pid]').forEach((li) => {
    const pid = li.dataset.pid;
    li.querySelector('.rel-sel').onchange = async (e) => { try { await upd(pid, { relation: e.target.value }); reload('papers'); } catch (err) { fail(err); } };
    li.querySelector('.note-btn').onclick = async () => {
      const cur = links.find((l) => l.paper?.id === pid)?.note || '';
      const m = modal('Link note', `<form><textarea name="note" rows="3">${esc(cur)}</textarea><div class="row end"><button class="primary">Save</button></div></form>`);
      m.el.querySelector('form').onsubmit = async (e) => { e.preventDefault(); try { await upd(pid, { note: e.target.note.value || null }); m.close(); reload('papers'); } catch (err) { fail(err); } };
    };
    li.querySelector('.unlink').onclick = async () => {
      try { check(await sb.from('project_papers').delete().eq('project_id', p.id).eq('paper_id', pid)); reload('papers'); } catch (err) { fail(err); }
    };
  });
}

function timelineTab(el, p, updates, versions, reload) {
  const items = [
    ...updates.map((u) => ({ t: u.created_at, kind: 'update', u })),
    ...versions.map((v) => ({ t: v.created_at, kind: 'version', v })),
  ].sort((a, b) => new Date(b.t) - new Date(a.t));
  el.innerHTML = `
    <div class="card">
      <form id="post">
        <textarea name="body" rows="4" required placeholder="Log a result, discussion, decision or new angle… (Markdown supported)"></textarea>
        <div class="row end"><button class="primary">Post update</button></div>
      </form>
      <ol class="timeline">
        ${items.map((it) => it.kind === 'update' ? `
          <li class="t-update" data-id="${it.u.id}">
            <div class="meta"><b>${esc(personName(it.u.author_id))}</b> · ${fmtDateTime(it.u.created_at)}
              ${it.u.author_id === state.user.id ? '<button class="ghost small del-up">delete</button>' : ''}</div>
            <div class="md">${md(it.u.body)}</div>
          </li>` : `
          <li class="t-version">
            <div class="meta">✎ <a href="#/project/${p.id}?tab=history&v=${it.v.version}">v${it.v.version}</a> by ${esc(personName(it.v.edited_by))} · ${fmtDateTime(it.v.created_at)}</div>
            ${it.v.change_note ? `<div>${esc(it.v.change_note)}</div>` : ''}
          </li>`).join('')}
      </ol>
    </div>`;
  el.querySelector('#post').onsubmit = async (e) => {
    e.preventDefault();
    try { check(await sb.from('project_updates').insert({ project_id: p.id, body: e.target.body.value, author_id: state.user.id })); reload('timeline'); }
    catch (err) { fail(err, 'Post'); }
  };
  el.querySelectorAll('.del-up').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('Delete this update?'))) return;
    try { check(await sb.from('project_updates').delete().eq('id', b.closest('li').dataset.id)); reload('timeline'); } catch (err) { fail(err); }
  }));
}

async function historyTab(el, p, versions) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const vNew = parseInt(params.get('v') || p.version, 10);
  const vOld = parseInt(params.get('from') || Math.max(1, vNew - 1), 10);
  el.innerHTML = `
    <div class="card history">
      <div class="row wrap">
        Compare <select id="from">${versions.map((v) => `<option value="${v.version}" ${v.version === vOld ? 'selected' : ''}>v${v.version}</option>`).join('')}</select>
        → <select id="to">${versions.map((v) => `<option value="${v.version}" ${v.version === vNew ? 'selected' : ''}>v${v.version}</option>`).join('')}</select>
        <span class="muted small"><ins>added</ins> <del>removed</del></span>
      </div>
      <div class="hist-grid">
        <ol class="versions">${versions.map((v) => `
          <li class="${v.version === vNew ? 'active' : ''}"><a href="#/project/${p.id}?tab=history&v=${v.version}">v${v.version}</a>
            <span class="meta">${esc(personName(v.edited_by))} · ${fmtDate(v.created_at)}</span>
            ${v.change_note ? `<div class="small">${esc(v.change_note)}</div>` : ''}</li>`).join('')}</ol>
        <div id="diff"><div class="loading">Loading…</div></div>
      </div>
    </div>`;
  const nav = () => { location.hash = `#/project/${p.id}?tab=history&v=${el.querySelector('#to').value}&from=${el.querySelector('#from').value}`; };
  el.querySelector('#from').onchange = el.querySelector('#to').onchange = nav;

  const snaps = check(await sb.from('project_versions').select('version,snapshot').eq('project_id', p.id).in('version', [vOld, vNew]));
  const a = snaps.find((s) => s.version === vOld)?.snapshot || {};
  const b = snaps.find((s) => s.version === vNew)?.snapshot || {};
  const fields = [['title', 'Title'], ['status', 'Status'], ...PROJECT_FIELDS.map(([k, l]) => [k, l])];
  const tagStr = (s) => (s.tags || []).join(', ');
  const rows = [...fields.map(([k, l]) => [l, a[k] ?? '', b[k] ?? '']), ['Tags', tagStr(a), tagStr(b)],
    ['Lead', personName(a.owner_id), personName(b.owner_id)],
    ['Collaborators', (a.collaborators || []).map(personName).join(', '), (b.collaborators || []).map(personName).join(', ')]];
  el.querySelector('#diff').innerHTML = rows.map(([label, x, y]) => `
    <section class="pfield ${x === y ? 'same' : 'changed'}"><h3>${esc(label)} ${x === y ? '<small class="muted">unchanged</small>' : ''}</h3>
      <div class="diff">${x === y ? esc(y) || '<span class="muted">—</span>' : diffWords(x, y)}</div></section>`).join('');
}

// ---------------------------------------------------------- suggestions
const dismissKey = (pid) => `portal:dismissed:${pid}`;
function loadDismissed(pid) { try { return new Set(JSON.parse(localStorage.getItem(dismissKey(pid)) || '[]')); } catch { return new Set(); } }
function saveDismissed(pid, set) { try { localStorage.setItem(dismissKey(pid), JSON.stringify([...set])); } catch { /* private mode */ } }

async function renderSuggestions(box, p, links, reload) {
  try {
    const linkedIds = new Set(links.map((l) => l.paper?.id).filter(Boolean));
    const ids = [...linkedIds];
    const [papers, out, inn] = await Promise.all([
      fetchAll('papers', 'id,title,authors,year,journal,abstract,tags,topics:oa_meta->topics,keywords:oa_meta->keywords,mesh:oa_meta->mesh'),
      ids.length ? sb.from('paper_links').select('source_id,target_id,kind').in('source_id', ids).then(check) : [],
      ids.length ? sb.from('paper_links').select('source_id,target_id,kind').in('target_id', ids).then(check) : [],
    ]);
    const dismissed = loadDismissed(p.id);
    const sugg = suggestPapers(p, papers, { linkedIds, paperLinks: [...out, ...inn], dismissed, top: 15 });
    const hasText = PROJECT_FIELDS.some(([k]) => (p[k] || '').trim()) || p.tags?.length;
    box.innerHTML = `
      <div class="row between"><h2>Suggested papers from the library</h2>
        ${dismissed.size ? `<button class="ghost small" id="undismiss">Show ${dismissed.size} dismissed</button>` : ''}</div>
      <p class="muted small">Ranked by three signals, with the reasons listed for each paper: word overlap between this project's text and the paper's title and abstract;
        the project's tags found in the paper's tags, OpenAlex topics, keywords or MeSH terms; and citation or shared-reference links to papers already linked here.
        Suggestions improve as you add text, tags and linked papers. Text matching is lexical, so check each suggestion before linking it.</p>
      ${!hasText ? '<p class="notice small">Add a summary, hypothesis or tags (Overview → Edit) to get text-based suggestions.</p>' : ''}
      ${sugg.length ? `<ul class="list sugg">${sugg.map((x, i) => `
        <li data-i="${i}">
          <div class="row between wrap">
            <div style="flex:1;min-width:260px"><a href="#/paper/${x.paper.id}">${esc(x.paper.title)}</a>
              <div class="meta">${esc(authorsShort(x.paper.authors))} ${x.paper.year || ''} ${x.paper.journal ? '· <i>' + esc(x.paper.journal) + '</i>' : ''}</div>
              <div class="small reasons">${x.reasons.map((r) => `<span>${esc(r)}</span>`).join('')}</div></div>
            <div class="row">
              <span class="score" title="text ${x.parts.text} · tag hits ${x.parts.tags} · network links ${x.parts.network}">${x.score.toFixed(2)}</span>
              <select class="rel-pick">${RELATIONS.map((r) => `<option>${r}</option>`).join('')}</select>
              <button class="small primary link">Link</button>
              <button class="small ghost dismiss" title="Hide this suggestion (only for you, on this browser)">✕</button>
            </div>
          </div>
        </li>`).join('')}</ul>` : '<p class="muted">No suggestions yet: no library paper matches this project’s text, tags or linked papers.</p>'}`;
    box.querySelector('#undismiss')?.addEventListener('click', () => { saveDismissed(p.id, new Set()); renderSuggestions(box, p, links, reload); });
    box.querySelectorAll('li[data-i]').forEach((li) => {
      const x = sugg[+li.dataset.i];
      li.querySelector('.link').onclick = async (e) => {
        e.target.disabled = true;
        try {
          check(await sb.from('project_papers').insert({ project_id: p.id, paper_id: x.paper.id, relation: li.querySelector('.rel-pick').value,
            note: `Suggested (${x.reasons[0] || 'score ' + x.score})`.slice(0, 300) }));
          toast('Linked', 'ok');
          reload('papers');
        } catch (err) { fail(err, 'Link'); e.target.disabled = false; }
      };
      li.querySelector('.dismiss').onclick = () => { dismissed.add(x.paper.id); saveDismissed(p.id, dismissed); li.remove(); };
    });
  } catch (err) { box.innerHTML = `<p class="error">Suggestions failed: ${esc(err.message || err)}</p>`; }
}
