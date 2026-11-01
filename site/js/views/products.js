// Technologies: commercial products / platforms the lab uses or follows.
// Literature is checked from the browser (Europe PMC allows it) and by the daily
// GitHub Actions job, which also watches product pages and vendor news feeds.
import { sb, state, check, personName, cleanPaper, findExisting, allTags } from '../db.js';
import { esc, md, fmtDate, toast, fail, parseTags, tagChips } from '../util.js';
import { modal, confirmDialog, tagInputHtml, readTags, formData } from '../ui.js';
import { lookup } from '../metadata.js';
import { buildQuery, epmcUrl, epmcToEvent } from '../products-lib.js';

const CATEGORIES = ['Spatial transcriptomics', 'Spatial proteomics', 'Single-cell sequencing', 'Sequencing platform', 'Imaging / microscopy',
  'Mass spectrometry / proteomics', 'Flow / mass cytometry', 'Genome editing', 'Assay / reagent kit', 'Organoid / cell model', 'Software / analysis', 'Other'];
const KIND_LABEL = { paper: 'Paper', page_change: 'Product page', news: 'Vendor news', note: 'Lab note' };

const seenKey = 'portal:techSeen';
function seen() { try { return JSON.parse(localStorage.getItem(seenKey) || '{}'); } catch { return {}; } }
function markSeen(id) { try { const s = seen(); s[id] = new Date().toISOString(); localStorage.setItem(seenKey, JSON.stringify(s)); } catch { /* ignore */ } }

// ================================================================== list
export async function productsView(root, { params }) {
  const kind = params.kind || '';
  const [products, links, events] = await Promise.all([
    sb.from('products').select('id,name,vendor,category,url,tags,last_checked_at,last_lit_check,check_error,created_at').order('name').then(check),
    sb.from('product_projects').select('product_id,project_id').then(check),
    (kind ? sb.from('product_events').select('*').eq('kind', kind) : sb.from('product_events').select('*'))
      .order('created_at', { ascending: false }).limit(60).then(check),
  ]);
  const nProj = links.reduce((m, l) => m.set(l.product_id, (m.get(l.product_id) || 0) + 1), new Map());
  const byId = new Map(products.map((p) => [p.id, p]));
  const s = seen();
  const { data: counts } = await sb.from('product_events').select('product_id,created_at,kind').gte('created_at', new Date(Date.now() - 365 * 864e5).toISOString());
  const fresh = new Map();
  for (const e of counts || []) if (!s[e.product_id] || e.created_at > s[e.product_id]) fresh.set(e.product_id, (fresh.get(e.product_id) || 0) + 1);

  root.innerHTML = `
    <div class="page-head"><h1>Technologies</h1><button class="primary" id="add">+ Add technology</button></div>
    <p class="muted small">Commercial platforms, kits and software the lab uses or watches. Each one is tracked for new papers mentioning it
      (Europe PMC full text) and, by the daily job, for changes on its product page and vendor news.</p>
    ${products.length ? `<div class="tech-grid">${products.map((p) => `
      <a class="tech-card" href="#/tech/${p.id}">
        <div class="row between"><b>${esc(p.name)}</b>${fresh.get(p.id) ? `<span class="pill new">${fresh.get(p.id)} new</span>` : ''}</div>
        <div class="meta">${esc([p.vendor, p.category].filter(Boolean).join(' · ') || '—')}</div>
        <div>${(p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</div>
        <div class="meta">${nProj.get(p.id) ? `${nProj.get(p.id)} project${nProj.get(p.id) > 1 ? 's' : ''} · ` : ''}
          ${p.check_error ? '<span class="error">page check failed</span>' : p.last_checked_at ? `checked ${fmtDate(p.last_checked_at)}` : p.url ? 'page not checked yet' : 'no product page'}</div>
      </a>`).join('')}</div>` : '<div class="card muted">No technologies yet. Add one with its name or product-page link.</div>'}
    <section class="card">
      <div class="row between wrap"><h2>Latest updates</h2>
        <div class="row">${[['', 'All'], ['paper', 'Papers'], ['page_change', 'Product pages'], ['news', 'Vendor news'], ['note', 'Lab notes']]
          .map(([k, l]) => `<a class="button small ${k === kind ? 'primary' : ''}" href="#/tech${k ? '?kind=' + k : ''}">${l}</a>`).join('')}</div></div>
      ${eventList(events, { products: byId, showProduct: true })}
    </section>`;
  root.querySelector('#add').onclick = () => productModal(null);
  bindEventActions(root, events, byId);
}

