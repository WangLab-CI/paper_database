import { sb, state, check, personName } from '../db.js';
import { esc, md, fmtDate, authorsShort, tagChips } from '../util.js';
import { latestTechEvents } from './products.js';

export async function homeView(root) {
  const uid = state.user.id;
  const [papers, projects, updates, mine, counts] = await Promise.all([
    sb.from('papers').select('id,title,authors,year,journal,tags,added_by,created_at').order('created_at', { ascending: false }).limit(10),
    sb.from('projects').select('id,title,status,summary,updated_at,last_edited_by').not('status', 'eq', 'archived').order('updated_at', { ascending: false }).limit(8),
    sb.from('project_updates').select('id,body,created_at,author_id,project:projects(id,title)').order('created_at', { ascending: false }).limit(8),
    sb.from('paper_notes').select('reading_status,paper:papers(id,title,authors,year)').eq('user_id', uid).in('reading_status', ['to_read', 'reading']).order('updated_at', { ascending: false }).limit(10),
    Promise.all([
      sb.from('papers').select('id', { count: 'exact', head: true }),
      sb.from('projects').select('id', { count: 'exact', head: true }),
    ]),
  ]).then((rs) => rs.map((r) => (Array.isArray(r) ? r.map((x) => x.count) : check(r))));

  const name = (state.profile.full_name || '').split(' ')[0] || '';
  root.innerHTML = `
    <section class="hero">
      <h1>Welcome${name ? ', ' + esc(name) : ''}</h1>
      <form id="quick" class="quick">
        <input name="q" placeholder="Add a paper: paste a DOI, PMID or arXiv ID…  or search the library" autocomplete="off">
        <button class="primary">Go</button>
      </form>
      <div class="stats">
        <a href="#/papers"><b>${counts[0] ?? 0}</b> papers</a>
        <a href="#/projects"><b>${counts[1] ?? 0}</b> projects</a>
        <a href="#/admin"><b>${[...state.profiles.values()].filter((p) => p.role !== 'pending').length}</b> members</a>
      </div>
    </section>
    <div class="grid-2">
      <section class="card">
        <h2>Recently added papers</h2>
        ${papers.length ? `<ul class="list">${papers.map((p) => `
          <li><a href="#/paper/${p.id}">${esc(p.title)}</a>
            <div class="meta">${esc(authorsShort(p.authors))} ${p.year ? '· ' + p.year : ''} ${p.journal ? '· <i>' + esc(p.journal) + '</i>' : ''}
            · added by ${esc(personName(p.added_by))} ${fmtDate(p.created_at)}</div>
            <div>${tagChips(p.tags)}</div></li>`).join('')}</ul>` : '<p class="muted">No papers yet. <a href="#/import">Add or import some.</a></p>'}
      </section>
      <section class="card">
        <h2>Active projects</h2>
        ${projects.length ? `<ul class="list">${projects.map((p) => `
          <li><span class="status s-${p.status}">${p.status}</span> <a href="#/project/${p.id}">${esc(p.title)}</a>
            <div class="meta">updated ${fmtDate(p.updated_at)} by ${esc(personName(p.last_edited_by))}</div></li>`).join('')}</ul>`
          : '<p class="muted">No projects yet. <a href="#/projects">Start one.</a></p>'}
        <h2>Latest project updates</h2>
        ${updates.length ? `<ul class="list">${updates.map((u) => `
          <li><a href="#/project/${u.project?.id}">${esc(u.project?.title)}</a>
            <div class="meta">${esc(personName(u.author_id))} · ${fmtDate(u.created_at)}</div>
            <div class="md clamp">${md(u.body)}</div></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
      </section>
      <section class="card">
        <h2>My reading list</h2>
        ${mine.length ? `<ul class="list">${mine.filter((n) => n.paper).map((n) => `
          <li><span class="rs rs-${n.reading_status}">${n.reading_status.replace('_', ' ')}</span>
            <a href="#/paper/${n.paper.id}">${esc(n.paper.title)}</a>
            <div class="meta">${esc(authorsShort(n.paper.authors))} ${n.paper.year || ''}</div></li>`).join('')}</ul>`
          : '<p class="muted">Mark papers as “to read” on their page to build your list.</p>'}
        <h2>Technology updates</h2>
        <div id="tech-updates"><p class="muted small">Loading…</p></div>
      </section>
    </div>`;
  latestTechEvents(6).then((evs) => {
    const box = root.querySelector('#tech-updates');
    if (!box) return;
    box.innerHTML = evs.length ? `<ul class="list">${evs.map((e) => `<li><a href="#/tech/${e.product?.id}"><b>${esc(e.product?.name || '')}</b></a> ·
      ${e.url ? `<a target="_blank" rel="noopener" href="${esc(e.url)}">${esc(e.title)}</a>` : esc(e.title)}
      <div class="meta">${fmtDate(e.event_date || e.created_at)}</div></li>`).join('')}</ul><p class="small"><a href="#/tech">All technology updates →</a></p>`
      : '<p class="muted small">Track platforms and kits under <a href="#/tech">Tech</a>.</p>';
  }).catch(() => {});

  root.querySelector('#quick').onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return;
    const isId = /10\.\d{4,9}\/|^\d{1,9}$|^pmid|arxiv|^\d{4}\.\d{4,5}|^PMC\d+/i.test(q);
    location.hash = isId ? `#/import?id=${encodeURIComponent(q)}` : `#/papers?q=${encodeURIComponent(q)}`;
  };
}
