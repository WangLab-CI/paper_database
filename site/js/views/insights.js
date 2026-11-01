// Insights: topic trends, geography, collaboration groups, and relevant works
// missing from the library. Data: OpenAlex metadata stored on each paper (oa_meta).
import { sb, check, fetchAll, cleanPaper, findExisting } from '../db.js';
import { esc, toast, fail, normalizeDoi } from '../util.js';
import { enrichPapers, needsEnrichment } from './linkbuilder.js';
import {
  topicYearMatrix, groupTopicMatrix, collaborationGroups, frequentlyCited, frequentlyRelated, rankCiting, topicIdOf,
} from '../insights-data.js';
import { shortOa } from '../links.js';

const OA = 'https://api.openalex.org/works';
const TABS = [['trends', 'Topic trends'], ['geo', 'Countries & institutes'], ['groups', 'Collaborative groups'], ['missing', 'Missing works']];
const LEVELS = [['field', 'Field (broad)'], ['subfield', 'Subfield'], ['topic', 'Topic (specific)'], ['tag', 'Lab tags']];
const regionName = (() => { try { const d = new Intl.DisplayNames(['en'], { type: 'region' }); return (c) => { try { return d.of(c); } catch { return c; } }; } catch { return (c) => c; } })();

let cache = null;   // papers for this page visit

