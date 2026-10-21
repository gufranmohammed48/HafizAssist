// Explicit opt-in only. Uses its own cookies and deletes its temporary account.
// Never loads browser cookies, Google credentials, or the server password secret.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

if (!process.argv.includes('--live')) {
  console.error('Live requests require --live. This creates and deletes one temporary account.');
  process.exit(2);
}

const origin = 'https://recitealquran.com';
const username = 'qa_' + randomBytes(8).toString('hex');
const makePassword = () => ' ' + randomBytes(24).toString('base64url') + ' أQ9🌿 ';
let password = makePassword(), recoveryCode = '', userId = '', registeredUserId = '', csrf = '', created = false, deleted = false;
const jar = new Map(), checks = [];
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

function check(name, condition, detail = '') {
  checks.push({ name, passed: Boolean(condition), ...(detail ? { detail } : {}) });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`);
  if (!condition) throw new Error(name);
}

async function request(path, { method = 'GET', body, cookies, updateCookies = true, headers = {}, authenticate = true } = {}) {
  const started = performance.now();
  const response = await fetch(origin + '/api/account' + path, {
    method, redirect: 'manual', signal: AbortSignal.timeout(25000),
    headers: {
      Accept: 'application/json', Cookie: cookies ?? cookieHeader(),
      ...(method !== 'GET' ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(authenticate && userId ? { 'X-Account-User': userId } : {}),
      ...(authenticate && csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const setCookies = response.headers.getSetCookie();
  if (updateCookies) for (const cookie of setCookies) {
    const [pair] = cookie.split(';'), separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator), value = pair.slice(separator + 1);
    if (!value || /Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name); else jar.set(name, value);
  }
  const data = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : null;
  return { status: response.status, data, headers: response.headers, setCookies, milliseconds: Math.round(performance.now() - started) };
}

function useSession(result) {
  if (result.data?.user?.id) userId = result.data.user.id;
  if (result.data?.csrfToken) csrf = result.data.csrfToken;
}
const secureSession = result => result.setCookies.some(value => value.startsWith('__Host-recite_session=') &&
  /; Secure(?:;|$)/.test(value) && /; HttpOnly(?:;|$)/.test(value) && /; SameSite=Lax(?:;|$)/.test(value));

let failed = false;
try {
  const capability = await request('/me', { authenticate: false });
  check('Both account methods configured', capability.status === 200 && capability.data?.configured === true &&
    capability.data.googleConfigured === true && capability.data.passwordConfigured === true);
  check('Isolated anonymous session', capability.data.user === null);
  check('Account responses are not cached', /no-store/.test(capability.headers.get('Cache-Control') || ''));
  check('Anonymous progress denied', (await request('/progress')).status === 401);

  const signup = await request('/register', { method: 'POST', authenticate: false,
    body: { username: ' ' + username.toUpperCase() + ' ', password } });
  created = signup.status === 200 && Boolean(signup.data?.user?.id);
  if (created) { useSession(signup); registeredUserId = userId; recoveryCode = signup.data.recoveryCode; }
  check('Username signup succeeds', created, `HTTP ${signup.status}`);
  check('Username normalization and local identity', signup.data.user.username === username && userId.startsWith('local:') && signup.data.user.provider === 'password');
  check('Recovery code returned at signup', typeof recoveryCode === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{8}){7}$/.test(recoveryCode));
  check('Secure HttpOnly session cookie', secureSession(signup));
  check('Signup result has CSRF token', /^[a-f0-9]{64}$/.test(csrf));
  const signedIn = await request('/me');
  check('Signed-in identity round trip', signedIn.data?.user?.id === userId && signedIn.data.user.username === username);
  check('Recovery code is not returned again', !('recoveryCode' in signedIn.data));
  const initial = await request('/progress');
  check('New account has no saved position', initial.status === 200 && initial.data.progress === null && initial.data.version === 0);

  const first = { schema: 1, position: { page: 3, surah: 2, ayah: 10, word: 4, bismillah: false },
    totals: { correct: 12, reviewed: 14 }, updatedAt: Date.now() };
  const save = await request('/progress', { method: 'PUT', body: { expectedVersion: 0, progress: first } });
  check('Saved position created', save.status === 200 && save.data.version === 1);
  const read = await request('/progress');
  check('Saved position and totals round trip', read.status === 200 && JSON.stringify(read.data.progress) === JSON.stringify(first));
  const stale = await request('/progress', { method: 'PUT', body: { expectedVersion: 0, progress: { ...first, updatedAt: Date.now() } } });
  check('Stale saves require a conflict choice', stale.status === 409 && stale.data.version === 1 && stale.data.progress.position.word === 4);
  const wrongOwner = await request('/progress', { headers: { 'X-Account-User': 'local:not-this-account' } });
  check('Mismatched account identity rejected', wrongOwner.status === 401);
  const noCsrf = await request('/progress', { method: 'PUT', headers: { 'X-CSRF-Token': '' }, body: { expectedVersion: 1, progress: first } });
  check('Missing CSRF token rejected', noCsrf.status === 403);
  const foreignOrigin = await request('/logout', { method: 'POST', headers: { Origin: 'https://example.invalid' } });
  check('Cross-site account changes rejected', foreignOrigin.status === 403);
  check('Rejected changes preserve the session', (await request('/me')).data?.user?.id === userId);
  const second = { ...first, position: { ...first.position, word: 5 }, totals: { correct: 13, reviewed: 15 }, updatedAt: Date.now() };
  const update = await request('/progress', { method: 'PUT', body: { expectedVersion: 1, progress: second } });
  check('Saved position update increments version', update.status === 200 && update.data.version === 2);

  const firstSession = cookieHeader();
  check('Sign out succeeds', (await request('/logout', { method: 'POST' })).status === 200);
  check('Signed-out session revoked', (await request('/progress', { cookies: firstSession, updateCookies: false })).status === 401);
  check('Incorrect password rejected', (await request('/password-login', { method: 'POST', authenticate: false, body: { username, password: makePassword() } })).data?.code === 'invalid_credentials');
  const login = await request('/password-login', { method: 'POST', authenticate: false, body: { username: username.toUpperCase(), password } });
  useSession(login);
  check('Username/password login succeeds', login.status === 200 && login.data?.user?.id === registeredUserId && secureSession(login));
  check('Saved position survives sign out and login', JSON.stringify((await request('/progress')).data?.progress) === JSON.stringify(second));

  const nextPassword = makePassword();
  const wrongChange = await request('/password', { method: 'POST', body: { currentPassword: makePassword(), newPassword: nextPassword } });
  check('Password change needs current password', wrongChange.status === 401 && wrongChange.data?.code === 'current_password_incorrect');
  const beforeChange = cookieHeader();
  const change = await request('/password', { method: 'POST', body: { currentPassword: password, newPassword: nextPassword } });
  check('Authenticated password change succeeds', change.status === 200 && change.data?.user?.id === userId);
  const oldPassword = password; password = nextPassword; useSession(change);
  check('Password change revokes the old session', (await request('/progress', { cookies: beforeChange, updateCookies: false })).status === 401);
  check('Password change preserves saved position', (await request('/progress')).data?.version === 2);
  check('Previous password no longer works', (await request('/password-login', { method: 'POST', authenticate: false, body: { username, password: oldPassword } })).status === 401);
  const newLogin = await request('/password-login', { method: 'POST', authenticate: false, body: { username, password } });
  useSession(newLogin); check('Changed password works', newLogin.status === 200);

  const recoveredPassword = makePassword();
  const invalidRecovery = await request('/recover', { method: 'POST', authenticate: false,
    body: { username, recoveryCode: '0'.repeat(64), password: recoveredPassword } });
  check('Incorrect recovery code rejected', invalidRecovery.status === 401 && invalidRecovery.data?.code === 'invalid_recovery');
  const beforeRecovery = cookieHeader(), previousCode = recoveryCode;
  const recovery = await request('/recover', { method: 'POST', authenticate: false,
    body: { username, recoveryCode, password: recoveredPassword } });
  check('Recovery code resets password', recovery.status === 200 && recovery.data?.recovered === true);
  password = recoveredPassword; recoveryCode = recovery.data.recoveryCode;
  check('Recovery replaces the recovery code', typeof recoveryCode === 'string' && recoveryCode !== previousCode);
  check('Recovery revokes existing sessions', (await request('/progress', { cookies: beforeRecovery, updateCookies: false })).status === 401);
  check('Used recovery code cannot be reused', (await request('/recover', { method: 'POST', authenticate: false,
    body: { username, recoveryCode: previousCode, password: makePassword() } })).status === 401);
  check('Password before recovery rejected', (await request('/password-login', { method: 'POST', authenticate: false,
    body: { username, password: nextPassword } })).status === 401);
  const recoveredLogin = await request('/password-login', { method: 'POST', authenticate: false, body: { username, password } });
  useSession(recoveredLogin); check('Recovered password signs in', recoveredLogin.status === 200);
  check('Recovery preserves saved position', JSON.stringify((await request('/progress')).data?.progress) === JSON.stringify(second));

  const finalSession = cookieHeader();
  check('Account deletion needs CSRF token', (await request('/account', { method: 'DELETE', headers: { 'X-CSRF-Token': '' } })).status === 403);
  const remove = await request('/account', { method: 'DELETE' });
  deleted = remove.status === 200;
  check('Temporary account deletion succeeds', deleted);
  check('Deleted account session revoked', (await request('/progress', { cookies: finalSession, updateCookies: false })).status === 401);
  check('Deleted account cannot sign in', (await request('/password-login', { method: 'POST', authenticate: false,
    body: { username, password } })).status === 401);

  jar.clear(); csrf = ''; userId = '';
  const google = await request('/login?returnTo=https%3A%2F%2Fexample.invalid', { authenticate: false });
  const googleTarget = new URL(google.headers.get('Location') || origin);
  check('Google OAuth entry remains available', google.status === 303 && googleTarget.origin === 'https://accounts.google.com');
  check('Google callback restricted to this app', googleTarget.searchParams.get('redirect_uri') === origin + '/api/account/callback');
  check('Google uses only approved identity scopes', googleTarget.searchParams.get('scope') === 'openid email profile');
  check('Google entry uses PKCE', googleTarget.searchParams.get('code_challenge_method') === 'S256' && Boolean(googleTarget.searchParams.get('code_challenge')));
  const cancellation = await request('/callback?state=' + encodeURIComponent(googleTarget.searchParams.get('state')) + '&error=access_denied', { authenticate: false });
  const cancelledTarget = new URL(cancellation.headers.get('Location') || origin);
  check('Google cancellation returns safely to app', cancellation.status === 303 && cancelledTarget.origin === origin && cancelledTarget.pathname === '/' && cancelledTarget.searchParams.get('account') === 'error');
  check('Cancelled Google flow leaves no signed-in session', (await request('/me', { authenticate: false })).data?.user === null);
} catch (error) {
  failed = true;
  if (!checks.length || checks.at(-1).passed) checks.push({ name: 'Live request completed', passed: false,
    detail: String(error?.cause?.code || error?.code || error?.name || 'request failure') });
  console.error('Test run stopped: ' + (checks.at(-1)?.passed === false ? checks.at(-1).name : 'request or harness failure'));
} finally {
  if (created && !deleted) {
    try {
      const login = await request('/password-login', { method: 'POST', authenticate: false, body: { username, password } });
      if (login.status === 200) useSession(login);
      const cleanup = await request('/account', { method: 'DELETE' });
      deleted = cleanup.status === 200;
      checks.push({ name: 'Temporary account cleanup', passed: deleted });
    } catch { deleted = false; }
    if (!deleted) console.error('Cleanup required for temporary account: ' + username + (userId ? ' (' + userId + ')' : ''));
  }
  const report = { capturedAt: new Date().toISOString(), target: origin, passed: checks.filter(row => row.passed).length,
    failed: checks.filter(row => !row.passed).length, completed: !failed, temporaryAccountRemoved: !created || deleted,
    limitations: ['Google consent and completed Google login were not exercised.', 'Browser interface and local runtime checks are separate.'], checks };
  const directory = new URL('./artifacts/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('live-accounts.json', directory), JSON.stringify(report, null, 2) + '\n');
  console.log(`RESULT ${report.passed} passed, ${report.failed} failed; temporary account ${created ? deleted ? 'removed' : 'needs cleanup' : 'not created'}.`);
  password = ''; recoveryCode = ''; csrf = ''; jar.clear();
  process.exitCode = failed || (created && !deleted) ? 1 : 0;
}
