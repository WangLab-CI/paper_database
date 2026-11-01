import { sb, state, check, loadProfiles } from '../db.js';
import { esc, toast, fail, fmtDate } from '../util.js';
import { confirmDialog } from '../ui.js';

export async function adminView(root) {
  if (state.profile.role !== 'admin') {
    const people = [...state.profiles.values()].filter((p) => p.role !== 'pending');
    root.innerHTML = `<div class="card"><h1>Lab members</h1><ul class="list">${people.map((p) => `<li>${esc(p.full_name || p.email)} <span class="muted">${esc(p.email)} · ${p.role}</span></li>`).join('')}</ul></div>`;
    return;
  }
  const [allow, profiles] = await Promise.all([
    sb.from('allowlist').select('*').order('email').then(check),
    loadProfiles(),
  ]);
  const signedUp = new Map(profiles.map((p) => [p.email, p]));
  const pending = profiles.filter((p) => p.role === 'pending');

  root.innerHTML = `
    <h1>Admin</h1>
    ${pending.length ? `<section class="card notice-card"><h2>Waiting for access (${pending.length})</h2>
      <ul class="list">${pending.map((p) => `<li>${esc(p.full_name || '')} <b>${esc(p.email)}</b> <span class="muted">signed in ${fmtDate(p.created_at)}</span>
        <button class="small primary" data-approve="${esc(p.email)}">Approve as member</button></li>`).join('')}</ul></section>` : ''}
    <section class="card">
      <h2>Member allowlist</h2>
      <p class="muted">Only these emails can see the portal. For GitHub sign-in this must be the user's GitHub <i>primary</i> email.</p>
      <form id="add" class="row wrap">
        <input name="email" type="email" required placeholder="new.member@institute.ac.uk">
        <select name="role"><option>member</option><option>admin</option></select>
        <button class="primary">Add</button>
      </form>
      <table class="tbl"><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Signed up</th><th></th></tr></thead><tbody>
        ${allow.map((a) => {
          const p = signedUp.get(a.email);
          return `<tr><td>${esc(a.email)}</td><td>${esc(p?.full_name || '')}</td>
            <td><select data-role="${esc(a.email)}"><option ${a.role === 'member' ? 'selected' : ''}>member</option><option ${a.role === 'admin' ? 'selected' : ''}>admin</option></select></td>
            <td>${p ? fmtDate(p.created_at) : '<span class="muted">not yet</span>'}</td>
            <td>${a.email === state.profile.email ? '<span class="muted small">you</span>' : `<button class="ghost small danger" data-remove="${esc(a.email)}">remove</button>`}</td></tr>`;
        }).join('')}
      </tbody></table>
    </section>`;

  const reload = () => adminView(root);
  const addEmail = async (email, role = 'member') => {
    try { check(await sb.from('allowlist').upsert({ email: email.trim().toLowerCase(), role, added_by: state.user.id })); toast(`${email} added`, 'ok'); reload(); }
    catch (err) { fail(err, 'Add'); }
  };
  root.querySelector('#add').onsubmit = (e) => { e.preventDefault(); addEmail(e.target.email.value, e.target.role.value); };
  root.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => addEmail(b.dataset.approve)));
  root.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => {
    try { check(await sb.from('allowlist').update({ role: s.value }).eq('email', s.dataset.role)); toast('Role updated', 'ok'); } catch (err) { fail(err); }
  }));
  root.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(`Remove ${b.dataset.remove}? They lose access immediately; their contributions remain.`))) return;
    try { check(await sb.from('allowlist').delete().eq('email', b.dataset.remove)); reload(); } catch (err) { fail(err); }
  }));
}

export async function meView(root) {
  const p = state.profile;
  root.innerHTML = `
    <div class="card narrow">
      <h1>My profile</h1>
      <form id="me">
        <label>Display name<input name="full_name" value="${esc(p.full_name || '')}" required></label>
        <p class="muted">Email: ${esc(p.email)} · Role: ${p.role}</p>
        <div class="row end"><button class="primary">Save</button></div>
      </form>
    </div>`;
  root.querySelector('#me').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const row = check(await sb.from('profiles').update({ full_name: e.target.full_name.value.trim() }).eq('id', p.id).select().single());
      state.profile = row;
      await loadProfiles();
      document.getElementById('user-name').innerHTML = `<a href="#/me">${esc(row.full_name)}</a>`;
      toast('Saved', 'ok');
    } catch (err) { fail(err); }
  };
}