// ================================================================ detail
export async function productView(root, { id }) {
  const [p, links, projects, events] = await Promise.all([
    sb.from('products').select('*').eq('id', id).maybeSingle().then(check),
    sb.from('product_projects').select('project_id').eq('product_id', id).then(check),
    sb.from('projects').select('id,title,status').order('title').then(check),
    sb.from('product_events').select('*').eq('product_id', id).order('event_date', { ascending: false, nullsFirst: false }).limit(300).then(check),
  ]);
  if (!p) { root.innerHTML = '<div class="card">Not found. <a href="#/tech">Back</a></div>'; return; }
  const linked = new Set(links.map((l) => l.project_id));
  const lastSeen = seen()[id];
  markSeen(id);
  const query = buildQuery(p);
  const papers = events.filter((e) => e.kind === 'paper');
  const updates = events.filter((e) => e.kind !== 'paper');
  const canDelete = state.profile.role === 'admin' || p.created_by === state.user.id;

  root.innerHTML = `
    <div class="crumbs"><a href="#/tech">Technologies</a> /</div>
    <div class="card">
      <div class="row between wrap"><div><h1 style="margin:0">${esc(p.name)}</h1>
        <div class="meta">${esc([p.vendor, p.category].filter(Boolean).join(' · '))}</div></div>
        <div class="row"><button id="edit">Edit</button>${canDelete ? '<button class="ghost danger" id="del">Delete</button>' : ''}</div></div>
      <div class="links" style="margin-top:8px">
        ${p.url ? `<a target="_blank" rel="noopener" href="${esc(p.url)}">Product page ↗</a>` : ''}
        ${p.feed_url ? `<a target="_blank" rel="noopener" href="${esc(p.feed_url)}">News feed ↗</a>` : ''}
        <a target="_blank" rel="noopener" href="https://europepmc.org/search?query=${encodeURIComponent(query)}">Search Europe PMC ↗</a>
      </div>
      <div class="tagline">${tagChips(p.tags)}</div>
      <p class="small"><b>Projects:</b> ${linked.size ? projects.filter((x) => linked.has(x.id)).map((x) => `<a href="#/project/${x.id}">${esc(x.title)}</a>`).join(', ') : '<span class="muted">none</span>'}</p>
      <p class="small muted">Literature query: <code>${esc(query)}</code>
        ${p.aliases?.length ? '' : '· Tip: add other names (e.g. older product names) under Edit → Aliases.'}</p>
      <p class="small muted">Tracking: literature ${p.last_lit_check ? `checked ${fmtDate(p.last_lit_check)}` : 'not yet checked'} ·
        ${p.url ? (p.check_error ? `<span class="error">product page check failed: ${esc(p.check_error)}</span>` : p.last_checked_at ? `product page checked ${fmtDate(p.last_checked_at)}` : 'product page waits for the daily job') : 'no product page to watch'}</p>
      ${p.notes ? `<div class="md">${md(p.notes)}</div>` : ''}
    </div>

    <section class="card">
      <h2>Papers mentioning ${esc(p.name)} per year</h2>
      <p class="muted small">Number of records in Europe PMC matching the query, by publication year. Europe PMC searches the full text of open-access papers and
        the abstracts of the rest, so the counts include papers that only cite or mention the product, and part of the rise reflects growth of open-access full text.</p>
      <div id="trend"><div class="loading">Counting…</div></div>
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="row between"><h2>Recent papers</h2><button class="small" id="check">Check now</button></div>
        <p class="muted small">Newly published papers matching the query, collected by “Check now” and the daily job. <b>New</b> = arrived since your last visit.</p>
        <div id="ev-papers">${eventList(papers.slice(0, 60), { lastSeen })}</div>
      </section>
      <section class="card">
        <h2>Most-cited papers using it</h2>
        <p class="muted small">Matching papers published since <select id="cited-since">${[1, 2, 3, 5].map((y) => `<option value="${y}" ${y === 2 ? 'selected' : ''}>${new Date().getFullYear() - y + 1}</option>`).join('')}</select>,
          ranked by citations in Europe PMC. Usually the major studies and method papers.</p>
        <div id="cited"><div class="loading">Loading…</div></div>
      </section>
    </div>

    <section class="card">
      <div class="row between"><h2>Technical updates & notes</h2><button class="small" id="note">+ Add note</button></div>
      <p class="muted small">Product-page changes (the daily job lists the sentences that appeared on the page), vendor news-feed items, and notes from lab members
        such as protocol tips, price quotes or vendor-rep updates.</p>
      <div id="ev-updates">${eventList(updates, { lastSeen })}</div>
    </section>`;

  root.querySelector('#edit').onclick = () => productModal(p, linked);
  root.querySelector('#del')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete ${p.name} and its tracked updates?`))) return;
    try { check(await sb.from('products').delete().eq('id', id)); location.hash = '#/tech'; } catch (err) { fail(err); }
  });
  root.querySelector('#check').onclick = async (e) => {
    e.target.disabled = true;
    try { const n = await checkLiterature(p); toast(`${n} new papers`, 'ok'); productView(root, { id }); }
    catch (err) { fail(err, 'Europe PMC'); e.target.disabled = false; }
  };
  root.querySelector('#note').onclick = () => {
    const m = modal(`Note on ${p.name}`, `<form>
      <label>Title<input name="title" required placeholder="e.g. v2 chemistry: 30% higher sensitivity in our hands"></label>
      <label>Details<textarea name="body" rows="5" placeholder="Markdown supported"></textarea></label>
      <label>Link (optional)<input name="url" type="url"></label>
      <div class="row end"><button class="primary">Save</button></div></form>`);
    m.el.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const d = formData(ev.target);
      try {
        check(await sb.from('product_events').insert({ product_id: id, kind: 'note', title: d.title.trim(), url: d.url || null,
          event_date: new Date().toISOString().slice(0, 10), external_id: `note:${crypto.randomUUID()}`, payload: { body: d.body } }));
        m.close(); productView(root, { id });
      } catch (err) { fail(err); }
    };
  };
  const pmap = new Map([[p.id, p]]), rerender = () => productView(root, { id });
  bindEventActions(root.querySelector('#ev-papers'), papers.slice(0, 60), pmap, rerender);
  bindEventActions(root.querySelector('#ev-updates'), updates, pmap, rerender);

  // auto-check literature on first visit
  if (!p.last_lit_check && query) checkLiterature(p).then((n) => { if (n) productView(root, { id }); }).catch(() => {});
  yearTrend(root.querySelector('#trend'), query);
  const loadCited = () => mostCited(root.querySelector('#cited'), query, +root.querySelector('#cited-since').value, p);
  root.querySelector('#cited-since').onchange = loadCited;
  loadCited();
}

// ------------------------------------------------------------ events
function eventList(events, { products = null, showProduct = false, lastSeen = null } = {}) {
  if (!events.length) return '<p class="muted">Nothing yet.</p>';
  return `<ul class="list events">${events.map((e, i) => {
    const pr = products?.get(e.product_id);
    const isNew = lastSeen && e.created_at > lastSeen;
    const pl = e.payload || {};
    return `<li data-ev="${i}">
      <div class="row between wrap">
        <div style="flex:1;min-width:240px">
          <span class="kind k-${e.kind}">${KIND_LABEL[e.kind]}</span>${isNew ? ' <span class="pill new">new</span>' : ''}
          ${showProduct && pr ? ` <a class="small" href="#/tech/${pr.id}"><b>${esc(pr.name)}</b></a> ·` : ''}
          ${e.url ? `<a target="_blank" rel="noopener" href="${esc(e.url)}">${esc(e.title)}</a>` : esc(e.title)}
          <div class="meta">${e.event_date ? fmtDate(e.event_date) : fmtDate(e.created_at)}
            ${e.kind === 'paper' ? ` · ${esc(shortAuthors(pl.authors))}${pl.journal ? ` · <i>${esc(pl.journal)}</i>` : ''}${pl.preprint ? ' · <b>preprint</b>' : ''} · cited ${pl.cited_by ?? 0}` : ''}
            ${e.kind === 'note' ? ` · ${esc(personName(e.created_by))}` : ''}</div>
          ${e.kind === 'page_change' && pl.added?.length ? `<details><summary class="small">What appeared on the page (${pl.added_count})</summary>
            <ul class="small">${pl.added.map((a) => `<li><ins>${esc(a)}</ins></li>`).join('')}</ul>
            ${pl.removed_count ? `<p class="small muted">${pl.removed_count} passages were removed.</p>` : ''}</details>` : ''}
          ${e.kind === 'news' && pl.summary ? `<div class="small muted clamp">${esc(pl.summary)}</div>` : ''}
          ${e.kind === 'note' && pl.body ? `<div class="md small">${md(pl.body)}</div>` : ''}
        </div>
        <div class="row">
          ${e.kind === 'paper' && (pl.doi || pl.pmid) ? '<button class="small ev-add">Add to library</button>' : ''}
          ${e.kind === 'note' && e.created_by === state.user.id ? '<button class="small ghost ev-del">delete</button>' : ''}
        </div>
      </div></li>`;
  }).join('')}</ul>`;
}

function bindEventActions(root, events, products, reload = null) {
  root.querySelectorAll('li[data-ev]').forEach((li) => {
    const e = events[+li.dataset.ev];
    li.querySelector('.ev-add')?.addEventListener('click', async (ev) => {
      const b = ev.target; b.disabled = true; b.textContent = 'Adding…';
      try {
        const pl = e.payload || {};
        let rec;
        try { rec = await lookup(pl.doi || `PMID:${pl.pmid}`); } catch { rec = { title: e.title, doi: pl.doi, pmid: pl.pmid, journal: pl.journal, year: pl.year, authors: (pl.authors || '').replace(/\.$/, '').split(', ').join('; ') }; }
        const pname = products.get(e.product_id)?.name;
        const paper = cleanPaper({ ...rec, tags: [...new Set([...(rec.tags || []), ...(pname ? [pname.toLowerCase()] : [])])] });
        const ex = await findExisting(paper);
        if (ex) { b.textContent = 'In library'; b.onclick = () => (location.hash = `#/paper/${ex.id}`); b.disabled = false; return; }
        const row = check(await sb.from('papers').insert(paper).select('id').single());
        b.textContent = '✓ Added'; toast('Added to library', 'ok');
        b.onclick = () => (location.hash = `#/paper/${row.id}`); b.disabled = false;
      } catch (err) { fail(err, 'Add'); b.disabled = false; b.textContent = 'Add to library'; }
    });
    li.querySelector('.ev-del')?.addEventListener('click', async () => {
      try { check(await sb.from('product_events').delete().eq('id', e.id)); reload ? reload() : li.remove(); } catch (err) { fail(err); }
    });
  });
}