export async function insightsView(root, { params }) {
  const tab = params.tab || 'trends';
  cache = await fetchAll('papers', 'id,title,authors,year,journal,doi,pmid,tags,openalex_id,refs,enriched_at,oa_meta');
  const withMeta = cache.filter((p) => p.oa_meta).length;
  const pending = cache.filter((p) => needsEnrichment(p)).length;

  root.innerHTML = `
    <div class="page-head"><h1>Insights</h1></div>
    <p class="muted small">Based on <b>${withMeta}</b> of ${cache.length} library papers with OpenAlex metadata.
      ${pending ? `<b>${pending}</b> papers with a DOI/PMID have not been looked up yet. <button class="small" id="enrich">Fetch metadata now</button>` : ''}
      These charts describe <i>what the lab has collected</i>, which is a selected sample, not the whole field.</p>
    <span id="enrich-status"></span>
    <nav class="tabs flat">${TABS.map(([k, l]) => `<a href="#/insights?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div id="itab"></div>
    <div id="viz-tip" class="viz-tip" hidden></div>`;

  root.querySelector('#enrich')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const st = root.querySelector('#enrich-status');
    st.innerHTML = `<progress max="${pending}" value="0"></progress>`;
    try {
      const r = await enrichPapers(cache, {}, (d) => { st.querySelector('progress').value = d; });
      toast(`OpenAlex matched ${r.found} of ${r.checked}`, 'ok');
      insightsView(root, { params });
    } catch (err) { fail(err, 'OpenAlex'); e.target.disabled = false; }
  });

  const el = root.querySelector('#itab');
  const papers = cache.filter((p) => p.oa_meta || (p.tags?.length && p.year));
  if (!papers.length) { el.innerHTML = '<div class="card muted">No data yet. Import papers, then fetch their OpenAlex metadata (button above).</div>'; return; }
  if (tab === 'trends') trendsTab(el, papers, params);
  else if (tab === 'geo') geoTab(el, papers, params);
  else if (tab === 'groups') groupsTab(el, papers, params);
  else missingTab(el, papers);
}

// ================================================================ tooltip
function tip(html, ev) {
  const t = document.getElementById('viz-tip');
  if (!t) return;
  if (!html) { t.hidden = true; return; }
  t.innerHTML = html; t.hidden = false;
  const x = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 8);
  const y = ev.clientY + 14 + t.offsetHeight > innerHeight ? ev.clientY - t.offsetHeight - 10 : ev.clientY + 14;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}

const controls = (items) => `<form class="viz-controls">${items.join('')}</form>`;
const select = (name, opts, val, label) => `<label>${label}<select name="${name}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
function bindControls(el, tab, params) {
  el.querySelectorAll('.viz-controls select, .viz-controls input').forEach((c) => (c.onchange = () => {
    const f = el.querySelector('.viz-controls');
    const q = new URLSearchParams({ tab });
    for (const x of f.elements) if (x.name) q.set(x.name, x.type === 'checkbox' ? (x.checked ? '1' : '') : x.value);
    location.hash = `#/insights?${q}`;
  }));
}

// ================================================================ heatmap
// Sequential single-hue (blue) ramp, 7 steps; 0 renders as an empty cell.
function heatmap({ rows, cols, values, rowLabel = (r) => r.label, colLabel = (c) => c.label, fmt = (v) => v, tipFn, onRow, colEvery = 1 }) {
  const max = Math.max(0, ...values.flat());
  const step = (v) => (v <= 0 || !max ? 0 : Math.min(7, 1 + Math.floor((v / max) * 6.999)));
  const cw = Math.max(14, Math.min(44, Math.floor(760 / Math.max(1, cols.length)))), ch = 24, lw = 230, th = 70;
  const W = lw + cols.length * cw + 4, H = th + rows.length * ch + 4;
  const cells = rows.map((r, i) => cols.map((c, j) => {
    const v = values[i][j];
    return `<rect class="hm-cell s${step(v)}" x="${lw + j * cw + 1}" y="${th + i * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" data-i="${i}" data-j="${j}"></rect>`;
  }).join('')).join('');
  const rl = rows.map((r, i) => `<text class="hm-rl ${onRow ? 'clickable' : ''}" data-row="${i}" x="${lw - 8}" y="${th + i * ch + ch / 2 + 4}" text-anchor="end">${esc(trunc(rowLabel(r), 34))}</text>`).join('');
  const cl = cols.map((c, j) => (j % colEvery ? '' : `<text class="hm-cl" transform="translate(${lw + j * cw + cw / 2 + 4},${th - 6}) rotate(-50)">${esc(trunc(colLabel(c), 22))}</text>`)).join('');
  const legend = `<div class="hm-legend small"><span>fewer</span>${[1, 2, 3, 4, 5, 6, 7].map((s) => `<i class="s${s}"></i>`).join('')}<span>more</span>
    <span class="muted">· max ${fmt(max)}</span></div>`;
  const html = `<div class="hm-wrap"><svg class="heatmap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${cells}${rl}${cl}</svg></div>${legend}`;
  return {
    html,
    bind(container) {
      container.querySelectorAll('.hm-cell').forEach((c) => {
        c.onmousemove = (ev) => tip(tipFn(+c.dataset.i, +c.dataset.j), ev);
        c.onmouseleave = () => tip(null);
      });
      if (onRow) container.querySelectorAll('[data-row]').forEach((t) => (t.onclick = () => onRow(+t.dataset.row)));
    },
  };
}
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function tableView(headers, rows) {
  return `<details class="tableview"><summary class="small">Table view</summary><div class="hm-wrap"><table class="tbl">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

// ================================================================ 1. trends
function trendsTab(el, papers, params) {
  const level = params.level || 'subfield', mode = params.mode || 'count', top = +(params.top || 15);
  // denominators must only include papers that can carry a label at this level
  const eligible = papers.filter((p) => (level === 'tag' ? p.tags?.length : p.oa_meta?.topics?.length));
  const m = topicYearMatrix(eligible, { level, top });
  const values = m.rows.map((r) => r.counts.map((c, j) => (mode === 'share' ? (m.yearTotals[j] ? c / m.yearTotals[j] : 0) : c)));
  const fmt = (v) => (mode === 'share' ? `${Math.round(v * 100)}%` : v);
  const hm = heatmap({
    rows: m.rows, cols: m.years.map((y) => ({ label: String(y) })), values, fmt,
    colEvery: m.years.length > 25 ? 2 : 1,
    tipFn: (i, j) => `<b>${esc(m.rows[i].label)}</b><br>${m.years[j]}: ${m.rows[i].counts[j]} of ${m.yearTotals[j]} library papers
      ${m.yearTotals[j] ? `(${Math.round((m.rows[i].counts[j] / m.yearTotals[j]) * 100)}%)` : ''}`,
    onRow: level === 'topic' ? (i) => fieldTrend(el, papers, m, i) : null,
  });
  el.innerHTML = `<div class="card">
    ${controls([select('level', LEVELS, level, 'Group by'), select('mode', [['count', 'Number of papers'], ['share', 'Share of that year\'s papers']], mode, 'Colour shows'), select('top', [[10, 'Top 10'], [15, 'Top 15'], [25, 'Top 25']], top, 'Rows')])}
    <h2>${LEVELS.find((l) => l[0] === level)[1]} × publication year</h2>
    <p class="muted small">Each paper counts once, under its primary OpenAlex ${level === 'tag' ? 'tag (all lab tags)' : level}. Rows are ordered by mean publication year, oldest first, so the chart reads as a timeline.
      ${mode === 'count' ? 'Raw counts rise with how much the lab collected that year; switch to “share” to compare years fairly.' : ''}
      ${level === 'topic' ? '<b>Click a topic name</b> to compare its trend in the library with the whole literature.' : ''}</p>
    ${m.rows.length ? hm.html : '<p class="muted">No papers with years and topics.</p>'}
    ${tableView(['', ...m.years], m.rows.map((r) => [r.label, ...r.counts]))}
    <div id="field-trend"></div></div>`;
  hm.bind(el);
  bindControls(el, 'trends', params);
}

async function fieldTrend(el, papers, m, i) {
  const box = el.querySelector('#field-trend');
  const row = m.rows[i];
  const tid = topicIdOf(papers, row.label);
  if (!tid) return;
  box.innerHTML = '<p class="loading">Fetching yearly counts from OpenAlex…</p>';
  try {
    const y0 = m.years[0], y1 = m.years.at(-1);
    const q = (f) => fetch(`${OA}?filter=${f},publication_year:${y0}-${y1}&group_by=publication_year`).then((r) => r.json());
    const [topic, all] = await Promise.all([q(`primary_topic.id:${tid}`), q('type:article|review|preprint')]);
    const tmap = new Map(topic.group_by.map((g) => [+g.key, g.count])), amap = new Map(all.group_by.map((g) => [+g.key, g.count]));
    const lib = m.years.map((y, j) => (m.yearTotals[j] ? row.counts[j] / m.yearTotals[j] : null));
    const fld = m.years.map((y) => (amap.get(y) ? (tmap.get(y) || 0) / amap.get(y) : null));
    // index each series to its own mean over the window (100 = average) so both share one axis
    const idx = (s) => { const v = s.filter((x) => x != null); const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1); return s.map((x) => (x == null || !mean ? null : (x / mean) * 100)); };
    box.innerHTML = `<h3>${esc(row.label)}: library vs. whole literature</h3>
      <p class="muted small">Both lines show the topic's share of papers each year, rescaled so that 100 = that line's own average over ${y0}–${y1}.
        Library = share of the lab's papers from that year; Literature = share of all OpenAlex articles, reviews and preprints from that year.
        Years with few library papers are noisy.</p>
      ${lineChart(m.years, [
        { name: 'Library', cls: 'c1', values: idx(lib), raw: lib.map((x, j) => (x == null ? '–' : `${row.counts[j]}/${m.yearTotals[j]} papers`)) },
        { name: 'Literature', cls: 'c2', values: idx(fld), raw: m.years.map((y) => `${(tmap.get(y) || 0).toLocaleString()} works`) },
      ])}`;
    bindLine(box);
  } catch (err) { box.innerHTML = `<p class="error">OpenAlex: ${esc(err.message)}</p>`; }
}

function lineChart(xs, series) {
  const W = 760, H = 260, l = 44, r = 90, t = 12, b = 28;
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  const rawMax = Math.max(150, ...vals);
  const stepY = [25, 50, 100, 200, 250, 500, 1000].find((st) => rawMax / st <= 6) || 1000;
  const ymax = Math.ceil(rawMax / stepY) * stepY;
  const X = (i) => l + (xs.length > 1 ? (i * (W - l - r)) / (xs.length - 1) : 0), Y = (v) => t + (H - t - b) * (1 - v / ymax);
  const ticks = Array.from({ length: Math.round(ymax / stepY) + 1 }, (_, i) => i * stepY);
  if (!ticks.includes(100)) ticks.push(100);
  const grid = ticks.map((g) => `<line class="grid ${g === 100 ? 'ref' : ''}" x1="${l}" x2="${W - r}" y1="${Y(g)}" y2="${Y(g)}"/><text class="ax" x="${l - 6}" y="${Y(g) + 4}" text-anchor="end">${g}</text>`).join('');
  const xt = xs.map((x, i) => (i % Math.ceil(xs.length / 12) ? '' : `<text class="ax" x="${X(i)}" y="${H - 8}" text-anchor="middle">${x}</text>`)).join('');
  const paths = series.map((s) => {
    let d = '', pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
    const lastI = s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).at(-1);
    const pts = s.values.map((v, i) => (v == null ? '' : `<circle class="pt ${s.cls}" cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3"/>`)).join('');
    return `<path class="line ${s.cls}" d="${d}"/>${pts}${lastI != null ? `<circle class="dot ${s.cls}" cx="${X(lastI)}" cy="${Y(s.values[lastI])}" r="4"/><text class="dlabel" x="${X(lastI) + 8}" y="${Y(s.values[lastI]) + 4}">${esc(s.name)}</text>` : ''}`;
  }).join('');
  const legend = `<div class="hm-legend small">${series.map((s) => `<span class="lg"><i class="sw ${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  const data = JSON.stringify({ xs, series: series.map((s) => ({ name: s.name, values: s.values, raw: s.raw })), l, r, W });
  return `${legend}<div class="hm-wrap"><svg class="linechart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-chart='${esc(data)}'>
    ${grid}${xt}${paths}<line class="xhair" y1="${t}" y2="${H - b}" x1="-10" x2="-10"/><rect class="hit" x="${l}" y="${t}" width="${W - l - r}" height="${H - t - b}"/></svg></div>`;
}

