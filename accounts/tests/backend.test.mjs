// Isolated native Workers/D1 integration tests. No network requests, live data,
// credentials, or Cloudflare account configuration are used by this harness.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencies = path.join(root, 'node_modules/.pnpm');
const installed = await readdir(dependencies);
const dependency = name => path.join(dependencies, installed.find(value => value.startsWith(`${name}@`)), 'node_modules', name);
const require = createRequire(import.meta.url);
const nodeSqliteMode = process.argv.includes('--node-sqlite');
let Miniflare, Log, LogLevel, convertV4MiniflareOptions, built, worker, DatabaseSync;
if (nodeSqliteMode) {
  ({ DatabaseSync } = await import('node:sqlite'));
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', { value: timingSafeEqual, configurable: true });
  worker = (await import(pathToFileURL(path.join(root, 'worker.js')).href)).default;
} else {
  ({ Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require(dependency('miniflare')));
  const { build } = require(dependency('esbuild'));
  built = await build({ entryPoints: [path.join(root, 'worker.js')], bundle: true, format: 'esm', write: false, platform: 'browser', target: 'es2022', logLevel: 'silent' });
}
const origin = 'https://recitealquran.com';
const pepper = randomBytes(32).toString('hex');
const password = 'Fictional local test password only 2026';
const nextPassword = 'Changed fictional local password only 2026';
const thirdPassword = 'Third fictional local password only 2026';
const sha = value => createHash('sha256').update(value).digest('hex');
let passed = 0, failed = 0, currentIp = 1;
const instances = [];
const results = [];
const test = async (name, fn) => {
  try { await fn(); passed++; results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) {
    failed++;
    const location = error.stack?.split('\n').find(line => /^\s+at /.test(line))?.trim();
    results.push({ name, status: 'failed', errorType: error.name, ...(location ? { location } : {}) });
    console.log(`FAIL ${name}: ${error.name}${location ? ` (${location})` : ''}`);
  }
};
const newIp = () => `192.0.2.${currentIp++}`;
function sqliteD1() {
  const connection = new DatabaseSync(':memory:');
  connection.exec('PRAGMA foreign_keys = ON');
  const prepare = sql => {
    let values = [];
    const execute = () => {
      const rows = connection.prepare(sql).all(...values).map(row => ({ ...row }));
      return { success: true, results: rows };
    };
    return {
      bind(...bindings) { values = bindings; return this; },
      async first() { return execute().results[0] || null; },
      async all() { return execute(); },
      async run() { return execute(); },
      execute,
    };
  };
  return {
    prepare,
    async batch(statements) {
      connection.exec('BEGIN');
      try { const rows = statements.map(statement => statement.execute()); connection.exec('COMMIT'); return rows; }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
    close() { connection.close(); },
  };
}
async function create({ withPepper = true, withPasswordMigration = true } = {}) {
  const bindings = { APP_ORIGIN: origin, GOOGLE_CLIENT_ID: 'fictional-local-client', GOOGLE_CLIENT_SECRET: 'fictional-local-secret', ...(withPepper ? { PASSWORD_PEPPER: pepper } : {}) };
  const mf = nodeSqliteMode ? (() => {
    const db = sqliteD1();
    return {
      async getD1Database() { return db; },
      async dispatchFetch(url, init) { return worker.fetch(new Request(url, init), { ...bindings, DB: db }); },
      async dispose() { db.close(); },
    };
  })() : new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'accounts-local-test', modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-17', d1Databases: { DB: 'isolated-accounts-tests' },
    bindings,
    }], log: new Log(LogLevel.ERROR), cf: false }));
  instances.push(mf);
  const db = await mf.getD1Database('DB');
  const files = ['0001_recite_accounts.sql', ...(withPasswordMigration ? ['0002_password_accounts.sql'] : [])];
  for (const file of files) {
    const sql = (await readFile(path.join(root, 'migrations', file), 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  async function request(endpoint, options = {}) {
    const headers = { 'CF-Connecting-IP': options.ip || newIp(), ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers };
    if (options.method && !['GET', 'HEAD'].includes(options.method)) {
      if (!('Origin' in headers)) headers.Origin = origin;
      if (!('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
    }
    const response = await mf.dispatchFetch(`${options.origin || origin}/api/account${endpoint}`, { method: options.method || 'GET', headers,
      ...(options.body !== undefined ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}) });
    const raw = await response.text();
    const body = raw ? JSON.parse(raw) : null;
    return { status: response.status, headers: response.headers, body, cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
  }
  const signup = (username, options = {}) => request('/register', { method: 'POST', body: { username, password }, ...options });
  const login = (username, selectedPassword = password, options = {}) => request('/password-login', { method: 'POST', body: { username, password: selectedPassword }, ...options });
  const recover = (username, recoveryCode, selectedPassword = nextPassword, options = {}) => request('/recover', { method: 'POST', body: { username, recoveryCode, password: selectedPassword }, ...options });
  const auth = result => ({ cookie: result.cookie, headers: { 'X-Account-User': result.body.user.id, 'X-CSRF-Token': result.body.csrfToken } });
  const clearLimits = () => db.prepare('DELETE FROM recite_auth_limits').run();
  return { mf, db, request, signup, login, recover, auth, clearLimits };
}

try {
  const h = await create();
  let alice, bob, google;
  await test('capabilities expose Google and password availability', async () => {
    const r = await h.request('/me'); assert.equal(r.status, 200); assert.equal(r.body.configured, true); assert.equal(r.body.googleConfigured, true); assert.equal(r.body.passwordConfigured, true); assert.equal(r.body.user, null);
    assert.match(r.headers.get('Cache-Control'), /no-store/); assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  });
  await test('signup normalizes username and uses secure session cookie', async () => {
    alice = await h.signup('  Alice_Test  '); assert.equal(alice.status, 200); assert.equal(alice.body.user.username, 'alice_test'); assert.match(alice.body.user.id, /^local:/); assert.equal(alice.body.user.provider, 'password'); assert.equal(alice.body.user.email, null);
    assert.match(alice.body.recoveryCode, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){7}$/);
    const cookie = alice.headers.get('Set-Cookie'); for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(flag));
  });
  await test('D1 contains salted slow password verifier and hashed recovery code only', async () => {
    const identity = await h.db.prepare('SELECT * FROM recite_password_accounts WHERE username = ?').bind('alice_test').first();
    assert.equal(identity.password_iterations, 100000); assert.match(identity.password_hash, /^[a-f0-9]{64}$/); assert.match(identity.password_salt, /^[a-f0-9]{64}$/);
    assert.notEqual(identity.password_hash, password); assert.notEqual(identity.recovery_hash, alice.body.recoveryCode.replaceAll('-', '')); assert.equal(identity.recovery_hash, sha(`recite-recovery-v1:${alice.body.recoveryCode.replaceAll('-', '')}`));
  });
  await test('authenticated me identifies username without returning credentials or recovery code', async () => {
    const r = await h.request('/me', { cookie: alice.cookie }); assert.equal(r.status, 200); assert.equal(r.body.user.id, alice.body.user.id); assert.equal(r.body.csrfToken, alice.body.csrfToken); assert.ok(!('recoveryCode' in r.body)); assert.ok(!JSON.stringify(r.body).includes('password_hash'));
  });
  await test('duplicate signup is case insensitive and leaves no orphan user', async () => {
    const before = await h.db.prepare('SELECT count(*) AS total FROM recite_users').first(); const r = await h.signup('ALICE_TEST'); assert.equal(r.status, 409); assert.equal(r.body.code, 'username_unavailable'); assert.deepEqual(await h.db.prepare('SELECT count(*) AS total FROM recite_users').first(), before);
  });
  await test('known incorrect and missing account login give same generic response', async () => {
    const wrong = await h.login('alice_test', nextPassword), absent = await h.login('no_such_account'); assert.equal(wrong.status, 401); assert.deepEqual(absent.body, wrong.body); assert.equal(absent.status, wrong.status);
  });
  await test('successful login rotates session and expires the presented old session', async () => {
    const r = await h.login('ALICE_TEST', password, { cookie: alice.cookie }); assert.equal(r.status, 200); assert.notEqual(r.cookie, alice.cookie);
    assert.equal((await h.request('/me', { cookie: alice.cookie })).body.user, null); alice = r;
  });
  await test('passwords are not trimmed and Unicode/space passwords work', async () => {
    const exact = '  تجربة كلمة مرور عربية طويلة  '; const r = await h.signup('arabic_password', { body: { username: 'arabic_password', password: exact } }); assert.equal(r.status, 200);
    assert.equal((await h.login('arabic_password', exact)).status, 200); assert.equal((await h.login('arabic_password', exact.trim())).status, 401);
  });
  await test('password length and username shape reject invalid inputs', async () => {
    await h.clearLimits();
    const cases = [{ username: 'xx', password }, { username: 'عربي', password }, { username: 'contains space', password }, { username: 'valid_shape', password: 'short' }, { username: 'valid_shape', password: 'x'.repeat(129) }];
    for (const body of cases) assert.equal((await h.request('/register', { method: 'POST', body })).status, 400);
    await h.clearLimits();
  });
  await test('exact request origin protects every unauthenticated password mutation', async () => {
    for (const endpoint of ['/register', '/password-login', '/recover']) {
      for (const Origin of ['', 'https://attacker.invalid', 'https://recitealquran.com.attacker.invalid', 'http://recitealquran.com']) {
        assert.equal((await h.request(endpoint, { method: 'POST', headers: { Origin }, body: {} })).status, 403);
      }
    }
  });
  await test('alternate URL origin cannot impersonate app host', async () => { assert.equal((await h.request('/me', { origin: 'https://attacker.invalid' })).status, 403); });
  await test('form/malformed/array/null and oversized JSON inputs are rejected without 500', async () => {
    const cases = [{ body: 'username=alice_test', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, { body: '{' }, { body: '[]' }, { body: 'null' }, { body: JSON.stringify({ username: 'large_body', password, extra: 'x'.repeat(9000) }) }];
    for (const value of cases) { const r = await h.request('/register', { method: 'POST', ...value }); assert.equal(r.status, 400); }
  });
  const progress = { schema: 1, position: { page: 4, surah: 2, ayah: 17, word: 3, bismillah: false }, totals: { correct: 12, reviewed: 2 }, updatedAt: Date.now() };
  await test('progress endpoints require confirmed owner and mutation CSRF', async () => {
    assert.equal((await h.request('/progress', { cookie: alice.cookie })).status, 401);
    assert.equal((await h.request('/progress', { cookie: alice.cookie, headers: { 'X-Account-User': 'local:wrong' } })).status, 401);
    assert.equal((await h.request('/progress', { method: 'PUT', cookie: alice.cookie, headers: { 'X-Account-User': alice.body.user.id }, body: { expectedVersion: 0, progress } })).status, 403);
  });
  await test('progress strips recordings/transcripts and rejects stale compare-and-swap', async () => {
    const opts = h.auth(alice); const r = await h.request('/progress', { method: 'PUT', ...opts, body: { expectedVersion: 0, progress: { ...progress, recording: 'forbidden', transcript: 'forbidden' } } }); assert.equal(r.status, 200); assert.equal(r.body.version, 1);
    const saved = await h.request('/progress', opts); assert.deepEqual(saved.body.progress, progress);
    const stale = await h.request('/progress', { method: 'PUT', ...opts, body: { expectedVersion: 0, progress } }); assert.equal(stale.status, 409); assert.equal(stale.body.version, 1);
  });
  await test('accounts cannot read or overwrite another account progress', async () => {
    bob = await h.signup('bob_test'); assert.equal(bob.status, 200);
    assert.equal((await h.request('/progress', h.auth(bob))).body.progress, null);
    assert.equal((await h.request('/progress', { ...h.auth(bob), headers: { ...h.auth(bob).headers, 'X-Account-User': alice.body.user.id } })).status, 401);
    assert.deepEqual((await h.request('/progress', h.auth(alice))).body.progress, progress);
  });
  await test('simultaneous progress writes resolve to one success and one conflict', async () => {
    const opts = { method: 'PUT', ...h.auth(alice), body: { expectedVersion: 1, progress } }; const responses = await Promise.all([h.request('/progress', opts), h.request('/progress', opts)]); assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  });
  await test('Google account remains independent from same-named username account', async () => {
    const token = randomBytes(32).toString('hex'), id = 'fictional-google-subject-123';
    await h.db.batch([h.db.prepare('INSERT INTO recite_users (id,email,name,created_at) VALUES (?,?,?,?)').bind(id, 'fictional@example.invalid', 'alice_test', Date.now()), h.db.prepare('INSERT INTO recite_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(sha(token), id, Date.now() + 600000)]);
    google = { cookie: `__Host-recite_session=${token}`, body: (await h.request('/me', { cookie: `__Host-recite_session=${token}` })).body };
    assert.equal(google.body.user.provider, 'google'); assert.notEqual(google.body.user.id, alice.body.user.id); assert.equal((await h.request('/progress', h.auth(google))).body.progress, null);
    const rejected = await h.request('/password', { method: 'POST', ...h.auth(google), body: { currentPassword: password, newPassword: nextPassword } }); assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'google_account');
  });
  await test('Google OAuth start uses fixed callback, PKCE and allowlisted return path', async () => {
    const r = await h.request('/login?returnTo=https://attacker.invalid'); assert.equal(r.status, 303);
    const target = new URL(r.headers.get('Location')); assert.equal(target.origin, 'https://accounts.google.com'); assert.equal(target.searchParams.get('redirect_uri'), `${origin}/api/account/callback`); assert.equal(target.searchParams.get('code_challenge_method'), 'S256'); assert.match(target.searchParams.get('state'), /^[a-f0-9]{64}$/);
    const flow = await h.db.prepare('SELECT return_to FROM recite_oauth_states').first(); assert.equal(flow.return_to, '/');
  });
  await test('Google callback rejects unbound state without provider network call', async () => {
    const r = await h.request(`/callback?state=${'a'.repeat(64)}&code=fictional`); assert.equal(r.status, 303); assert.equal(new URL(r.headers.get('Location')).searchParams.get('account'), 'error');
  });
  await test('password change requires current password and retains checkpoint', async () => {
    await h.clearLimits(); const second = await h.login('alice_test'); assert.equal(second.status, 200);
    const bad = await h.request('/password', { method: 'POST', ...h.auth(alice), body: { currentPassword: nextPassword, newPassword: thirdPassword } }); assert.equal(bad.status, 401);
    const changed = await h.request('/password', { method: 'POST', ...h.auth(alice), body: { currentPassword: password, newPassword: nextPassword } }); assert.equal(changed.status, 200);
    assert.equal((await h.request('/me', { cookie: alice.cookie })).body.user, null); assert.equal((await h.request('/me', { cookie: second.cookie })).body.user, null);
    alice = changed; assert.deepEqual((await h.request('/progress', h.auth(alice))).body.progress, progress);
    assert.equal((await h.login('alice_test', password)).status, 401); assert.equal((await h.login('alice_test', nextPassword)).status, 200);
  });
  await test('recovery code resets password, rotates code and revokes every session', async () => {
    const originalCode = (await h.db.prepare('SELECT recovery_hash FROM recite_password_accounts WHERE username=?').bind('alice_test').first()).recovery_hash;
    // Bob still retains his signup response/code; Alice's change response omits it.
    const second = await h.login('bob_test'); const reset = await h.recover('bob_test', bob.body.recoveryCode); assert.equal(reset.status, 200); assert.equal(reset.body.recovered, true); assert.notEqual(reset.body.recoveryCode, bob.body.recoveryCode);
    assert.equal((await h.request('/me', { cookie: bob.cookie })).body.user, null); assert.equal((await h.request('/me', { cookie: second.cookie })).body.user, null);
    assert.equal((await h.recover('bob_test', bob.body.recoveryCode, thirdPassword)).status, 401); assert.equal((await h.login('bob_test', password)).status, 401); assert.equal((await h.login('bob_test', nextPassword)).status, 200);
    assert.equal((await h.db.prepare('SELECT recovery_hash FROM recite_password_accounts WHERE username=?').bind('alice_test').first()).recovery_hash, originalCode);
    bob = { ...reset, body: { ...reset.body, user: bob.body.user } };
  });
  await test('recovery code accepts formatted uppercase/whitespace without changing entropy', async () => {
    const r = await h.recover('bob_test', `  ${bob.body.recoveryCode.toUpperCase()}  `, thirdPassword); assert.equal(r.status, 200); bob.body.recoveryCode = r.body.recoveryCode;
  });
  await test('unknown username and wrong recovery code return identical generic result', async () => {
    await h.clearLimits(); const a = await h.recover('bob_test', '0'.repeat(64)); const b = await h.recover('no_such_account', '0'.repeat(64)); assert.equal(a.status, 401); assert.equal(b.status, 401); assert.deepEqual(a.body, b.body);
  });
  await test('parallel signup enforces unique username atomically without orphan users', async () => {
    await h.clearLimits(); const before = (await h.db.prepare('SELECT count(*) AS total FROM recite_users').first()).total;
    const results = await Promise.all([h.signup('race_signup'), h.signup('RACE_SIGNUP')]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal((await h.db.prepare('SELECT count(*) AS total FROM recite_users').first()).total, before + 1);
  });
  await test('parallel recovery consumes a recovery code exactly once', async () => {
    await h.clearLimits(); const r = await h.signup('race_recovery'); assert.equal(r.status, 200);
    const results = await Promise.all([h.recover('race_recovery', r.body.recoveryCode, nextPassword), h.recover('race_recovery', r.body.recoveryCode, thirdPassword)]); assert.deepEqual(results.map(value => value.status).sort(), [200, 401]);
    const winnerIndex = results.findIndex(value => value.status === 200); const winningPassword = winnerIndex === 0 ? nextPassword : thirdPassword; const losingPassword = winnerIndex === 0 ? thirdPassword : nextPassword;
    assert.equal((await h.login('race_recovery', winningPassword)).status, 200); assert.equal((await h.login('race_recovery', losingPassword)).status, 401);
    assert.equal((await h.request('/me', { cookie: r.cookie })).body.user, null);
  });
  await test('parallel password changes preserve only winning session and password', async () => {
    await h.clearLimits(); const r = await h.signup('race_change');
    const results = await Promise.all([nextPassword, thirdPassword].map(newPassword => h.request('/password', { method: 'POST', ...h.auth(r), body: { currentPassword: password, newPassword } })));
    assert.deepEqual(results.map(value => value.status).sort(), [200, 401]); const winner = results.find(value => value.status === 200);
    assert.equal((await h.request('/me', { cookie: winner.cookie })).body.user?.id, r.body.user.id); assert.equal((await h.request('/me', { cookie: r.cookie })).body.user, null);
  });
  await test('concurrent login failures enforce username quota across different IPs', async () => {
    await h.clearLimits(); const results = await Promise.all(Array.from({ length: 14 }, () => h.login('rate_username', password))); assert.equal(results.filter(r => r.status === 401).length, 10); assert.equal(results.filter(r => r.status === 429).length, 4);
    for (const limited of results.filter(r => r.status === 429)) { assert.ok(limited.body.retryAfter > 0); assert.equal(limited.headers.get('Retry-After'), String(limited.body.retryAfter)); }
  });
  await test('concurrent login failures enforce IP quota across different usernames', async () => {
    await h.clearLimits(); const ip = newIp(); const results = await Promise.all(Array.from({ length: 34 }, (_, index) => h.login(`rate_ip_${index}`, password, { ip }))); assert.equal(results.filter(r => r.status === 401).length, 30); assert.equal(results.filter(r => r.status === 429).length, 4);
  });
  await test('registration IP quota remains atomic under simultaneous requests', async () => {
    await h.clearLimits(); const ip = newIp(); const results = await Promise.all(Array.from({ length: 8 }, (_, index) => h.signup(`rate_register_${index}`, { ip }))); assert.equal(results.filter(r => r.status === 200).length, 5); assert.equal(results.filter(r => r.status === 429).length, 3);
  });
  await test('recovery quota and persisted rate identifiers never store raw IP/username', async () => {
    await h.clearLimits(); const ip = newIp(); const results = await Promise.all(Array.from({ length: 7 }, () => h.recover('rate_recover', '0'.repeat(64), nextPassword, { ip }))); assert.equal(results.filter(r => r.status === 401).length, 5); assert.equal(results.filter(r => r.status === 429).length, 2);
    const rows = (await h.db.prepare('SELECT * FROM recite_auth_limits').all()).results; assert.ok(rows.length >= 3); for (const row of rows) { assert.match(row.key_hash, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(row).includes(ip)); assert.ok(!JSON.stringify(row).includes('rate_recover')); }
  });
  await test('logout checks CSRF/owner, removes current session and keeps other account', async () => {
    await h.clearLimits(); const r = await h.login('alice_test', nextPassword); assert.equal(r.status, 200);
    assert.equal((await h.request('/logout', { method: 'POST', cookie: r.cookie, headers: { 'X-Account-User': r.body.user.id }, body: {} })).status, 403);
    assert.equal((await h.request('/logout', { method: 'POST', ...h.auth(r), body: {} })).status, 200); assert.equal((await h.request('/me', { cookie: r.cookie })).body.user, null); assert.equal((await h.request('/me', { cookie: google.cookie })).body.user.provider, 'google');
  });
  await test('account deletion removes local identity, sessions, checkpoint and preserves Google', async () => {
    const r = await h.login('alice_test', nextPassword); assert.equal(r.status, 200);
    const result = await h.request('/account', { method: 'DELETE', ...h.auth(r) }); assert.equal(result.status, 200);
    for (const table of ['recite_sessions', 'recite_password_accounts', 'recite_progress']) assert.equal((await h.db.prepare(`SELECT count(*) AS total FROM ${table} WHERE user_id=?`).bind(r.body.user.id).first()).total, 0);
    assert.equal((await h.db.prepare('SELECT count(*) AS total FROM recite_users WHERE id=?').bind(r.body.user.id).first()).total, 0);
    assert.equal((await h.request('/me', { cookie: google.cookie })).body.user.provider, 'google'); assert.equal((await h.login('alice_test', nextPassword)).status, 401);
  });
  for (const scenario of [{ withPepper: false }, { withPasswordMigration: false }]) {
    await test(`Google session survives password feature unavailable (${scenario.withPepper === false ? 'no pepper' : 'no password migration'})`, async () => {
      const separate = await create(scenario); const token = randomBytes(32).toString('hex'); const id = 'fictional-google-without-password';
      await separate.db.batch([separate.db.prepare('INSERT INTO recite_users (id,email,name,created_at) VALUES (?,?,?,?)').bind(id, 'fictional@example.invalid', 'Reader', Date.now()), separate.db.prepare('INSERT INTO recite_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(sha(token), id, Date.now() + 600000)]);
      const r = await separate.request('/me', { cookie: `__Host-recite_session=${token}` }); assert.equal(r.status, 200); assert.equal(r.body.user.provider, 'google'); assert.equal(r.body.passwordConfigured, false); assert.equal(r.body.googleConfigured, true);
      const registration = await separate.signup('disabled_user'); assert.equal(registration.status, 503); assert.equal(registration.body.code, 'password_not_configured');
    });
  }
} finally {
  await Promise.allSettled(instances.map(mf => mf.dispose()));
  if (nodeSqliteMode) {
    const artifact = {
      schema: 1, suite: 'account-worker-node-sqlite-contract', recordedAt: new Date().toISOString(), status: failed ? 'failed' : 'passed',
      harness: 'accounts/tests/backend.test.mjs --node-sqlite', passed, failed, executedCases: results.length,
      runtime: { node: process.versions.node, storage: "Node built-in SQLite DatabaseSync(':memory:')", workersRuntime: false },
      coverage: { actualWorkerJavaScript: true, actualSQLiteTransactions: true, productionRequests: false, cloudSettingsChanged: false },
      limits: ['D1 adapter contract tests in one Node process; not native Cloudflare Workers or distributed D1 execution.', 'Concurrent API calls and atomic SQLite transactions are exercised locally; distributed isolate races are not established.', 'No external Google network requests, production signup/login, Workers CPU-limit checks, browser, or microphone tests.'],
      cases: results,
    };
    await mkdir(path.join(root, 'tests/artifacts'), { recursive: true });
    await writeFile(path.join(root, 'tests/artifacts/backend-node-sqlite.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  }
  console.log(`RESULT ${passed} passed; ${failed} failed. ${nodeSqliteMode ? 'Node + isolated SQLite contract adapter (not native Workers/D1)' : 'Native Workers + isolated D1'}; no production traffic.`);
}
process.exitCode = failed ? 1 : 0;
