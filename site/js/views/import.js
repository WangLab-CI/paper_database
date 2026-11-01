import { sb, state, check, fetchAll, findExisting, cleanPaper, allTags } from '../db.js';
import { esc, toast, fail, authorsShort, parseTags, normalizeDoi } from '../util.js';
import { lookup, searchLiterature, parseIdentifier } from '../metadata.js';
import { parseReferences } from '../bibtex.js';
import { paperFormHtml, readPaperForm } from './papers.js';
import { modal } from '../ui.js';
import { renderLinkBuilder } from './linkbuilder.js';

export async function importView(root, { params }) {
  const tagNames = (await allTags()).map((t) => t.tag);
  root.innerHTML = `
    <h1>Add papers</h1>
    <div class="grid-2">
      <section class="card">
        <h2>By identifier</h2>
        <form id="lookup" class="row">
          <input name="id" value="${esc(params.id || '')}" placeholder="DOI, PMID, PMCID, arXiv ID or URL" autocomplete="off">
          <button class="primary">Look up</button>
        </form>
        <p class="muted small">Metadata from Crossref, Europe PMC and DataCite. You can edit everything before saving.</p>
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
      <p class="muted">Export your library as <b>BibTeX (.bib)</b> or <b>RIS (.ris)</b>. In Zotero: right-click a collection → Export Collection… → BibTeX (tick “Export Notes” off).
      Duplicates (same DOI, PMID, arXiv ID or title) are skipped. Keywords become tags.</p>
      <div class="row wrap">
        <input type="file" id="file" accept=".bib,.bibtex,.ris,.txt">
        <label>Add tags to all imported <input id="bulk-tags" placeholder="e.g. zotero, review-2026"></label>
      </div>
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
    if (id?.type === 'query') { root.querySelector('#search [name=q]').value = val; root.querySelector('#search').requestSubmit(); return; }
    out.innerHTML = '<div class="loading">Fetching metadata…</div>';
    try {
      const rec = await lookup(val);
      showEditor(out, rec, tagNames);
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
      bo.innerHTML = '<div class="loading">Checking for duplicates…</div>';
      const existing = await fetchAll('papers', 'doi,pmid,arxiv_id,title');
      const key = { doi: new Set(), pmid: new Set(), arxiv_id: new Set(), title: new Set() };
      const normT = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const x of existing) { for (const k of ['doi', 'pmid', 'arxiv_id']) if (x[k]) key[k].add(x[k]); key.title.add(normT(x.title)); }
      const fresh = [], dups = [];
      for (const r of recs) {
        const dup = ['doi', 'pmid', 'arxiv_id'].some((k) => r[k] && key[k].has(r[k])) || key.title.has(normT(r.title));
        if (dup) { dups.push(r); continue; }
        fresh.push(r);
        for (const k of ['doi', 'pmid', 'arxiv_id']) if (r[k]) key[k].add(r[k]);   // de-dup within file too
        key.title.add(normT(r.title));
      }
      bo.innerHTML = `
        <p><b>${recs.length}</b> references parsed · <b>${fresh.length}</b> new · <span class="muted">${dups.length} duplicates skipped</span></p>
        ${fresh.length ? `<table class="tbl"><thead><tr><th>Title</th><th>Authors</th><th>Year</th><th>IDs</th><th>Tags</th></tr></thead><tbody>
          ${fresh.slice(0, 200).map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(authorsShort(r.authors, 2))}</td><td>${r.year || ''}</td>
            <td class="small">${r.doi ? 'DOI ' : ''}${r.pmid ? 'PMID ' : ''}${r.arxiv_id ? 'arXiv' : ''}</td><td class="small">${esc((r.tags || []).join(', '))}</td></tr>`).join('')}
          </tbody></table>${fresh.length > 200 ? `<p class="muted">…and ${fresh.length - 200} more</p>` : ''}
          <label class="row"><input type="checkbox" id="enrich"> Fetch missing abstracts from Europe PMC (slower: ~3 papers/s)</label>
          <div class="row end"><button class="primary" id="go">Import ${fresh.length} papers</button></div>
          <progress id="prog" max="${fresh.length}" value="0" hidden></progress>` : ''}`;
      bo.querySelector('#go')?.addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        const extra = parseTags(root.querySelector('#bulk-tags').value);
        const prog = bo.querySelector('#prog');
        prog.hidden = false;
        if (bo.querySelector('#enrich').checked) {
          let i = 0;
          for (const r of fresh) {
            prog.value = ++i;
            if (r.abstract || (!r.doi && !r.pmid)) continue;
            try {
              const q = r.pmid ? `EXT_ID:${r.pmid} AND SRC:MED` : `DOI:"${r.doi}"`;
              const [hit] = await searchLiterature(q, 1);
              if (hit) { r.abstract = hit.abstract; r.pmid = r.pmid || hit.pmid; }
            } catch { /* skip */ }
          }
        }
        let done = 0;
        prog.value = 0;
        for (let i = 0; i < fresh.length; i += 200) {
          const batch = fresh.slice(i, i + 200).map((r) => ({ ...r, tags: [...new Set([...(r.tags || []), ...extra])], added_by: state.user.id }));
          try {
            check(await sb.from('papers').insert(batch));
            done += batch.length;
          } catch (err) {
            // fall back to one-by-one so a single conflict does not lose the batch
            for (const r of batch) {
              const { error } = await sb.from('papers').insert(r);
              if (!error) done++; else console.warn('skip', r.title, error.message);
            }
          }
          prog.value = done;
        }
        toast(`Imported ${done} papers`, 'ok', 6000);
        bo.insertAdjacentHTML('beforeend', `<p class="ok">Imported ${done} of ${fresh.length}. <a href="#/papers?sort=added">View library →</a> ·
          <a href="#" id="to-links">Build links among papers ↓</a></p>`);
        bo.querySelector('#to-links').onclick = async (ev2) => {
          ev2.preventDefault();
          const lb = root.querySelector('#link-builder');
          await renderLinkBuilder(lb);
          lb.scrollIntoView({ behavior: 'smooth' });
        };
      });
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