function bindLine(box) {
  const svg = box.querySelector('svg.linechart');
  if (!svg) return;
  const d = JSON.parse(svg.dataset.chart);
  const hit = svg.querySelector('.hit'), xh = svg.querySelector('.xhair');
  hit.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * d.W;
    const i = Math.max(0, Math.min(d.xs.length - 1, Math.round(((sx - d.l) / (d.W - d.l - d.r)) * (d.xs.length - 1))));
    const x = d.l + (d.xs.length > 1 ? (i * (d.W - d.l - d.r)) / (d.xs.length - 1) : 0);
    xh.setAttribute('x1', x); xh.setAttribute('x2', x);
    tip(`<b>${d.xs[i]}</b>${d.series.map((s) => `<br>${esc(s.name)}: ${s.values[i] == null ? '–' : Math.round(s.values[i])} <span class="muted">(${esc(s.raw[i])})</span>`).join('')}`, ev);
  };
  hit.onmouseleave = () => { tip(null); xh.setAttribute('x1', -10); xh.setAttribute('x2', -10); };
}

// ================================================================ 2. geography
function geoTab(el, papers, params) {
  const by = params.by || 'country', level = params.level === 'tag' ? 'field' : params.level || 'field';
  const m = groupTopicMatrix(papers, { by, level, topRows: by === 'country' ? 15 : 20, topCols: 12 });
  const rowName = (r) => (by === 'country' ? `${regionName(r.key)}` : r.label);
  const hm = heatmap({
    rows: m.rows, cols: m.cols, values: m.values, rowLabel: (r) => `${rowName(r)} (${r.total})`,
    tipFn: (i, j) => `<b>${esc(rowName(m.rows[i]))}</b> × <b>${esc(m.cols[j].label)}</b><br>${m.values[i][j]} papers with ≥1 author there
      <br><span class="muted">${Math.round((m.values[i][j] / m.rows[i].total) * 100)}% of this ${by}'s ${m.rows[i].total} library papers</span>`,
  });
  el.innerHTML = `<div class="card">
    ${controls([select('by', [['country', 'Country'], ['institution', 'Institution']], by, 'Rows'), select('level', LEVELS.filter((l) => l[0] !== 'tag'), level, 'Columns')])}
    <h2>Research topics by ${by}</h2>
    <p class="muted small">Whole counting: a paper counts once for every distinct ${by} among its authors' affiliations, so row totals add up to more than ${m.nPapers} papers.
      Rows are the ${m.rows.length} ${by === 'country' ? 'countries' : 'institutions'} most represented in the library; columns are the primary OpenAlex ${level}s.
      For consortium papers only the first 20 and last 10 authors are stored.</p>
    ${m.rows.length ? hm.html : '<p class="muted">No affiliation data yet.</p>'}
    ${tableView([by, 'papers', ...m.cols.map((c) => c.label)], m.rows.map((r, i) => [rowName(r), r.total, ...m.values[i]]))}
  </div>`;
  hm.bind(el);
  bindControls(el, 'geo', params);
}

