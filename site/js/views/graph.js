// Interactive knowledge graph: papers, projects, concepts (tags) and people.
import { sb, state, check, fetchAll, personName } from '../db.js';
import { esc, authorsShort, tagChips } from '../util.js';

const COLORS = {
  paper: '#4c8bf5', tag: '#e6a23c', person: '#2fb380',
  project: { idea: '#b37feb', exploring: '#9254de', pilot: '#f759ab', active: '#f5222d', paused: '#8c8c8c', completed: '#13a8a8', archived: '#bfbfbf' },
  rel: { background: '#999', supports: '#2fb380', contradicts: '#f5222d', method: '#4c8bf5', dataset: '#13a8a8', inspiration: '#b37feb' },
};

const PL = {
  cites:   { color: '#4c8bf5', width: 1.6, arrows: 'to', dashes: false, title: 'cites' },
  coupled: { color: '#13a8a8', width: 1.2, dashes: [6, 4], title: 'shared references' },
  similar: { color: '#9a9a9a', width: 1, dashes: [2, 4], title: 'similar wording' },
  manual:  { color: '#b37feb', width: 2, dashes: false, title: 'linked by lab member' },
};

export async function graphView(root, { params }) {
  if (!window.vis) { root.innerHTML = '<div class="card">Graph library failed to load (check network / ad blocker).</div>'; return; }
  const [papers, projects, links, plinks] = await Promise.all([
    fetchAll('papers', 'id,title,authors,year,journal,tags'),
    sb.from('projects').select('id,title,status,tags,owner_id,collaborators,summary').then(check),
    fetchAll('project_papers', 'project_id,paper_id,relation'),
    fetchAll('paper_links', 'source_id,target_id,kind,score,shared'),
  ]);

  root.innerHTML = `
    <div class="graph-wrap">
      <aside class="graph-ctrl card">
        <h2>Knowledge graph</h2>
        <input id="g-search" placeholder="Find node… (Enter)" autocomplete="off">
        <fieldset><legend>Show</legend>
          <label><input type="checkbox" data-type="project" checked> Projects</label>
          <label><input type="checkbox" data-type="paper" checked> Papers</label>
          <label><input type="checkbox" data-type="tag" checked> Concepts (tags)</label>
          <label><input type="checkbox" data-type="person"> People</label>
          <label><input type="checkbox" id="g-orphans"> Unconnected papers</label>
          <label><input type="checkbox" id="g-archived"> Archived projects</label>
        </fieldset>
        <fieldset><legend>Paper ↔ paper links</legend>
          <label><input type="checkbox" data-link="cites" checked> <span style="color:${PL.cites.color}">━▶</span> Citations</label>
          <label><input type="checkbox" data-link="coupled" checked> <span style="color:${PL.coupled.color}">┅</span> Shared references</label>
          <label><input type="checkbox" data-link="similar"> <span style="color:${PL.similar.color}">┄</span> Similar wording</label>
          <label><input type="checkbox" data-link="manual" checked> <span style="color:${PL.manual.color}">━</span> Added by lab</label>
        </fieldset>
        <label>Min. concept use <b id="g-mindeg-v">2</b>
          <input type="range" id="g-mindeg" min="1" max="10" value="2"></label>
        <label>Neighbourhood depth <b id="g-depth-v">2</b>
          <input type="range" id="g-depth" min="1" max="4" value="2"></label>
        <div class="row wrap">
          <button id="g-clear" class="small">Show all</button>
          <button id="g-physics" class="small">Freeze layout</button>
          <button id="g-fit" class="small">Fit</button>
        </div>
        <div class="legend small">
          <div><span class="dot" style="background:${COLORS.paper}"></span> paper</div>
          <div><span class="sq" style="background:${COLORS.project.active}"></span> project (colour = status)</div>
          <div><span class="tri" style="border-bottom-color:${COLORS.tag}"></span> concept</div>
          <div><span class="dot" style="background:${COLORS.person}"></span> person</div>
          <div class="muted">Edges project→paper coloured by relation:
            ${Object.entries(COLORS.rel).map(([k, c]) => `<span style="color:${c}">■</span> ${k}`).join(' ')}</div>
        </div>
        <div id="g-info" class="g-info"><p class="muted small">Click a node for details; double-click to focus its neighbourhood.</p></div>
      </aside>
      <div id="g-canvas" class="graph-canvas"></div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const fontColor = dark ? '#ddd' : '#222';
  let focus = params.focus || null;

  // ---------------- build full graph
  const tagUse = new Map();
  for (const x of [...papers, ...projects]) for (const t of x.tags || []) tagUse.set(t, (tagUse.get(t) || 0) + 1);
  const linkedPapers = new Set(links.map((l) => l.paper_id));

  function build() {
    const show = Object.fromEntries([...root.querySelectorAll('[data-type]')].map((c) => [c.dataset.type, c.checked]));
    const minDeg = +$('#g-mindeg').value;
    const withOrphans = $('#g-orphans').checked;
    const withArchived = $('#g-archived').checked;
    const kinds = new Set([...root.querySelectorAll('[data-link]')].filter((c) => c.checked).map((c) => c.dataset.link));
    const pl = plinks.filter((l) => kinds.has(l.kind));
    const plinked = new Set(pl.flatMap((l) => [l.source_id, l.target_id]));
    const nodes = new Map(), edges = [];
    const keepTag = (t) => show.tag && tagUse.get(t) >= minDeg;

    const projs = projects.filter((p) => withArchived || p.status !== 'archived');
    const projIds = new Set(projs.map((p) => p.id));
    if (show.project) for (const p of projs) {
      nodes.set(`project:${p.id}`, { id: `project:${p.id}`, label: wrap(p.title, 24), shape: 'box', margin: 8,
        color: { background: COLORS.project[p.status], border: COLORS.project[p.status] }, font: { color: '#fff', bold: true },
        title: `${p.title}\n[${p.status}]`, group: 'project', ref: p });
      for (const t of p.tags || []) if (keepTag(t)) edges.push({ from: `project:${p.id}`, to: `tag:${t}`, color: { color: COLORS.tag, opacity: 0.5 }, width: 1.5 });
    }
    if (show.paper) for (const p of papers) {
      const hasTag = (p.tags || []).some(keepTag);
      if (!withOrphans && !hasTag && !linkedPapers.has(p.id) && !plinked.has(p.id)) continue;
      const fa = authorsShort(p.authors, 1).replace(' et al.', '') || 'Anon';
      nodes.set(`paper:${p.id}`, { id: `paper:${p.id}`, label: `${fa} ${p.year || ''}`, shape: 'dot', size: 8,
        color: COLORS.paper, font: { color: fontColor, size: 11 }, title: p.title, group: 'paper', ref: p });
      for (const t of p.tags || []) if (keepTag(t)) edges.push({ from: `paper:${p.id}`, to: `tag:${t}`, color: { color: dark ? '#555' : '#ccc' }, width: 0.7 });
    }
    if (show.tag) for (const [t, n] of tagUse) if (n >= minDeg)
      nodes.set(`tag:${t}`, { id: `tag:${t}`, label: t, shape: 'triangle', size: 8 + Math.min(20, n * 1.2),
        color: COLORS.tag, font: { color: fontColor, size: 13 }, title: `${t} — used ${n}×`, group: 'tag', ref: { tag: t, n } });
    if (show.project && show.paper) for (const l of links) if (projIds.has(l.project_id))
      edges.push({ from: `project:${l.project_id}`, to: `paper:${l.paper_id}`, color: { color: COLORS.rel[l.relation] }, width: 2.5,
        title: l.relation, dashes: l.relation === 'contradicts' });
    if (show.paper) for (const l of pl) {
      const st = PL[l.kind];
      const w = l.kind === 'coupled' || l.kind === 'similar' ? st.width + 3 * Math.min(1, l.score || 0) : st.width;
      edges.push({ from: `paper:${l.source_id}`, to: `paper:${l.target_id}`, color: { color: st.color, opacity: 0.8 }, width: w,
        dashes: st.dashes, arrows: st.arrows ? { to: { enabled: true, scaleFactor: 0.5 } } : undefined,
        title: l.kind === 'coupled' ? `${l.shared} shared references (score ${l.score})` : l.kind === 'similar' ? `similar wording (${l.score})` : st.title });
    }
    if (show.person) for (const u of state.profiles.values()) {
      if (u.role === 'pending') continue;
      nodes.set(`person:${u.id}`, { id: `person:${u.id}`, label: u.full_name || u.email.split('@')[0], shape: 'dot', size: 14,
        color: COLORS.person, font: { color: fontColor, size: 13, bold: true }, group: 'person', ref: u });
      if (show.project) for (const p of projs) {
        if (p.owner_id === u.id) edges.push({ from: `person:${u.id}`, to: `project:${p.id}`, color: { color: COLORS.person }, width: 3 });
        else if (p.collaborators?.includes(u.id)) edges.push({ from: `person:${u.id}`, to: `project:${p.id}`, color: { color: COLORS.person }, width: 1.5, dashes: true });
      }
    }
    const valid = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
    // scale papers by degree
    const deg = new Map();
    for (const e of valid) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
    for (const n of nodes.values()) if (n.group === 'paper') n.size = 6 + Math.min(14, (deg.get(n.id) || 0) * 1.5);
    return { nodes: [...nodes.values()], edges: valid };
  }

  function neighbourhood(full, start, depth) {
    const adj = new Map();
    for (const e of full.edges) {
      (adj.get(e.from) || adj.set(e.from, []).get(e.from)).push(e.to);
      (adj.get(e.to) || adj.set(e.to, []).get(e.to)).push(e.from);
    }
    const seen = new Set([start]);
    let frontier = [start];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const n of frontier) for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); next.push(m); }
      frontier = next;
    }
    return { nodes: full.nodes.filter((n) => seen.has(n.id)), edges: full.edges.filter((e) => seen.has(e.from) && seen.has(e.to)) };
  }

  const nodesDS = new vis.DataSet(), edgesDS = new vis.DataSet();
  const network = new vis.Network($('#g-canvas'), { nodes: nodesDS, edges: edgesDS }, {
    interaction: { hover: true, tooltipDelay: 150, navigationButtons: false, keyboard: false },
    physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -60, springLength: 90, avoidOverlap: 0.3 },
      stabilization: { iterations: 250, updateInterval: 50 } },
    edges: { smooth: false, selectionWidth: 2 },
    layout: { improvedLayout: false },
  });

  // Tear the network down when the user leaves the page.
  const alive = () => {
    if (root.contains(canvas)) return true;
    network.destroy();
    return false;
  };
  const canvas = $('#g-canvas');
  window.addEventListener('hashchange', alive, { once: true });

  let physicsOn = true;
  function render() {
    const full = build();
    if (focus && !full.nodes.some((n) => n.id === focus)) {
      // focused node may be hidden by filters — enable its type
      const type = focus.split(':')[0];
      const cb = root.querySelector(`[data-type=${type}]`);
      if (cb && !cb.checked) { cb.checked = true; return render(); }
    }
    const g = focus ? neighbourhood(full, focus, +$('#g-depth').value) : full;
    nodesDS.clear(); edgesDS.clear();
    nodesDS.add(g.nodes); edgesDS.add(g.edges.map((e, i) => ({ id: i, ...e })));
    if (!physicsOn) { physicsOn = true; network.setOptions({ physics: { enabled: true } }); $('#g-physics').textContent = 'Freeze layout'; }
    if (focus) { network.once('stabilized', () => { network.selectNodes([focus]); showInfo(focus); network.fit({ animation: true }); }); }
    $('#g-clear').disabled = !focus;
    if (!g.nodes.length) $('#g-info').innerHTML = '<p class="muted">Nothing to show — add tags to papers/projects or lower “min. concept use”.</p>';
  }

  function showInfo(id) {
    if (!alive()) return;
    const n = nodesDS.get(id);
    if (!n) return;
    const r = n.ref;
    const nbrs = network.getConnectedNodes(id).map((x) => nodesDS.get(x)).filter(Boolean);
    const nbrList = (type, label) => {
      const xs = nbrs.filter((x) => x.group === type);
      return xs.length ? `<h4>${label} (${xs.length})</h4><ul>${xs.slice(0, 25).map((x) => `<li><a href="#" data-node="${esc(x.id)}">${esc(x.group === 'paper' ? x.ref.title : x.label)}</a></li>`).join('')}${xs.length > 25 ? '<li class="muted">…</li>' : ''}</ul>` : '';
    };
    let head = '';
    if (n.group === 'paper') head = `<h3><a href="#/paper/${r.id}">${esc(r.title)}</a></h3><div class="meta">${esc(authorsShort(r.authors))} ${r.year || ''} ${r.journal ? '· ' + esc(r.journal) : ''}</div><div>${tagChips(r.tags, '#/papers?tag=')}</div>`;
    if (n.group === 'project') head = `<h3><a href="#/project/${r.id}">${esc(r.title)}</a></h3><span class="status s-${r.status}">${r.status}</span><p class="small">${esc((r.summary || '').slice(0, 300))}</p>`;
    if (n.group === 'tag') head = `<h3>Concept: ${esc(r.tag)}</h3><a href="#/papers?tag=${encodeURIComponent(r.tag)}">List ${r.n} items →</a>`;
    if (n.group === 'person') head = `<h3>${esc(personName(r.id))}</h3>`;
    $('#g-info').innerHTML = `${head}
      <div class="row"><button class="small" id="g-focus">Focus here</button></div>
      ${nbrList('project', 'Projects')}${nbrList('tag', 'Concepts')}${nbrList('paper', 'Papers')}${nbrList('person', 'People')}`;
    $('#g-focus').onclick = () => setFocus(id);
    $('#g-info').querySelectorAll('[data-node]').forEach((a) => (a.onclick = (e) => {
      e.preventDefault(); network.selectNodes([a.dataset.node]); network.focus(a.dataset.node, { scale: 1.2, animation: true }); showInfo(a.dataset.node);
    }));
  }

  function setFocus(id) {
    focus = id;
    history.replaceState(null, '', `#/graph${id ? '?focus=' + encodeURIComponent(id) : ''}`);
    render();
  }

  network.on('click', (e) => { if (e.nodes[0]) showInfo(e.nodes[0]); });
  network.on('doubleClick', (e) => { if (e.nodes[0]) setFocus(e.nodes[0]); });
  network.on('stabilizationIterationsDone', () => { if (alive()) network.fit(); });

  root.querySelectorAll('.graph-ctrl input[type=checkbox]').forEach((c) => (c.onchange = render));
  $('#g-mindeg').oninput = (e) => { $('#g-mindeg-v').textContent = e.target.value; };
  $('#g-mindeg').onchange = render;
  $('#g-depth').oninput = (e) => { $('#g-depth-v').textContent = e.target.value; };
  $('#g-depth').onchange = render;
  $('#g-clear').onclick = () => setFocus(null);
  $('#g-fit').onclick = () => network.fit({ animation: true });
  $('#g-physics').onclick = (e) => {
    physicsOn = !physicsOn;
    network.setOptions({ physics: { enabled: physicsOn } });
    e.target.textContent = physicsOn ? 'Freeze layout' : 'Resume layout';
  };
  $('#g-search').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const hit = nodesDS.get().find((n) => n.label.toLowerCase().includes(q) || (n.title || '').toLowerCase().includes(q));
    if (!hit) { e.target.classList.add('shake'); setTimeout(() => e.target.classList.remove('shake'), 400); return; }
    network.selectNodes([hit.id]); network.focus(hit.id, { scale: 1.3, animation: true }); showInfo(hit.id);
  };

  render();
}

function wrap(s, n) {
  const words = String(s).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join('\n') + (lines.length > 3 ? '…' : '');
}
