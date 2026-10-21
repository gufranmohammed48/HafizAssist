// Explicitly requested account UI checks. No real accounts or browser profile.
// Run from repo root with bundled Playwright or PLAYWRIGHT_PACKAGE set.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = process.cwd();
const point = (page = 4, word = 0) => ({ schema: 1, position: { page, surah: 2, ayah: 17, word, bismillah: false }, totals: { correct: 2, reviewed: 1 }, updatedAt: Date.now() });
const member = { id: 'local:mock-user-1', name: 'Test Reader', username: 'test_reader', provider: 'password', email: '' };
const password = 'Only a synthetic password 123!';
const recoveryCode = 'synthetic-recovery-code-not-a-live-secret';
const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/accounts.css"></head><body><span class="app-version" style="position:fixed;right:8px;top:8px">Test harness</span><script type="module">import { createAccounts } from '/src/accounts.js';window.harness={snapshot:${JSON.stringify(point())},busy:false,restores:[]};window.ui=createAccounts({capture:()=>structuredClone(harness.snapshot),restore:async p=>{harness.restores.push(p);harness.snapshot=p;return true},isBusy:()=>harness.busy});window.harness.ready=true;</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/mobile.html') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    if (['/src/accounts.js', '/src/accounts.css'].includes(req.url)) { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(path.join(root, req.url.slice(1)))); return; }
    res.statusCode = 404; res.end();
  } catch { res.statusCode = 500; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function run(name, fn) {
  try { await fn(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'FAIL', detail: error.message }); console.log('FAIL ' + name + ': ' + error.message); }
}
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: Boolean(options.mobile), hasTouch: Boolean(options.mobile) });
  const state = { user: options.user || null, progress: options.progress || null, version: options.progress ? 1 : 0, calls: [], passwordConfigured: options.passwordConfigured ?? true, failProgress: 0, conflict: false, delay: 0 };
  await context.route('**/api/account/**', async route => {
    const req = route.request(), endpoint = new URL(req.url()).pathname.slice('/api/account'.length), method = req.method();
    let body = null; try { body = req.postDataJSON(); } catch {}
    state.calls.push({ endpoint, method, body, headers: req.headers() });
    if (state.delay && method === 'POST') await new Promise(resolve => setTimeout(resolve, state.delay));
    let status = 200, data = {};
    if (endpoint === '/me') data = { configured: true, passwordConfigured: state.passwordConfigured, googleConfigured: true, user: state.user, csrfToken: state.user ? 'mock-csrf' : null };
    else if (endpoint === '/progress' && state.failProgress) { status = state.failProgress; data = { error: 'session' }; }
    else if (endpoint === '/progress' && method === 'GET') data = { progress: state.progress, version: state.version };
    else if (endpoint === '/progress' && method === 'PUT') {
      if (state.conflict) { status = 409; data = { progress: state.progress, version: ++state.version }; }
      else { state.progress = body.progress; data = { version: ++state.version, updatedAt: Date.now() }; }
    } else if (endpoint === '/register') { state.user = structuredClone(member); data = { user: state.user, csrfToken: 'mock-csrf', recoveryCode }; }
    else if (endpoint === '/password-login') {
      if (body.password !== password) { status = 401; data = { code: 'invalid_credentials' }; }
      else { state.user = structuredClone(member); data = { user: state.user, csrfToken: 'mock-csrf' }; }
    } else if (endpoint === '/recover') { state.user = null; data = { recoveryCode: recoveryCode + '-rotated' }; }
    else if (endpoint === '/password') data = { ok: true, csrfToken: 'mock-csrf' };
    else if (endpoint === '/logout' || endpoint === '/account') { state.user = null; data = { ok: true }; }
    else { status = 404; data = { error: 'unknown' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + (options.mobile ? '/mobile.html' : '/'));
  await page.waitForFunction(() => window.harness?.ready && document.querySelector('.account-status')?.textContent !== 'Checking account…');
  await page.waitForTimeout(40); await page.click('#account-open'); await page.waitForSelector('#account-dialog[open]');
  return { context, page, state, errors, async close() { await context.close(); assert(!errors.length, 'Page errors: ' + errors.join('; ')); } };
}
const action = (page, name) => page.locator(`[data-action="${name}"]`);
async function fill(page, values = {}) {
  const data = { username: 'test_reader', password, confirm: values.password || password, recovery: recoveryCode, current: password, ...values };
  for (const [selector, key] of [['#account-username', 'username'], ['#account-password', 'password'], ['#account-confirm-password', 'confirm'], ['#account-recovery', 'recovery'], ['#account-current-password', 'current']]) {
    const input = page.locator(selector); if (await input.isVisible() && await input.isEnabled()) await input.fill(data[key]);
  }
}
const submit = page => page.locator('.account-auth-form').evaluate(el => el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
const settle = page => page.waitForTimeout(120);
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await run('Signed-out desktop exposes Google and enabled username sign-in', async () => {
    const f = await fixture(); assert(await action(f.page, 'google').isVisible(), 'Google missing'); assert(await f.page.locator('#account-username').isVisible(), 'Username missing'); assert(await action(f.page, 'credentials').isEnabled(), 'Password sign-in disabled'); assert(await f.page.locator('.account-orb-initials').textContent() === '', 'Signed-out initials present'); await f.close();
  });
  await run('Registration rejects malformed username, short password, and mismatched confirmation', async () => {
    const f = await fixture(); await action(f.page, 'register').click();
    for (const values of [{ username: 'ab' }, { password: 'short' }, { confirm: 'Mismatched synthetic password' }]) { await fill(f.page, values); await submit(f.page); await settle(f.page); assert(!f.state.calls.some(c => c.endpoint === '/register'), 'Invalid registration submitted'); assert(await f.page.locator('.account-auth-message').isVisible(), 'Validation message missing'); }
    await f.close();
  });
  await run('Signup normalizes username; recovery acknowledgment blocks close; secrets stay out of storage', async () => {
    const f = await fixture(); await action(f.page, 'register').click(); await fill(f.page, { username: '  TEST_Reader  ' }); await submit(f.page); await f.page.waitForSelector('.account-recovery-once:not([hidden])');
    assert(f.state.calls.find(c => c.endpoint === '/register').body.username === 'test_reader', 'Username not normalized'); assert(await action(f.page, 'code-done').isDisabled(), 'Continue allowed before acknowledgment'); assert(await action(f.page, 'close').isDisabled(), 'Close allowed before acknowledgment'); await f.page.keyboard.press('Escape'); assert(await f.page.locator('#account-dialog').evaluate(el => el.open), 'Escape lost code'); assert(await f.page.locator('.account-code-message').isVisible(), 'Acknowledgment guidance missing'); assert(await f.page.locator('#account-password').inputValue() === '', 'Password remains in field');
    const stored = await f.page.evaluate(() => JSON.stringify({ ...localStorage })); assert(!stored.includes(password) && !stored.includes(recoveryCode), 'Credential written to storage'); await f.page.check('#account-code-saved'); await action(f.page, 'code-done').click(); assert(await f.page.locator('.account-recovery-code').textContent() === '', 'Code remains after acknowledgment'); assert(await f.page.locator('.account-orb-initials').textContent() === 'TR', 'Login initials missing'); await f.close();
  });
  await run('Pending signup prevents duplicate submission', async () => {
    const f = await fixture(); f.state.delay = 250; await action(f.page, 'register').click(); await fill(f.page); await submit(f.page); await submit(f.page); await f.page.waitForSelector('.account-recovery-once:not([hidden])'); assert(f.state.calls.filter(c => c.endpoint === '/register').length === 1, 'Duplicate signup'); await f.close();
  });
  await run('Invalid password gives generic error and clears secret without authenticated avatar', async () => {
    const f = await fixture(); await fill(f.page, { password: 'Incorrect synthetic password' }); await submit(f.page); await settle(f.page); assert(await f.page.locator('.account-auth-message').textContent() === 'Username or password is incorrect.', 'Wrong generic error'); assert(await f.page.locator('#account-password').inputValue() === '', 'Password not cleared'); assert(!(await f.page.locator('#account-open').getAttribute('class')).includes('is-signed-in'), 'Failed login confirms avatar'); await f.close();
  });
  await run('Successful login shows initials; logout clears confirmed identity and owner marker', async () => {
    const f = await fixture(); await fill(f.page); await submit(f.page); await f.page.waitForSelector('#account-open.is-signed-in'); assert(await f.page.locator('.account-orb-initials').textContent() === 'TR', 'Monogram absent'); await action(f.page, 'logout').click(); await f.page.waitForSelector('#account-open:not(.is-signed-in)'); assert(await f.page.locator('.account-orb-initials').textContent() === '', 'Logout retains initials'); assert(await f.page.evaluate(() => localStorage.getItem('recitealquran-last-account-v1')) === null, 'Logout retains owner marker'); await f.close();
  });
  await run('Password recovery requires a code, rotates displayed code, and requires acknowledgment without automatic login', async () => {
    const f = await fixture(); await action(f.page, 'recover').click(); await fill(f.page, { recovery: '' }); await submit(f.page); await settle(f.page); assert(!f.state.calls.some(c => c.endpoint === '/recover'), 'Empty recovery code submitted'); assert(await f.page.locator('.account-auth-message').textContent() === 'Enter your recovery code.', 'Missing recovery guidance'); await fill(f.page); await submit(f.page); await f.page.waitForSelector('.account-recovery-once:not([hidden])'); assert(await f.page.locator('.account-recovery-rotated').isVisible(), 'No rotation notice'); assert(await action(f.page, 'code-done').isDisabled(), 'No reset acknowledgment'); assert(!(await f.page.locator('#account-open').getAttribute('class')).includes('is-signed-in'), 'Recovery automatically logs in'); await f.page.check('#account-code-saved'); await action(f.page, 'code-done').click(); assert(await f.page.locator('.account-auth-message').textContent() === 'Password reset. Sign in with your new password.', 'Missing reset sign-in guidance'); await f.close();
  });
  await run('Password change includes current/new credentials, CSRF, and account assertion then clears fields', async () => {
    const f = await fixture({ user: member }); await action(f.page, 'change-password').click(); await fill(f.page, { password: 'New synthetic password 456!' }); await submit(f.page); await settle(f.page); const req = f.state.calls.find(c => c.endpoint === '/password'); assert(req?.body.currentPassword === password && req.body.newPassword === 'New synthetic password 456!', 'Wrong password change payload'); assert(req.headers['x-csrf-token'] === 'mock-csrf' && req.headers['x-account-user'] === member.id, 'Missing authenticated mutation guards'); assert(await f.page.locator('.account-message').textContent() === 'Password changed. Other sessions have been signed out.', 'No change confirmation'); assert(await f.page.locator('#account-current-password').inputValue() === '', 'Current password retained'); await f.close();
  });
  await run('Arabic account UI is RTL with diacritics preserved in initials; identity markup stays text', async () => {
    const f = await fixture({ user: { ...member, name: 'أَحمد مُحمد' } }); await f.page.evaluate(() => document.documentElement.lang = 'ar'); await settle(f.page); assert(await f.page.locator('#account-dialog').getAttribute('dir') === 'rtl', 'Arabic direction wrong'); assert(await f.page.locator('#account-title').textContent() === 'حسابك', 'Arabic heading missing'); const initials = await f.page.locator('.account-orb-initials').textContent(); assert(initials.includes('\u200c') && initials.includes('أَ') && initials.includes('مُ'), 'Arabic initial shaping wrong'); f.state.user = { ...member, name: '<img src=x onerror=alert(1)>' }; await f.page.evaluate(() => ui.refresh()); assert(await f.page.locator('.account-name').textContent() === '<img src=x onerror=alert(1)>', 'Name not plain text'); assert(await f.page.locator('.account-name img').count() === 0, 'Identity HTML injection'); await f.close();
  });
  await run('Busy microphone disables password changes, resume, and logout with explanation', async () => {
    const f = await fixture({ user: member, progress: point(10) }); await f.page.evaluate(() => { harness.busy = true; ui.changed(); }); for (const name of ['logout', 'resume', 'change-password']) assert(await action(f.page, name).isDisabled(), 'Busy action enabled: ' + name); assert(await f.page.locator('.account-busy-note').isVisible(), 'Busy explanation absent'); await f.page.evaluate(() => document.querySelector('[data-action="logout"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))); assert(!f.state.calls.some(c => c.endpoint === '/logout'), 'Busy guard allowed logout'); await f.close();
  });
  await run('Startup preserves remote checkpoint and pointer; explicit resume keeps exact Quran coordinates', async () => {
    const f = await fixture({ user: member, progress: point(44, 5) }); assert(!f.state.calls.some(c => c.method === 'PUT'), 'Startup overwrites progress'); assert((await f.page.evaluate(() => harness.restores)).length === 0, 'Startup moves pointer'); await action(f.page, 'resume').click(); await settle(f.page); const restored = await f.page.evaluate(() => harness.restores); assert(restored[0]?.position.page === 44 && restored[0]?.position.word === 5, 'Resume coordinates wrong'); await f.close();
  });
  await run('Offline checkpoint is owner-specific and syncs with authentication guards when online', async () => {
    const f = await fixture({ user: member }); await f.page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); harness.snapshot.position.word = 4; ui.changed(); }); await f.page.evaluate(() => ui.flush()); assert(!f.state.calls.some(c => c.method === 'PUT'), 'Offline upload attempted'); let cache = await f.page.evaluate(id => JSON.parse(localStorage.getItem('recitealquran-account-progress-v1:' + id)), member.id); assert(cache.dirty && cache.progress.position.word === 4, 'Offline queue not persisted'); await f.page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); return ui.flush(); }); const req = f.state.calls.find(c => c.method === 'PUT'); assert(req?.body.progress.position.word === 4, 'Wrong online checkpoint'); assert(req.headers['x-csrf-token'] === 'mock-csrf' && req.headers['x-account-user'] === member.id, 'Progress mutation guards missing'); assert(!JSON.stringify(req.body).includes(password) && !JSON.stringify(req.body).includes(recoveryCode), 'Credential leaks into progress'); cache = await f.page.evaluate(id => JSON.parse(localStorage.getItem('recitealquran-account-progress-v1:' + id)), member.id); assert(!cache.dirty, 'Queue not cleared after sync'); await f.close();
  });
  await run('Conflict pauses sync for explicit choice and does not move reading pointer', async () => {
    const f = await fixture({ user: member }); f.state.conflict = true; f.state.progress = point(99); await f.page.evaluate(() => { harness.snapshot.position.word = 7; ui.changed(); return ui.flush(); }); assert(await f.page.locator('.account-choice').isVisible(), 'Conflict chooser missing'); assert((await f.page.evaluate(() => harness.restores)).length === 0, 'Conflict moved pointer'); const count = f.state.calls.filter(c => c.method === 'PUT').length; await f.page.evaluate(() => ui.flush()); assert(f.state.calls.filter(c => c.method === 'PUT').length === count, 'Conflict did not pause write'); await f.close();
  });
  await run('Session expiry clears confirmed avatar but preserves account queue separately from guest', async () => {
    const f = await fixture({ user: member }); await f.page.evaluate(() => { harness.snapshot.position.word = 8; ui.changed(); }); f.state.failProgress = 401; await f.page.evaluate(() => ui.flush()); assert(!(await f.page.locator('#account-open').getAttribute('class')).includes('is-signed-in'), 'Expired session keeps avatar'); assert(await f.page.locator('.account-orb-initials').textContent() === '', 'Expired session keeps initials'); assert(await f.page.evaluate(() => localStorage.getItem('recitealquran-guest-progress-v1')) === null, 'Owner progress leaked to guest'); assert(await f.page.evaluate(id => Boolean(localStorage.getItem('recitealquran-account-progress-v1:' + id)), member.id), 'Owner queue lost'); await f.close();
  });
  await run('Different account in another tab does not attach reading session silently', async () => {
    const f = await fixture({ user: member }); f.state.user = { ...member, id: 'local:mock-user-2', name: 'Another Reader' }; await f.page.evaluate(() => ui.refresh()); assert(!(await f.page.locator('#account-open').getAttribute('class')).includes('is-signed-in'), 'Cross-tab account silently attached'); assert((await f.page.locator('.account-message').textContent()).includes('another tab'), 'Missing cross-tab guidance'); await f.close();
  });
  await run('Unavailable password service keeps Google enabled and explains capability', async () => {
    const f = await fixture({ passwordConfigured: false }); assert(await action(f.page, 'credentials').isDisabled(), 'Unconfigured credentials enabled'); assert(await action(f.page, 'google').isEnabled(), 'Google wrongly disabled'); assert((await f.page.locator('.account-auth-message').textContent()).includes('not enabled'), 'Capability explanation missing'); await f.close();
  });
  await run('Mobile account dialog fits viewport and signup confirmation remains usable', async () => {
    const f = await fixture({ mobile: true }); const rect = await f.page.locator('#account-dialog').boundingBox(); assert(rect.x >= 0 && rect.x + rect.width <= 394, 'Mobile dialog overflows'); await action(f.page, 'register').click(); assert(await f.page.locator('#account-confirm-password').isVisible(), 'Mobile password confirmation absent'); assert(await action(f.page, 'credentials').isEnabled(), 'Mobile signup disabled'); await f.close();
  });
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify({ kind: 'isolated-mocked-frontend-account-tests', passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, results }, null, 2));
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