// ================================================================ 3. groups
const GROUP_SHAPES = ['dot', 'square', 'triangle', 'diamond', 'star', 'triangleDown', 'hexagon'];
const shapeGlyph = { dot: '●', square: '■', triangle: '▲', diamond: '◆', star: '★', triangleDown: '▼', hexagon: '⬢' };

function groupsTab(el, papers, params) {
  const minPapers = +(params.min || 2), maxAuthors = +(params.max || 30);
  const r = collaborationGroups(papers, { minPapers, maxAuthors, minSize: 2 });
  const titles = new Map(cache.map((p) => [p.id, p]));
  const css = getComputedStyle(document.documentElement);
  // Networks are an all-pairs colour form: only the first 3 categorical slots stay CVD-safe there,
  // so groups 4–7 are grey and told apart by shape; the rest are grey dots ("Other").
  const colors = [1, 2, 3].map((i) => css.getPropertyValue(`--cat-${i}`).trim());
  const other = css.getPropertyValue('--cat-other').trim();
  const styleOf = (gi) => (gi < 3 ? { color: colors[gi], shape: GROUP_SHAPES[gi] } : gi < 7 ? { color: other, shape: GROUP_SHAPES[gi] } : { color: other, shape: 'dot' });

  el.innerHTML = `<div class="card">
    ${controls([
      select('min', [[1, '≥ 1 paper'], [2, '≥ 2 papers'], [3, '≥ 3 papers'], [5, '≥ 5 papers']], minPapers, 'Authors with'),
      select('max', [[15, '≤ 15 authors'], [30, '≤ 30 authors'], [100, '≤ 100 authors']], maxAuthors, 'Use papers with'),
    ])}
    <h2>Collaborative groups</h2>
    <p class="muted small">Co-authorship among authors (OpenAlex author IDs) who have ${minPapers}+ papers in the library. Links connect people who co-authored a library paper;
      thicker links mean more joint papers. Groups are found by Louvain community detection${r.groups.length > 1 ? ` (modularity Q = ${r.modularity.toFixed(2)}; values above ~0.3 indicate clear group structure)` : ''}.
      Papers with more than ${maxAuthors} authors are left out of the links, because large consortia would otherwise merge everyone into one group.
      OpenAlex's author disambiguation is imperfect: one person can appear as two authors, or two people as one.</p>
    ${r.groups.length ? `
      <div class="hm-legend small">${r.groups.slice(0, 7).map((g, i) => `<span class="lg"><span style="color:${styleOf(i).color}">${shapeGlyph[styleOf(i).shape]}</span> Group ${i + 1}</span>`).join('')}
        ${r.groups.length > 7 ? `<span class="lg"><span style="color:${other}">●</span> Other groups (${r.groups.length - 7})</span>` : ''}</div>
      <div id="co-net" class="graph-canvas" style="height:520px"></div>
      <div class="group-cards">${r.groups.slice(0, 20).map((g, i) => `
        <div class="gcard" data-g="${i}">
          <h3><span style="color:${styleOf(i).color}">${shapeGlyph[styleOf(i).shape]}</span> Group ${i + 1}
            <small class="muted">${g.members.length} authors · ${g.nPapers} papers${g.years ? ` · ${g.years[0]}–${g.years[1]}` : ''}</small></h3>
          <p class="small"><b>Key people:</b> ${g.members.slice(0, 6).map((m) => `${esc(m.name)} (${m.papers.size})`).join(', ')}${g.members.length > 6 ? '…' : ''}</p>
          <p class="small"><b>Institutions:</b> ${g.institutions.map(([n]) => esc(n)).join('; ') || '–'}</p>
          <p class="small"><b>Countries:</b> ${g.countries.map(([c]) => esc(regionName(c))).join(', ') || '–'} · <b>Subfields:</b> ${g.topics.map(([t]) => esc(t)).join('; ') || '–'}</p>
          <details><summary class="small">Library papers</summary><ul class="small">${g.paperIds.slice(0, 30).map((id) => `<li><a href="#/paper/${id}">${esc(titles.get(id)?.title || id)}</a></li>`).join('')}</ul></details>
        </div>`).join('')}</div>`
      : '<p class="muted">No co-authorship groups at these settings. Try “≥ 1 paper”, or fetch OpenAlex metadata for more papers.</p>'}
    ${r.isolated ? `<p class="muted small">${r.isolated} frequent authors have no co-authors in the library at these settings and are not shown.</p>` : ''}
  </div>`;
  bindControls(el, 'groups', params);
  if (!r.groups.length || !window.vis) return;

  const inGroup = new Map();
  r.groups.forEach((g, i) => g.members.forEach((m) => inGroup.set(m.id, i)));
  const fg = css.getPropertyValue('--fg').trim();
  const nodes = [...inGroup].map(([id, gi]) => {
    const m = r.groups[gi].members.find((x) => x.id === id);
    const st = styleOf(gi);
    return { id, label: m.name, shape: st.shape, color: { background: st.color, border: css.getPropertyValue('--card').trim() }, borderWidth: 2,
      size: 7 + Math.min(18, m.papers.size * 2), font: { color: fg, size: 11 }, title: `${m.name}\n${m.papers.size} library papers\nGroup ${gi + 1}` };
  });
  const edges = r.edges.filter((e) => inGroup.has(e.a) && inGroup.has(e.b))
    .map((e, i) => ({ id: i, from: e.a, to: e.b, width: Math.min(6, e.weight), color: { color: inGroup.get(e.a) === inGroup.get(e.b) ? styleOf(inGroup.get(e.a)).color : other, opacity: 0.5 }, title: `${e.weight} joint papers` }));
  const net = new vis.Network(el.querySelector('#co-net'), { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) }, {
    physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -40, springLength: 60 }, stabilization: { iterations: 300 } },
    interaction: { hover: true, tooltipDelay: 120 }, edges: { smooth: false }, layout: { improvedLayout: nodes.length < 300 },
  });
  net.once('stabilizationIterationsDone', () => net.setOptions({ physics: false }));
  window.addEventListener('hashchange', () => net.destroy(), { once: true });
  el.querySelectorAll('.gcard').forEach((c) => (c.onclick = (ev) => {
    if (ev.target.closest('a,summary')) return;
    const ids = r.groups[+c.dataset.g].members.map((m) => m.id);
    net.selectNodes(ids); net.fit({ nodes: ids, animation: true });
  }));
}

