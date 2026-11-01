// Entry point: authentication gate + hash router.
import { sb, configured, state, loadProfiles } from './db.js';
import { esc, fail, toast } from './util.js';
import { homeView } from './views/home.js';
import { papersView, paperView } from './views/papers.js';
import { projectsView, projectView } from './views/projects.js';
import { graphView } from './views/graph.js';
import { importView } from './views/import.js';
import { adminView, meView } from './views/admin.js';

const cfg = window.PORTAL_CONFIG || {};
const labName = cfg.LAB_NAME && !cfg.LAB_NAME.startsWith('__') ? cfg.LAB_NAME : 'Lab Paper Portal';
const providers = (cfg.AUTH_PROVIDERS && !String(cfg.AUTH_PROVIDERS).startsWith('__') ? String(cfg.AUTH_PROVIDERS) : 'github,email')
  .split(',').map((s) => s.trim()).filter(Boolean);
document.title = labName;
document.getElementById('lab-name').textContent = labName;

const app = document.getElementById('app');

const routes = [
  [/^\/?$/, homeView, 'home'],
  [/^\/papers$/, papersView, 'papers'],
  [/^\/paper\/([\w-]+)$/, paperView, 'papers'],
  [/^\/projects$/, projectsView, 'projects'],
  [/^\/project\/([\w-]+)$/, projectView, 'projects'],
  [/^\/graph$/, graphView, 'graph'],
  [/^\/import$/, importView, 'import'],
  [/^\/admin$/, adminView, 'admin'],
  [/^\/me$/, meView, ''],
];