const shortAuthors = (s) => { const a = String(s || '').replace(/\.$/, '').split(', '); return a.length > 3 ? `${a.slice(0, 3).join(', ')} et al.` : a.join(', '); };

// ------------------------------------------------------------ literature
export async function checkLiterature(p) {
  const query = buildQuery(p);
  if (!query) return 0;
  const since = p.last_lit_check ? new Date(new Date(p.last_lit_check) - 7 * 864e5) : new Date(Date.now() - 180 * 864e5);
  const j = await (await fetch(epmcUrl(query, { from: since.toISOString().slice(0, 10), pageSize: 100 }))).json();
  const rows = (j.resultList?.result || []).map((r) => ({ ...epmcToEvent(r), product_id: p.id }));
  let added = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const res = check(await sb.from('product_events').upsert(rows.slice(i, i + 100), { onConflict: 'product_id,external_id', ignoreDuplicates: true }).select('id'));
    added += res?.length || 0;
  }
  check(await sb.from('products').update({ last_lit_check: new Date().toISOString() }).eq('id', p.id));
  return added;
}

async function yearTrend(box, query) {
  if (!query) { box.innerHTML = '<p class="muted">No query.</p>'; return; }
  const y1 = new Date().getFullYear(), years = Array.from({ length: 10 }, (_, i) => y1 - 9 + i);
  try {
    const counts = await Promise.all(years.map((y) => fetch(epmcUrl(query, { year: y, pageSize: 1 })).then((r) => r.json()).then((j) => j.hitCount || 0)));
    const max = Math.max(1, ...counts);
    const W = 640, H = 180, l = 40, b = 24, t = 10, bw = (W - l - 10) / years.length;
    const Y = (v) => t + (H - t - b) * (1 - v / max);
    const ticks = [0, Math.round(max / 2), max];
    box.innerHTML = `<div class="hm-wrap"><svg class="barchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      ${ticks.map((v) => `<line class="grid" x1="${l}" x2="${W - 10}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      ${counts.map((c, i) => {
        const x = l + i * bw + 3, h = Math.max(c ? 2 : 0, H - b - Y(c));
        return `<path class="bar" data-i="${i}" d="M${x},${H - b} v${-(h - 4)} q0,-4 4,-4 h${bw - 14} q4,0 4,4 v${h - 4} z"/>
          <rect class="bar-hit" data-i="${i}" x="${l + i * bw}" y="${t}" width="${bw}" height="${H - t - b}"/>
          <text class="ax" x="${x + (bw - 6) / 2}" y="${H - 7}" text-anchor="middle">${years[i]}</text>`;
      }).join('')}</svg></div>
      ${y1 === years.at(-1) ? '<p class="muted small">The current year is incomplete.</p>' : ''}`;
    const tipEl = document.createElement('div'); tipEl.className = 'viz-tip'; tipEl.hidden = true; document.body.appendChild(tipEl);
    box.querySelectorAll('.bar-hit').forEach((r) => {
      r.onmousemove = (ev) => { const i = +r.dataset.i; tipEl.innerHTML = `<b>${years[i]}</b><br>${counts[i].toLocaleString()} papers`; tipEl.hidden = false; tipEl.style.left = ev.clientX + 12 + 'px'; tipEl.style.top = ev.clientY + 12 + 'px'; };
      r.onmouseleave = () => { tipEl.hidden = true; };
    });
    window.addEventListener('hashchange', () => tipEl.remove(), { once: true });
  } catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

async function mostCited(box, query, yearsBack, p) {
  if (!query) { box.innerHTML = '<p class="muted">No query.</p>'; return; }
  box.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const from = `${new Date().getFullYear() - yearsBack + 1}-01-01`;
    const j = await (await fetch(epmcUrl(query, { from, sort: 'CITED desc', pageSize: 15 }))).json();
    const evs = (j.resultList?.result || []).map((r) => ({ ...epmcToEvent(r), product_id: p.id, created_at: '' }));
    box.innerHTML = eventList(evs);
    bindEventActions(box, evs, new Map([[p.id, p]]));
  } catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

// ------------------------------------------------------------ add / edit
async function productModal(p, linked = new Set()) {
  const [projects, tags] = await Promise.all([
    sb.from('projects').select('id,title,status').neq('status', 'archived').order('title').then(check),
    allTags(),
  ]);
  const v = (k) => esc(p?.[k] ?? '');
  const m = modal(p ? `Edit ${p.name}` : 'Add technology', `<form>
    <label>Name or product-page link<input name="name" required value="${v('name')}" placeholder="e.g. Visium HD, or https://www.10xgenomics.com/platforms/visium"></label>
    <div class="grid-2">
      <label>Product page URL <small class="muted">watched for changes by the daily job</small><input name="url" type="url" value="${v('url')}"></label>
      <label>Vendor<input name="vendor" value="${v('vendor')}" placeholder="e.g. 10x Genomics"></label>
    </div>
    <div class="grid-2">
      <label>Category<input name="category" list="tech-cats" value="${v('category')}"><datalist id="tech-cats">${CATEGORIES.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label>Aliases <small class="muted">other names used in papers, comma-separated</small><input name="aliases" value="${esc((p?.aliases || []).join(', '))}" placeholder="e.g. Visium High Definition"></label>
    </div>
    <details ${p?.search_query || p?.feed_url ? 'open' : ''}><summary class="small">Advanced</summary>
      <label>Custom Europe PMC query <small class="muted">replaces name + aliases, e.g. to exclude a common word</small>
        <input name="search_query" value="${v('search_query')}" placeholder='("CosMx" OR "CosMx SMI") AND (NanoString OR Bruker)'></label>
      <label>News / RSS feed URL <small class="muted">auto-detected from the product page when possible</small><input name="feed_url" type="url" value="${v('feed_url')}"></label>
    </details>
    <label>Tags ${tagInputHtml('tags', p?.tags || [], tags.map((t) => t.tag))}</label>
    <label>Used in projects<select name="projects" multiple size="${Math.min(6, Math.max(3, projects.length))}">
      ${projects.map((x) => `<option value="${x.id}" ${linked.has(x.id) ? 'selected' : ''}>${esc(x.title)} (${x.status})</option>`).join('')}</select></label>
    <label>Notes<textarea name="notes" rows="3" placeholder="What the lab uses it for, contacts, pricing… (Markdown)">${v('notes')}</textarea></label>
    <div class="row end"><button class="primary">${p ? 'Save' : 'Add and search literature'}</button></div></form>`, { wide: true });
  const form = m.el.querySelector('form');
  // A pasted link in the name field becomes the URL, with a guessed name and vendor
  form.name.onchange = () => {
    const val = form.name.value.trim();
    if (!/^https?:\/\//i.test(val)) return;
    try {
      const u = new URL(val);
      if (!form.url.value) form.url.value = val;
      const seg = u.pathname.split('/').filter(Boolean).pop() || u.hostname.split('.')[0];
      form.name.value = decodeURIComponent(seg).replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      if (!form.vendor.value) form.vendor.value = u.hostname.replace(/^www\./, '').split('.')[0].replace(/^\w/, (c) => c.toUpperCase());
      toast('Name and vendor guessed from the link; please check them');
    } catch { /* not a URL */ }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    const row = {
      name: d.name.trim(), url: d.url.trim() || null, vendor: d.vendor.trim() || null, category: d.category.trim() || null,
      aliases: parseTags(d.aliases).length ? d.aliases.split(',').map((x) => x.trim()).filter(Boolean) : [],
      search_query: d.search_query.trim() || null, feed_url: d.feed_url.trim() || null, tags: readTags(form), notes: d.notes,
    };
    if (p && p.url !== row.url) Object.assign(row, { page_hash: null, page_text: null, check_error: null });   // new page → new baseline
    try {
      const saved = p ? check(await sb.from('products').update(row).eq('id', p.id).select('*').single())
        : check(await sb.from('products').insert(row).select('*').single());
      const want = new Set([...form.elements.projects.selectedOptions].map((o) => o.value));
      const del = [...linked].filter((x) => !want.has(x)), add = [...want].filter((x) => !linked.has(x));
      if (del.length) check(await sb.from('product_projects').delete().eq('product_id', saved.id).in('project_id', del));
      if (add.length) check(await sb.from('product_projects').insert(add.map((project_id) => ({ product_id: saved.id, project_id }))));
      m.close();
      if (!p) { toast('Searching Europe PMC…'); await checkLiterature(saved).catch(() => {}); }
      if (location.hash === `#/tech/${saved.id}`) productView(document.getElementById('app'), { id: saved.id });
      else location.hash = `#/tech/${saved.id}`;
    } catch (err) { fail(err, 'Save'); }
  };
}

// ------------------------------------------------------------ widgets used elsewhere
export async function techForProject(projectId) {
  const rows = check(await sb.from('product_projects').select('product:products(id,name)').eq('project_id', projectId));
  return rows.map((r) => r.product).filter(Boolean);
}

export async function latestTechEvents(n = 6) {
  const rows = check(await sb.from('product_events').select('id,kind,title,url,event_date,created_at,product:products(id,name)')
    .in('kind', ['page_change', 'news', 'note']).order('created_at', { ascending: false }).limit(n));
  return rows;
}