// ================================================================ 4. missing works
function missingTab(el, papers) {
  const enriched = papers.filter((p) => p.openalex_id);
  el.innerHTML = `<div class="card">
    <h2>Relevant works not in the library</h2>
    <p class="muted small">Three independent signals, from strongest to weakest. All are based on the ${enriched.length} library papers found in OpenAlex. Each list leaves out works already in the library.</p>
    <div class="miss-grid">
      <section><h3>Foundational: cited by several of our papers</h3>
        <p class="muted small">Works that appear in the reference lists of at least 2 library papers. Often key methods or landmark results the lab relies on but never filed.</p>
        <div id="m-cited"></div></section>
      <section><h3>Emerging: new papers citing several of ours</h3>
        <p class="muted small">Works published since <select id="m-since">${[1, 2, 3, 5].map((y) => `<option value="${y}" ${y === 2 ? 'selected' : ''}>${new Date().getFullYear() - y + 1}</option>`).join('')}</select>
          that cite at least 2 library papers: recent work building on what the lab reads.</p>
        <button class="small" id="m-cite-go">Search OpenAlex</button><div id="m-citing"></div></section>
      <section><h3>Suggested by OpenAlex</h3>
        <p class="muted small">Works that OpenAlex's own relatedness algorithm (based on shared concepts) lists for at least 2 library papers. The weakest signal.</p>
        <div id="m-related"></div></section>
    </div></div>`;

  const inLib = new Set(enriched.map((p) => p.openalex_id));
  renderCandidates(el.querySelector('#m-cited'), frequentlyCited(enriched), 'cited by', 'library papers', inLib);
  renderCandidates(el.querySelector('#m-related'), frequentlyRelated(enriched), 'related to', 'library papers', inLib);
  el.querySelector('#m-cite-go').onclick = async (e) => {
    e.target.disabled = true;
    const box = el.querySelector('#m-citing');
    const since = new Date().getFullYear() - +el.querySelector('#m-since').value + 1;
    box.innerHTML = '<p class="loading">Searching OpenAlex…</p>';
    try {
      const ids = [...inLib];
      const seen = new Map();
      for (let i = 0; i < Math.min(ids.length, 1000); i += 50) {
        const url = `${OA}?filter=cites:${ids.slice(i, i + 50).join('|')},from_publication_date:${since}-01-01&per-page=200&sort=cited_by_count:desc` +
          '&select=id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,referenced_works';
        const j = await (await fetch(url)).json();
        for (const w of j.results || []) seen.set(shortOa(w.id), { ...oaWork(w), refs: (w.referenced_works || []).map(shortOa) });
      }
      const ranked = rankCiting([...seen.values()], enriched).slice(0, 40);
      renderCandidates(box, ranked, 'cites', 'library papers', inLib, true);
    } catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
    e.target.disabled = false;
  };
}