let renderSeq = 0;
async function route() {
  if (!state.profile || state.profile.role === 'pending') return;
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  for (const [re, view, nav] of routes) {
    const m = path.match(re);
    if (!m) continue;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    const seq = ++renderSeq;
    app.innerHTML = '<div class="loading">Loading…</div>';
    app.className = `view-${nav || 'me'}`;
    try {
      await view(app, { id: m[1], params, isCurrent: () => seq === renderSeq });
    } catch (e) {
      fail(e, 'Page failed to load');
      app.innerHTML = `<div class="card error-card"><h3>Something went wrong</h3><pre>${esc(e.message || e)}</pre></div>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  app.innerHTML = '<div class="card"><h3>Not found</h3><a href="#/">Go home</a></div>';
}

// Errors Supabase appends to the redirect URL (e.g. expired email link).
function authReturnError() {
  const p = new URLSearchParams(window.__AUTH_RETURN || '');
  const code = p.get('error_code') || p.get('error');
  if (!code) {
    // Tokens came back but no session was created
    if (/access_token=|[?&]code=/.test(window.__AUTH_RETURN || '')) {
      window.__AUTH_RETURN = '';
      return 'Sign-in details were returned but no session could be created. Check Supabase → Authentication → URL Configuration, then try again.';
    }
    return '';
  }
  window.__AUTH_RETURN = '';
  history.replaceState(null, '', location.pathname);
  if (code === 'otp_expired')
    return 'That sign-in link had already been used or expired. Institutional mail scanners often open links before you do — ' +
      'request a new email and type the 6-digit code instead of clicking the link.';
  return `Sign-in failed: ${(p.get('error_description') || code).replace(/\+/g, ' ')}`;
}

function loginScreen(msg = '') {
  document.getElementById('topbar').hidden = true;
  const redirect = location.origin + location.pathname;
  msg = msg || authReturnError();
  app.className = 'view-login';
  app.innerHTML = `
    <div class="login card">
      <h1>📚 ${esc(labName)}</h1>
      <p class="muted">Papers, project ideas and how they connect. Members only.</p>
      ${msg ? `<p class="notice error">${esc(msg)}</p>` : ''}
      ${providers.includes('github') ? '<button class="primary wide" data-p="github">Sign in with GitHub</button>' : ''}
      ${providers.includes('google') ? '<button class="primary wide" data-p="google">Sign in with Google</button>' : ''}
      ${providers.includes('email') ? `
        <div class="sep"><span>or by email</span></div>
        <form id="magic">
          <input type="email" name="email" required placeholder="you@institute.ac.uk" autocomplete="email">
          <button class="wide">Email me a sign-in link</button>
        </form>
        <form id="otp" hidden>
          <p class="small">Check the email sent to <b id="otp-email"></b> and click its link.
            If the email shows a 6-digit code, you can enter it here instead.</p>
          <input name="token" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" required placeholder="123456">
          <button class="primary wide">Verify code</button>
          <button type="button" class="ghost small" id="otp-back">Use a different email</button>
        </form>` : ''}
    </div>`;
  app.querySelectorAll('[data-p]').forEach((b) => (b.onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider: b.dataset.p, options: { redirectTo: redirect } });
    if (error) fail(error, 'Sign-in');
  }));
  const f = app.querySelector('#magic');
  const o = app.querySelector('#otp');
  if (!f) return;
  let email = '';
  f.onsubmit = async (e) => {
    e.preventDefault();
    email = f.email.value.trim().toLowerCase();
    const btn = f.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
    btn.disabled = false;
    if (error) return fail(error, 'Email sign-in');
    f.hidden = true;
    o.hidden = false;
    o.querySelector('#otp-email').textContent = email;
    o.token.focus();
  };
  o.onsubmit = async (e) => {
    e.preventDefault();
    const btn = o.querySelector('button.primary');
    btn.disabled = true;
    const { error } = await sb.auth.verifyOtp({ email, token: o.token.value.trim(), type: 'email' });
    btn.disabled = false;
    if (error) return fail(error, 'Code');
    // onAuthStateChange(SIGNED_IN) takes over from here
  };
  o.querySelector('#otp-back').onclick = () => { o.hidden = true; f.hidden = false; };
}

function pendingScreen() {
  document.getElementById('topbar').hidden = true;
  app.className = 'view-login';
  app.innerHTML = `
    <div class="login card">
      <h2>Awaiting access</h2>
      <p>You are signed in as <b>${esc(state.user.email)}</b>, but this address is not on the lab's member list yet.</p>
      <p class="muted">Ask a portal admin to add this email on the Admin page, then reload. If you signed in with GitHub,
      the email used is your GitHub <i>primary</i> email.</p>
      <div class="row"><button id="reload">Reload</button><button class="ghost" id="out">Sign out</button></div>
    </div>`;
  app.querySelector('#reload').onclick = () => location.reload();
  app.querySelector('#out').onclick = () => sb.auth.signOut();
}

async function onSession(session) {
  if (!session) {
    state.user = state.profile = null;
    return loginScreen();
  }
  if (state.user?.id === session.user.id && state.profile) return;
  state.user = session.user;
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) return fail(error, 'Profile');
  if (!data) return loginScreen('Your profile was not created. Has supabase/schema.sql been run?');
  state.profile = data;
  if (data.role === 'pending') return pendingScreen();
  await loadProfiles();
  document.getElementById('topbar').hidden = false;
  document.getElementById('user-name').innerHTML = `<a href="#/me">${esc(data.full_name || data.email)}</a>`;
  document.getElementById('nav-admin').hidden = data.role !== 'admin';
  // Clean OAuth/magic-link tokens out of the URL
  if (/access_token|code=/.test(location.href)) history.replaceState(null, '', location.pathname + '#/');
  route();
}

if (!configured) {
  app.innerHTML = `<div class="login card"><h2>Portal not configured</h2>
    <p>Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> as GitHub repository variables
    (Settings → Secrets and variables → Actions → Variables) and re-run the deploy workflow,
    or edit <code>site/js/config.js</code>. See README.</p></div>`;
} else {
  document.getElementById('btn-signout').onclick = async () => { await sb.auth.signOut(); toast('Signed out'); };
  sb.auth.onAuthStateChange((_evt, session) => { setTimeout(() => onSession(session), 0); });
  window.addEventListener('hashchange', route);
}
