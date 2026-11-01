// Browser smoke test: drives every view of the portal against the in-memory
// mock client. Usage:
//   LIBS_DIR=/path/with/npm-packed/libs node tests/e2e/smoke.mjs
// LIBS_DIR must contain vis-network-9.1.9/, marked-12.0.2/, dompurify-3.1.6/
// (unpacked `npm pack` tarballs) so no CDN access is needed.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');  // pre-installed globally or via npm i -D playwright
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, '../../site');
const LIBS = process.env.LIBS_DIR;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(SITE, p);
  if (!f.startsWith(SITE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p === '/js/config.js') body = Buffer.from(String(body).replace('__SUPABASE_URL__', 'https://mock.supabase.co').replace('__SUPABASE_ANON_KEY__', 'anon').replace('__LAB_NAME__', 'Test Lab'));
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(body);
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}/`;

const CDN = {
  '@supabase/supabase-js@2.45.4/+esm': path.join(here, 'mock-supabase.js'),
  'vis-network@9.1.9/standalone/umd/vis-network.min.js': `${LIBS}/vis-network-9.1.9/package/standalone/umd/vis-network.min.js`,
  'marked@12.0.2/marked.min.js': `${LIBS}/marked-12.0.2/package/marked.min.js`,
  'dompurify@3.1.6/dist/purify.min.js': `${LIBS}/dompurify-3.1.6/package/dist/purify.min.js`,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.route('https://cdn.jsdelivr.net/npm/**', (route) => {
  const key = route.request().url().split('/npm/')[1];
  const file = CDN[key];
  if (!file) return route.abort();
  route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
});

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);
const shot = (n) => page.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', `portal-${n}.png`), fullPage: false });
const go = async (hash) => { await page.goto(BASE + hash); await page.waitForFunction(() => !document.querySelector('#app > .loading')); };
const toastText = () => page.locator('#toasts').innerText();

try {
  // signed-out visitor returning from an expired magic link
  await page.goto(BASE + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await page.waitForSelector('text=already been used or expired');
  await page.fill('#magic [name=email]', 'pi@lab.org');
  await page.click('#magic button');
  await page.waitForSelector('#otp:not([hidden])');
  await page.fill('#otp [name=token]', '000000');
  await page.click('#otp button.primary');
  await page.waitForSelector('.toast.error');
  await page.fill('#otp [name=token]', '123456');
  await page.click('#otp button.primary');
  await page.waitForSelector('text=Welcome');
  errors.length = 0;   // the wrong-code toast is an expected error
  ok('expired link explained; 6-digit code sign-in works');

  await go('#/');
  await page.waitForSelector('text=Welcome');
  ok('home renders, admin logged in');
  await shot('home');

  await go('#/papers');
  await page.waitForSelector('.paper-row');
  if ((await page.locator('.paper-row').count()) !== 2) throw new Error('expected 2 papers');
  await page.fill('#filters [name=q]', 'spatial');
  await page.press('#filters [name=q]', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1);
  ok('paper list + search');
  await page.click('.tagbar a.tag >> nth=0');
  await page.waitForSelector('.tag.active');
  ok('tag filter');

  await go('#/papers');
  await page.click('.paper-row a.title >> text=TP53');
  await page.waitForSelector('.paper-detail');
  await page.selectOption('#my-note [name=reading_status]', 'reading');
  await page.selectOption('#my-note [name=rating]', '4');
  await page.fill('#my-note textarea', '**Key** finding: <script>alert(1)</script>');
  await page.click('#my-note button.primary');
  await page.waitForSelector('#del-note');
  ok('save personal note on paper');
  await shot('paper');

  await go('#/import');
  await page.setInputFiles('#file', { name: 'lib.bib', mimeType: 'text/plain', buffer: Buffer.from(
    `@article{a, title={TP53 loss drives organoid fitness}, doi={10.1/a}, year=2021}
     @article{b, title={New paper on CAR-T}, author={Wang, G and Li, X}, journal={Science}, year={2025}, keywords={car-t, immunotherapy}, doi={10.9/new}}
     @article{c, title={Another with organoids}, author={Kim, H}, year={2022}, keywords={organoids}}`) });
  await page.waitForSelector('#go');
  const summary = await page.locator('#bulk-out p').first().innerText();
  if (!/3 references parsed · 2 new/.test(summary.replace(/\s+/g, ' '))) throw new Error('bad import summary: ' + summary);
  await page.fill('#bulk-tags', 'zotero');
  await page.click('#go');
  await page.waitForSelector('#bulk-out .ok');
  ok('BibTeX bulk import with duplicate detection');

  await go('#/papers?tag=zotero');
  if ((await page.locator('.paper-row').count()) !== 2) throw new Error('imported papers not tagged');
  ok('imported papers carry bulk tag');

  await go('#/projects');
  await page.waitForSelector('.pcard');
  await page.click('#new');
  await page.fill('.modal [name=title]', 'Spatial PDAC niches');
  await page.fill('.modal [name=summary]', 'Map stromal niches.');
  await page.fill('.modal [name=tags]', 'pdac, spatial');
  await page.click('.modal button.primary');
  await page.waitForSelector('.project-head h1:text("Spatial PDAC niches")');
  ok('create project');

  await page.click('#edit');
  await page.fill('.modal [name=hypothesis]', 'CAF subtypes define immune exclusion zones.');
  await page.fill('.modal [name=change_note]', 'Added hypothesis after lab meeting');
  await page.click('.modal button.primary');
  await page.waitForFunction(() => document.body.innerText.includes('CAF subtypes'));
  ok('edit project → new version');

  await page.click('.tabs a:has-text("Papers")');
  await page.waitForSelector('#add');
  await page.click('#add');
  await page.waitForSelector('.pick');
  await page.click('.pick >> text=Spatial atlas');
  await page.selectOption('.modal [name=relation]', 'supports');
  await page.click('.modal button.primary');
  await page.waitForSelector('.rel-supports');
  ok('link paper to project with relation');

  await page.click('.tabs a:has-text("Timeline")');
  await page.fill('#post textarea', 'Pilot Visium run looks promising.');
  await page.click('#post button');
  await page.waitForSelector('.t-update');
  ok('post timeline update');

  await page.click('.tabs a:has-text("History")');
  await page.waitForSelector('#diff ins');
  const ins = await page.locator('#diff ins').first().innerText();
  if (!ins.includes('CAF')) throw new Error('diff missing insertion');
  ok('history diff shows inserted hypothesis');
  await shot('history');

  // status drag on board
  await go('#/projects');
  await page.dragAndDrop('.pcard:has-text("Spatial PDAC")', '.col[data-status=pilot]');
  await page.waitForSelector('.col[data-status=pilot] .pcard:has-text("Spatial PDAC")');
  ok('drag card to change status');
  await shot('board');

  await go('#/graph');
  await page.waitForSelector('#g-canvas canvas');
  await page.waitForTimeout(1500);
  const nNodes = await page.evaluate(() => document.querySelector('#g-canvas canvas') && true);
  if (!nNodes) throw new Error('graph canvas missing');
  await page.check('[data-type=person]');
  await page.fill('#g-search', 'organoids');
  await page.press('#g-search', 'Enter');
  await page.waitForSelector('#g-info h3');
  ok('graph renders, search selects node');
  await page.click('#g-focus');
  await page.waitForTimeout(800);
  await shot('graph');

  await go('#/admin');
  await page.waitForSelector('text=Waiting for access');
  await page.click('[data-approve="new@x.org"]');
  await page.waitForFunction(() => !document.body.innerText.includes('Waiting for access'));
  ok('admin approves pending user');

  await go('#/me');
  await page.fill('#me [name=full_name]', 'Renamed PI');
  await page.click('#me button');
  await page.waitForSelector('#user-name:has-text("Renamed PI")');
  ok('profile rename');

  // XSS: note body script must not be in DOM as element
  await go('#/papers');
  const scripts = await page.evaluate(() => [...document.querySelectorAll('#app script')].length);
  if (scripts) throw new Error('script injected');
  ok('no script injection');

  if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
  console.log(`\nALL ${step} SMOKE STEPS PASSED`);
} catch (e) {
  console.error('\nFAILED at step', step + 1, '\n', e.message, '\n', errors.join('\n'));
  await shot('failure');
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