function oaWork(w) {
  return {
    id: shortOa(w.id), title: w.display_name || '(untitled)', doi: normalizeDoi(w.doi), year: w.publication_year,
    venue: w.primary_location?.source?.display_name || null, cited_by: w.cited_by_count,
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
  };
}

async function renderCandidates(box, cands, verb, unit, inLib, haveMeta = false) {
  if (!cands.length) { box.innerHTML = '<p class="muted small">None found (needs at least 2 library papers pointing to the same work).</p>'; return; }
  let works = cands;
  if (!haveMeta) {
    box.innerHTML = '<p class="loading">Loading details…</p>';
    try {
      const meta = new Map();
      for (let i = 0; i < cands.length; i += 50) {
        const ids = cands.slice(i, i + 50).map((c) => c.id);
        const j = await (await fetch(`${OA}?filter=openalex:${ids.join('|')}&per-page=50&select=id,doi,display_name,publication_year,authorships,primary_location,cited_by_count`)).json();
        for (const w of j.results || []) meta.set(shortOa(w.id), oaWork(w));
      }
      works = cands.map((c) => ({ ...meta.get(c.id), ...c })).filter((w) => w.title);
    } catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
  }
  const max = Math.max(...works.map((w) => w.count));
  box.innerHTML = `<ol class="cands">${works.map((w, i) => `
    <li>
      <div class="cbar" title="${verb} ${w.count} ${unit}"><span class="track"><span style="width:${(w.count / max) * 100}%"></span></span><b>${w.count}</b></div>
      <div class="cbody">
        <a target="_blank" rel="noopener" href="${w.doi ? 'https://doi.org/' + esc(w.doi) : 'https://openalex.org/' + esc(w.id)}">${esc(w.title)}</a>
        <div class="meta">${esc(fmtAuthors(w.authors))} ${w.year || ''}${w.venue ? ' · <i>' + esc(w.venue) + '</i>' : ''}
          · cited ${(w.cited_by ?? 0).toLocaleString()}× overall · ${verb} ${w.count} ${unit}</div>
      </div>
      <button class="small" data-add="${i}">Add</button>
    </li>`).join('')}</ol>`;
  box.querySelectorAll('[data-add]').forEach((b) => (b.onclick = async () => {
    const w = works[+b.dataset.add];
    b.disabled = true;
    try {
      const p = cleanPaper({
        title: w.title, year: w.year, journal: w.venue, doi: w.doi, url: w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}`,
        authors: w.authors.map((n) => { const parts = n.trim().split(/\s+/); return parts.length > 1 ? `${parts.pop()}, ${parts.join(' ')}` : n; }).join('; '),
        tags: ['suggested'],
      });
      const ex = await findExisting(p);
      if (ex) { b.textContent = 'In library'; return; }
      check(await sb.from('papers').insert({ ...p, openalex_id: w.id }));
      inLib.add(w.id);
      b.textContent = '✓ Added';
      toast('Added. Tagged “suggested”; run Build links to fetch its references.', 'ok', 5000);
    } catch (err) { fail(err, 'Add'); b.disabled = false; }
  }));
}

const fmtAuthors = (a = []) => (a.length > 3 ? `${a.slice(0, 3).join(', ')} et al.` : a.join(', '));
