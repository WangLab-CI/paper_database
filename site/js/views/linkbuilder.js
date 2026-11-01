// "Build links" panel: enrich papers from OpenAlex, then compute and store
// citation / shared-reference / text-similarity links. Manual links are never touched.
import { sb, check, fetchAll } from '../db.js';
import { esc, toast, fail } from '../util.js';
import { fetchOpenAlex, computeLinks } from '../links.js';

const AUTO = ['cites', 'coupled', 'similar'];

// Needs an OpenAlex lookup: never checked, or checked before author/topic metadata was stored.
export const needsEnrichment = (p, refresh = false) =>
  (p.doi || p.pmid) && (refresh || !p.enriched_at || (p.openalex_id && !p.oa_meta));

// Look papers up in OpenAlex and save the results. Returns the merged paper list.
export async function enrichPapers(papers, { refresh = false, topicTags = false } = {}, onProgress = () => {}) {
  const todo = papers.filter((p) => needsEnrichment(p, refresh));
  if (!todo.length) return { papers, checked: 0, found: 0 };
  const recs = await fetchOpenAlex(todo, onProgress);
  const stamp = new Date().toISOString();
  const rows = todo.map((p) => {
    const r = recs.get(p.id);
    const row = { id: p.id, title: p.title, enriched_at: stamp };
    if (r) {
      Object.assign(row, r);
      if (topicTags && !(p.tags || []).length && r.oa_topics[0]) row.tags = [r.oa_topics[0].toLowerCase()];
    }
    return row;
  });
  // rows differ in their keys; group so every upsert batch has identical columns
  const groups = new Map();
  for (const r of rows) { const k = Object.keys(r).sort().join(','); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  for (const g of groups.values()) for (let i = 0; i < g.length; i += 200) {
    check(await sb.from('papers').upsert(g.slice(i, i + 200), { onConflict: 'id' }));
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { papers: papers.map((p) => ({ ...p, ...(byId.get(p.id) || {}) })), checked: todo.length, found: recs.size };
}

export async function renderLinkBuilder(el) {
  const [{ count: total }, { count: enriched }, { count: nLinks }] = await Promise.all([
    sb.from('papers').select('id', { count: 'exact', head: true }),
    sb.from('papers').select('id', { count: 'exact', head: true }).not('enriched_at', 'is', null),
    sb.from('paper_links').select('kind', { count: 'exact', head: true }).in('kind', AUTO),
  ]);
  el.innerHTML = `
    <h2 id="links">Link papers automatically</h2>
    <p class="muted">Finds relationships among papers already in the library. Run it again after each import; links you add by hand are kept.</p>
    <ul class="small">
      <li><b>Cites</b>: paper A's reference list contains paper B (from OpenAlex; needs a DOI or PMID).</li>
      <li><b>Shared references</b> (bibliographic coupling): A and B cite at least <i>k</i> of the same works.
        Score = shared ÷ √(refs A × refs B).</li>
      <li><b>Similar wording</b>: TF-IDF cosine similarity of title + abstract. Lexical overlap only. It does not
        detect papers that make the same point in different words, and can link papers that share jargon but not findings.</li>
    </ul>
    <p class="small">${total ?? 0} papers · ${enriched ?? 0} already checked in OpenAlex · ${nLinks ?? 0} automatic links stored</p>
    <form id="lb" class="grid-3">
      <label>Min. shared references <input name="minShared" type="number" min="1" max="50" value="3"></label>
      <label>Min. text similarity (0–1) <input name="minText" type="number" min="0.05" max="0.95" step="0.05" value="0.25"></label>
      <label>Max. similar papers each <input name="maxText" type="number" min="1" max="20" value="5"></label>
      <label class="row"><input type="checkbox" name="refresh"> Re-check all papers in OpenAlex (otherwise only new ones)</label>
      <label class="row"><input type="checkbox" name="topicTags"> Tag untagged papers with their main OpenAlex topic</label>
      <div class="row end"><button class="primary">Build links</button></div>
    </form>
    <div id="lb-status"></div>`;

  const form = el.querySelector('#lb');
  const status = el.querySelector('#lb-status');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    const say = (html) => { status.innerHTML = html; };
    try {
      say('<p class="loading">Loading library…</p>');
      let papers = await fetchAll('papers', 'id,title,abstract,doi,pmid,tags,openalex_id,refs,enriched_at,oa_meta');

      // 1. OpenAlex enrichment
      const todoN = papers.filter((p) => needsEnrichment(p, form.refresh.checked)).length;
      if (todoN) say(`<p>Looking up ${todoN} papers in OpenAlex… <progress id="lb-prog" max="${todoN}" value="0"></progress></p>`);
      const { papers: updated, checked, found } = await enrichPapers(papers, { refresh: form.refresh.checked, topicTags: form.topicTags.checked },
        (d) => { const pr = status.querySelector('#lb-prog'); if (pr) pr.value = d; });
      papers = updated;

      // 2. Compute links
      say('<p class="loading">Computing links…</p>');
      const links = computeLinks(papers, {
        minShared: +form.minShared.value,
        text: { minScore: +form.minText.value, maxPerPaper: +form.maxText.value },
      });

      // 3. Replace automatic links
      check(await sb.from('paper_links').delete().in('kind', AUTO));
      for (let i = 0; i < links.length; i += 500) check(await sb.from('paper_links').insert(links.slice(i, i + 500)));

      const n = (k) => links.filter((l) => l.kind === k).length;
      const noId = papers.filter((p) => !p.doi && !p.pmid).length;
      say(`<p class="ok">Done. ${checked ? `OpenAlex matched ${found} of ${checked} papers checked. ` : ''}
        Stored <b>${n('cites')}</b> citation links, <b>${n('coupled')}</b> shared-reference links and <b>${n('similar')}</b> similar-wording links.</p>
        ${noId ? `<p class="muted small">${noId} papers have no DOI/PMID, so only text similarity can link them.</p>` : ''}
        <p><a href="#/graph">View in the graph →</a></p>`);
      toast('Links updated', 'ok');
    } catch (err) {
      fail(err, 'Build links');
      say(`<p class="error">${esc(err.message || err)}</p>`);
    } finally { btn.disabled = false; }
  };
}
