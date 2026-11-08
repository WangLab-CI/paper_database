import { sb, state, check, fetchAll, findExisting, cleanPaper, allTags } from '../db.js';
import { esc, toast, fail, authorsShort, parseTags, normalizeDoi, RELATIONS } from '../util.js';
import { lookup, searchLiterature, parseIdentifier } from '../metadata.js';
import { parseReferences } from '../bibtex.js';
import { paperFormHtml, readPaperForm } from './papers.js';
import { modal } from '../ui.js';
import { planImport, mergePatch, FILLABLE } from '../importplan.js';
import { renderLinkBuilder } from './linkbuilder.js';
import { resolveInput } from './addbylink.js';

export async function importView(root, { params }) {
  const tagNames = (await allTags()).map((t) => t.tag);
  root.innerHTML = `
    <h1>Add papers</h1>
    <div class="grid-2">
      <section class="card">
        <h2>By identifier or link</h2>
        <form id="lookup" class="row">
          <input name="id" value="${esc(params.id || '')}" placeholder="DOI, PMID, arXiv ID, or any article web page link" autocomplete="off">
          <button class="primary">Look up</button>
        </form>
        <p class="muted small">Metadata from Crossref, Europe PMC and DataCite. Links from journals, PubMed, PMC, bioRxiv, arXiv, ScienceDirect/Cell and Nature are recognised directly; other sites are read by the optional page-reader function (see README) or matched by title. You can edit everything before saving.</p>
        <div id="lookup-out"></div>
      </section>
      <section class="card">
        <h2>Search literature</h2>
        <form id="search" class="row">
          <input name="q" placeholder='Europe PMC query, e.g. KRAS G12D organoid "single-cell"' autocomplete="off">
          <button>Search</button>
        </form>
        <p class="muted small">Covers PubMed, PMC and preprints (bioRxiv/medRxiv). Supports <code>AUTH:"Smith J"</code>, <code>PUB_YEAR:2024</code>.</p>
        <div id="search-out"></div>
      </section>
    </div>
    <section class="card">
      <h2>Bulk import from Zotero / Mendeley / EndNote</h2>
      <p class="muted">Export a collection as <b>BibTeX (.bib)</b> or <b>RIS (.ris)</b>. In Zotero: right-click a collection → Export Collection… → BibTeX.
      New papers are added; papers already in the library (same DOI, PMID, arXiv ID or title) are <b>matched, not duplicated</b>,
      so the tags and project links below apply to them too. File keywords become tags on new papers.</p>
      <input type="file" id="file" accept=".bib,.bibtex,.ris,.txt">
      <div id="bulk-out"></div>
    </section>
    <section class="card" id="link-builder"></section>`;
  renderLinkBuilder(root.querySelector('#link-builder'));

  // ---------------------------------------------- single lookup
  const out = root.querySelector('#lookup-out');
  const lf = root.querySelector('#lookup');
  lf.onsubmit = async (e) => {
    e.preventDefault();
    const val = lf.id.value.trim();
    if (!val) return;
    const id = parseIdentifier(val);
    const isLink = /^https?:\/\//i.test(val);
    if (id?.type === 'query' && !isLink) { root.querySelector('#search [name=q]').value = val; root.querySelector('#search').requestSubmit(); return; }
    out.innerHTML = '<div class="loading">Fetching metadata…</div>';
    try {
      const r = await resolveInput(val);
      if (!r) { out.innerHTML = '<p class="muted">Cancelled. Paste the DOI or PMID instead, or enter details manually.</p>'; return; }
      showEditor(out, r.rec, tagNames);
      if (r.via !== 'identifier') out.insertAdjacentHTML('afterbegin', `<p class="muted small">Identified via ${esc(r.via)}. Please check the details.</p>`);
    } catch (err) {
      out.innerHTML = `<p class="error">Lookup failed: ${esc(err.message)}. You can enter details manually.</p><button id="manual">Enter manually</button>`;
      out.querySelector('#manual').onclick = () => showEditor(out, { doi: normalizeDoi(val) }, tagNames);
    }
  };
  if (params.id) lf.requestSubmit();

  // ---------------------------------------------- literature search
  const so = root.querySelector('#search-out');
  root.querySelector('#search').onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return;
    so.innerHTML = '<div class="loading">Searching…</div>';
    try {
      const res = await searchLiterature(q, 20);
      so.innerHTML = res.length ? `<ul class="list">${res.map((r, i) => `
        <li><b>${esc(r.title)}</b>
          <div class="meta">${esc(authorsShort(r.authors))} ${r.year || ''} ${r.journal ? '· <i>' + esc(r.journal) + '</i>' : ''}
            ${r.pmid ? '· PMID ' + esc(r.pmid) : ''}</div>
          <div class="row"><button class="small" data-i="${i}">Review & add</button>
          ${r.abstract ? `<details><summary class="small">abstract</summary><p class="small">${esc(r.abstract)}</p></details>` : ''}</div></li>`).join('')}</ul>`
        : '<p class="muted">No results.</p>';
      so.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => {
        const m = modal('Add paper', '<div></div>', { wide: true });
        showEditor(m.el.firstElementChild, res[+b.dataset.i], tagNames, () => { m.close(); b.textContent = '✓ added'; b.disabled = true; });
      }));
    } catch (err) { so.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  };

  // ---------------------------------------------- bulk
  root.querySelector('#file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bo = root.querySelector('#bulk-out');
    bo.innerHTML = '<div class="loading">Parsing…</div>';
    try {
      const text = await file.text();
      const recs = parseReferences(text, file.name).map(cleanPaper).filter((r) => r.title && r.title !== '(untitled)');
      bo.innerHTML = '<div class="loading">Matching against the library…</div>';
      const [existing, projects] = await Promise.all([
        fetchAll('papers', 'id,title,tags,' + FILLABLE.join(',')),
        sb.from('projects').select('id,title,status').neq('status', 'archived').order('updated_at', { ascending: false }).then(check),
      ]);
      const plan = planImport(recs, existing);
      const n = (st) => plan.filter((x) => x.status === st).length;
      const nNew = n('new'), nEx = n('existing'), nRep = n('repeat');
      const statusCell = (x) => (x.status === 'new' ? '<span class="pill new">new</span>'
        : x.status === 'existing' ? `<a class="pill ex" href="#/paper/${x.existing.id}" target="_blank" title="matched by ${x.matchedBy}">in library</a>`
          : '<span class="pill rep" title="appears earlier in this file">repeat</span>');
      const defaultProject = params.project || '';
      bo.innerHTML = `
        <p><b>${recs.length}</b> references parsed · <b>${nNew}</b> new · <b>${nEx}</b> already in library${nRep ? ` · <span class="muted">${nRep} repeated within the file</span>` : ''}</p>
        <div class="hm-wrap" style="max-height:340px;overflow:auto"><table class="tbl"><thead><tr><th></th><th>Title</th><th>Authors</th><th>Year</th><th>IDs</th><th>File keywords</th></tr></thead><tbody>
          ${plan.slice(0, 300).map((x) => `<tr><td>${statusCell(x)}</td><td>${esc(x.rec.title)}</td><td>${esc(authorsShort(x.rec.authors, 2))}</td><td>${x.rec.year || ''}</td>
            <td class="small">${x.rec.doi ? 'DOI ' : ''}${x.rec.pmid ? 'PMID ' : ''}${x.rec.arxiv_id ? 'arXiv' : ''}</td><td class="small">${esc((x.rec.tags || []).join(', '))}</td></tr>`).join('')}
        </tbody></table>${plan.length > 300 ? `<p class="muted">…and ${plan.length - 300} more</p>` : ''}</div>

        <form id="bulk-opts" class="bulk-opts">
          <fieldset><legend>Tags</legend>
            <label>Add these tags to <b>all ${nNew + nEx}</b> papers <input name="tags" placeholder="e.g. zotero, telomere-review"></label>
            <label class="row"><input type="checkbox" name="fileTags"> Also add the file's keywords to papers already in the library</label>
          </fieldset>
          <fieldset><legend>Link to project / idea</legend>
            <div class="row wrap">
              <select name="project">
                <option value="">Don't link</option>
                <option value="__new__">+ New idea…</option>
                ${projects.map((pr) => `<option value="${pr.id}" ${pr.id === defaultProject ? 'selected' : ''}>${esc(pr.title)} (${pr.status})</option>`).join('')}
              </select>
              <input name="newTitle" placeholder="Title for the new idea" value="${esc(file.name.replace(/\.(bib|bibtex|ris|txt)$/i, ''))}" hidden>
              <select name="relation">${RELATIONS.map((r) => `<option>${r}</option>`).join('')}</select>
              <input name="note" placeholder="Link note (optional)">
            </div>
            <p class="muted small">Links all ${nNew + nEx} papers. Papers already linked to that project keep their current relation and note.</p>
          </fieldset>
          <fieldset><legend>Existing papers</legend>
            <label class="row"><input type="checkbox" name="fill" checked> Fill in empty fields (abstract, DOI, PMID, journal, year, authors…) from the file. Existing values are never overwritten.</label>
          </fieldset>
          <label class="row"><input type="checkbox" name="enrich"> Fetch missing abstracts for new papers from Europe PMC (slower: ~3 papers/s)</label>
          <div class="row end"><button class="primary" id="go">Import ${nNew} new · update ${nEx} existing</button></div>
          <progress id="prog" max="${nNew + nEx}" value="0" hidden></progress>
        </form>`;

      const form = bo.querySelector('#bulk-opts');
      form.project.onchange = () => { form.newTitle.hidden = form.project.value !== '__new__'; };
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('#go');
        btn.disabled = true;
        const prog = form.querySelector('#prog');
        prog.hidden = false;
        const extra = parseTags(form.tags.value);
        const report = { inserted: 0, updated: 0, unchanged: 0, linked: 0, failed: [] };
        try {
          // 1. optional abstract enrichment for new papers
          const fresh = plan.filter((x) => x.status === 'new').map((x) => x.rec);
          if (form.enrich.checked) {
            let i = 0;
            for (const r of fresh) {
              prog.value = ++i;
              if (r.abstract || (!r.doi && !r.pmid)) continue;
              try {
                const [hit] = await searchLiterature(r.pmid ? `EXT_ID:${r.pmid} AND SRC:MED` : `DOI:"${r.doi}"`, 1);
                const same = hit && (r.pmid ? String(hit.pmid) === String(r.pmid) : normalizeDoi(hit.doi) === r.doi);
                if (same) { r.abstract = hit.abstract; r.pmid = r.pmid || hit.pmid; }
              } catch { /* skip */ }
            }
          }
          prog.value = 0;
          // 2. insert new papers, keeping their ids
          const idOf = new Map();   // plan index → paper id
          const newIdx = plan.map((x, i) => (x.status === 'new' ? i : -1)).filter((i) => i >= 0);
          for (let b = 0; b < newIdx.length; b += 200) {
            const chunk = newIdx.slice(b, b + 200);
            const rows = chunk.map((i) => ({ ...plan[i].rec, tags: [...new Set([...(plan[i].rec.tags || []), ...extra])], added_by: state.user.id }));
            const { data, error } = await sb.from('papers').insert(rows).select('id');
            if (!error && data?.length === rows.length) {
              chunk.forEach((i, k) => idOf.set(i, data[k].id));
              report.inserted += rows.length;
            } else {
              for (let k = 0; k < rows.length; k++) {   // one by one so a single conflict doesn't lose the batch
                const r1 = await sb.from('papers').insert(rows[k]).select('id').single();
                if (r1.error) report.failed.push(`${rows[k].title}: ${r1.error.message}`);
                else { idOf.set(chunk[k], r1.data.id); report.inserted++; }
              }
            }
            prog.value = report.inserted;
          }
          // 3. update existing papers (tags + empty fields)
          const exIdx = plan.map((x, i) => (x.status === 'existing' ? i : -1)).filter((i) => i >= 0);
          const patched = new Set();
          for (const i of exIdx) {
            const x = plan[i];
            idOf.set(i, x.existing.id);
            if (patched.has(x.existing.id)) continue;      // several file records matched one paper
            patched.add(x.existing.id);
            const patch = mergePatch(x.existing, x.rec, { extraTags: extra, fileTags: form.fileTags.checked, fill: form.fill.checked });
            if (!patch) { report.unchanged++; continue; }
            let { error } = await sb.from('papers').update(patch).eq('id', x.existing.id);
            if (error && /duplicate key/i.test(error.message)) {
              // a filled identifier belongs to another library paper: retry without identifiers
              for (const k of ['doi', 'pmid', 'arxiv_id']) delete patch[k];
              ({ error } = Object.keys(patch).length ? await sb.from('papers').update(patch).eq('id', x.existing.id) : { error: null });
            }
            if (error) report.failed.push(`${x.existing.title}: ${error.message}`); else report.updated++;
            prog.value = report.inserted + report.updated + report.unchanged;
          }
          // 4. link to project
          let projectId = form.project.value;
          if (projectId === '__new__') {
            const row = check(await sb.from('projects').insert({ title: form.newTitle.value.trim() || file.name, tags: extra,
              summary: `Created from import of ${file.name}.` }).select('id').single());
            projectId = row.id;
          }
          if (projectId) {
            const pids = [...new Set(idOf.values())];
            for (let b = 0; b < pids.length; b += 500) {
              const rows = pids.slice(b, b + 500).map((pid) => ({ project_id: projectId, paper_id: pid, relation: form.relation.value, note: form.note.value || null }));
              check(await sb.from('project_papers').upsert(rows, { onConflict: 'project_id,paper_id', ignoreDuplicates: true }));
            }
            report.linked = pids.length;
          }
          toast(`Import done: ${report.inserted} new, ${report.updated} updated`, 'ok', 6000);
          form.insertAdjacentHTML('afterend', `<div class="ok import-report">
            <p><b>${report.inserted}</b> new papers added · <b>${report.updated}</b> existing papers updated · ${report.unchanged} already up to date
              ${projectId ? ` · <b>${report.linked}</b> papers linked to <a href="#/project/${projectId}?tab=papers">the project →</a>` : ''}</p>
            ${report.failed.length ? `<details class="error"><summary>${report.failed.length} problems</summary><ul class="small">${report.failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>` : ''}
            <p><a href="#/papers?sort=updated">View library →</a> · <a href="#" id="to-links">Build links among papers ↓</a></p></div>`);
          bo.querySelector('#to-links').onclick = async (ev2) => {
            ev2.preventDefault();
            const lb = root.querySelector('#link-builder');
            await renderLinkBuilder(lb);
            lb.scrollIntoView({ behavior: 'smooth' });
          };
        } catch (err) { fail(err, 'Import'); btn.disabled = false; }
      };
    } catch (err) { fail(err, 'Import'); bo.innerHTML = ''; }
  };
}

function showEditor(container, rec, tagNames, onSaved) {
  container.innerHTML = `<form class="paper-form">${paperFormHtml(rec, tagNames)}
    <div id="dup"></div>
    <div class="row end"><button class="primary">Save to library</button></div></form>`;
  const form = container.querySelector('form');
  findExisting(cleanPaper(rec)).then((ex) => {
    if (ex) form.querySelector('#dup').innerHTML = `<p class="notice">Already in library: <a href="#/paper/${ex.id}">${esc(ex.title)}</a></p>`;
  }).catch(() => {});
  form.onsubmit = async (e) => {
    e.preventDefault();
    const p = readPaperForm(form);
    try {
      const ex = await findExisting(p);
      if (ex) { toast('Already in the library', 'error'); location.hash = `#/paper/${ex.id}`; return; }
      const row = check(await sb.from('papers').insert(p).select('id').single());
      toast('Added', 'ok');
      if (onSaved) onSaved(row); else location.hash = `#/paper/${row.id}`;
    } catch (err) { fail(err, 'Save'); }
  };
}
