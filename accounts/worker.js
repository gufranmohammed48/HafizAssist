import { createRemoteJWKSet, jwtVerify } from 'jose';

// Keep this service isolated from Desktop-HafizAssist, including its cookies.
const SESSION_COOKIE = '__Host-recite_session';
const FLOW_COOKIE = '__Host-recite_login';
const SESSION_SECONDS = 30 * 86400;
const FLOW_SECONDS = 600;
const MAX_BODY_BYTES = 8192;
// Workers' native Web Crypto PBKDF2 accepts at most 100,000 iterations.
// A separate server-only pepper is mandatory; never lower this to meet CPU limits.
const PASSWORD_ITERATIONS = 100000;
const PASSWORD_ACTIONS = new Set(['/api/account/register', '/api/account/password-login', '/api/account/recover']);
const RETURN_PATHS = new Set(['/', '/index.html', '/mobile.html', '/test.html', '/test2.html']);
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const encoder = new TextEncoder();

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  } });
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request, name) {
  for (const item of (request.headers.get('Cookie') || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator > -1 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return '';
}

const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const isToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function sameToken(actual, expected) {
  if (!isToken(actual) || !isToken(expected)) return false;
  return crypto.subtle.timingSafeEqual(encoder.encode(actual), encoder.encode(expected));
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function redirect(target, setCookies = []) {
  const headers = new Headers({
    Location: target,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const value of setCookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}

function appOrigin(env) {
  try {
    const value = new URL(env.APP_ORIGIN);
    // Never derive OAuth callbacks from the Host header or forwarded headers.
    if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' || value.search || value.hash) return null;
    return value.origin;
  } catch { return null; }
}

function returnPath(value) {
  return RETURN_PATHS.has(value) ? value : '/';
}

function accountReturn(origin, path, result) {
  const target = new URL(returnPath(path), origin);
  target.searchParams.set('account', result);
  return target.href;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new Error('Invalid content type');
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES || !request.body) throw new Error('Invalid body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let length = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('Body too large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function cleanProgress(value) {
  if (!value || value.schema !== 1 || !value.position || !value.totals) return null;
  const p = value.position, t = value.totals;
  if (!integer(p.page, 1, 604) || !integer(p.surah, 1, 114) || !integer(p.ayah, 1, 286) ||
      !integer(p.word, 0, 300) || typeof p.bismillah !== 'boolean' ||
      !integer(t.correct, 0, 1000000000) || !integer(t.reviewed, 0, 1000000000) ||
      !integer(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)) return null;
  // Whitelist only the approved resume position and compact totals. In
  // particular, never persist a transcript, recording, or browser user ID.
  return {
    schema: 1,
    position: { page: p.page, surah: p.surah, ayah: p.ayah, word: p.word, bismillah: p.bismillah },
    totals: { correct: t.correct, reviewed: t.reviewed },
    updatedAt: value.updatedAt,
  };
}

async function authenticate(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!isToken(token)) return null;
  const user = await env.DB.prepare(`
    SELECT u.id, u.name, u.email FROM recite_sessions s
    JOIN recite_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(await hash(token), Date.now()).first();
  if (!user) return null;
  // Google authentication does not depend on the new password migration.
  user.provider = 'google';
  user.username = null;
  if (user.id.startsWith('local:')) {
    const identity = await env.DB.prepare('SELECT username FROM recite_password_accounts WHERE user_id = ?').bind(user.id).first();
    if (!identity) return null;
    user.provider = 'password';
    user.username = identity.username;
    user.email = null;
  }
  return { user, token, csrfToken: await hash(`csrf:${token}`) };
}

const credentialError = (error, code, status = 400) => json({ error, code }, status);
const usernameValue = value => typeof value === 'string' && /^[A-Za-z0-9_]{3,32}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
const validPassword = value => typeof value === 'string' && value.length <= 256 && [...value].length >= 12 && [...value].length <= 128;
const recoveryValue = value => typeof value === 'string' && value.length <= 100 ? value.replace(/[\s-]/g, '').toLowerCase() : '';
const localUser = (id, username) => ({ id, name: username, email: null, username, provider: 'password' });
const passwordFailure = () => credentialError('Username or password is incorrect.', 'invalid_credentials', 401);
const recoveryFailure = () => credentialError('Username or recovery code is incorrect.', 'invalid_recovery', 401);

async function passwordConfigured(env) {
  if (typeof env.PASSWORD_PEPPER !== 'string' || encoder.encode(env.PASSWORD_PEPPER).length < 32) return false;
  // Keep existing Google accounts working before this additive migration is applied.
  const row = await env.DB.prepare(`
    SELECT count(*) AS total FROM sqlite_master
    WHERE type = 'table' AND name IN ('recite_password_accounts', 'recite_auth_limits')
  `).first();
  return row?.total === 2;
}

async function keyedHash(env, domain, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.PASSWORD_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(`${domain}\0${value}`));
}

async function passwordHash(env, password, salt, iterations = PASSWORD_ITERATIONS) {
  if (!isToken(salt) || iterations !== PASSWORD_ITERATIONS) throw new Error('Invalid password record');
  const saltBytes = new Uint8Array(salt.match(/../g).map(value => parseInt(value, 16)));
  // The pepper is outside D1; loss of the database alone does not expose a
  // password verifier usable for offline guessing. Passwords are never trimmed.
  const material = await crypto.subtle.importKey('raw', await keyedHash(env, 'recite-password-v1', password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, material, 256));
}

async function newRecovery() {
  const value = randomToken();
  return { code: value.match(/.{8}/g).join('-'), hash: await hash(`recite-recovery-v1:${value}`) };
}

async function authLimit(request, env, action, username) {
  const now = Date.now();
  // Only Cloudflare's trusted connection header is used. Forwarded client IP
  // headers are not accepted. Missing IPs intentionally share a restrictive bucket.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const special = action === 'register' || action === 'recover';
  const period = special ? 3600000 : 900000;
  const specs = [
    { kind: 'ip-all', value: ip, period: 3600000, limit: 80 },
    { kind: `${action}:ip`, value: ip, period, limit: special ? 5 : 30 },
  ];
  if (username) specs.push({ kind: `${action}:username`, value: username, period, limit: special ? 5 : 10 });
  const statements = [];
  for (const spec of specs) {
    const key = hex(await keyedHash(env, 'recite-rate-v1', `${spec.kind}:${spec.value}`));
    spec.resetAt = (Math.floor(now / spec.period) + 1) * spec.period;
    statements.push(env.DB.prepare(`
      INSERT INTO recite_auth_limits (key_hash, window_start, attempts, expires_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(key_hash, window_start) DO UPDATE SET attempts = min(attempts + 1, ?)
      RETURNING attempts
    `).bind(key, spec.resetAt - spec.period, spec.resetAt + 86400000, spec.limit + 1));
  }
  // D1 executes this batch as a transaction, including simultaneous attempts.
  // Counters persist across isolates and are independent of account existence.
  const results = await env.DB.batch(statements);
  let retryAfter = 0;
  results.forEach((result, index) => {
    if (result.results[0]?.attempts > specs[index].limit) retryAfter = Math.max(retryAfter, Math.ceil((specs[index].resetAt - now) / 1000));
  });
  return retryAfter ? json({ error: 'Too many attempts. Please try again later.', code: 'rate_limited', retryAfter }, 429, { 'Retry-After': String(retryAfter) }) : null;
}

async function credentialsBody(request) {
  try {
    const data = await readJson(request);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

async function sessionResult(user, token, extra = {}) {
  return json({ user, csrfToken: await hash(`csrf:${token}`), ...extra }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, token, SESSION_SECONDS) });
}

async function registerPassword(request, env, data) {
  const username = usernameValue(data?.username);
  const limited = await authLimit(request, env, 'register', username);
  if (limited) return limited;
  if (!username) return credentialError('Use 3–32 letters, numbers, or underscores for your username.', 'invalid_username');
  if (!validPassword(data?.password)) return credentialError('Use a password with 12–128 characters.', 'invalid_password');
  const unavailable = () => credentialError('That username is unavailable. Please choose another.', 'username_unavailable', 409);
  if (await env.DB.prepare('SELECT user_id FROM recite_password_accounts WHERE username = ?').bind(username).first()) return unavailable();
  const salt = randomToken(), digest = await passwordHash(env, data.password, salt);
  const recovery = await newRecovery(), now = Date.now(), id = `local:${crypto.randomUUID()}`, token = randomToken();
  const statements = [
    // Local accounts have no email identity. They are never merged with Google
    // accounts by a typed name, unverified email, or a shared browser checkpoint.
    env.DB.prepare('INSERT INTO recite_users (id, email, name, created_at) VALUES (?, ?, ?, ?)').bind(id, '', username, now),
    env.DB.prepare(`
      INSERT INTO recite_password_accounts (user_id, username, password_hash, password_salt, password_iterations, recovery_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, username, digest, salt, PASSWORD_ITERATIONS, recovery.hash, now, now),
    env.DB.prepare('INSERT INTO recite_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hash(token), id, now + SESSION_SECONDS * 1000),
  ];
  const oldToken = readCookie(request, SESSION_COOKIE);
  if (isToken(oldToken)) statements.push(env.DB.prepare('DELETE FROM recite_sessions WHERE token_hash = ?').bind(await hash(oldToken)));
  try { await env.DB.batch(statements); }
  catch (error) {
    // The unique constraint also closes concurrent signup races. The entire
    // batch rolls back, so no orphan profile or session is left behind.
    if (await env.DB.prepare('SELECT user_id FROM recite_password_accounts WHERE username = ?').bind(username).first()) return unavailable();
    throw error;
  }
  return sessionResult(localUser(id, username), token, { recoveryCode: recovery.code });
}

async function loginPassword(request, env, data) {
  const username = usernameValue(data?.username);
  const limited = await authLimit(request, env, 'login', username);
  if (limited) return limited;
  if (!username || !validPassword(data?.password)) return passwordFailure();
  const identity = await env.DB.prepare('SELECT * FROM recite_password_accounts WHERE username = ?').bind(username).first();
  // Unknown usernames take the same KDF work as a known account. Errors never
  // distinguish an absent account, invalid password, or a concurrent reset.
  const digest = await passwordHash(env, data.password, identity?.password_salt || '0'.repeat(64), identity?.password_iterations || PASSWORD_ITERATIONS);
  if (!identity || !sameToken(digest, identity.password_hash)) return passwordFailure();
  const token = randomToken(), tokenHash = await hash(token), now = Date.now();
  const statements = [env.DB.prepare(`
    INSERT INTO recite_sessions (token_hash, user_id, expires_at)
    SELECT ?, user_id, ? FROM recite_password_accounts
    WHERE user_id = ? AND credential_version = ? AND password_hash = ?
    RETURNING user_id
  `).bind(tokenHash, now + SESSION_SECONDS * 1000, identity.user_id, identity.credential_version, identity.password_hash)];
  const oldToken = readCookie(request, SESSION_COOKIE);
  if (isToken(oldToken)) statements.push(env.DB.prepare(`
    DELETE FROM recite_sessions WHERE token_hash = ?
    AND EXISTS (SELECT 1 FROM recite_sessions WHERE token_hash = ?)
  `).bind(await hash(oldToken), tokenHash));
  const result = await env.DB.batch(statements);
  if (!result[0].results.length) return passwordFailure();
  return sessionResult(localUser(identity.user_id, username), token);
}

async function recoverPassword(request, env, data) {
  const username = usernameValue(data?.username);
  const limited = await authLimit(request, env, 'recover', username);
  if (limited) return limited;
  if (!username) return recoveryFailure();
  if (!validPassword(data?.password)) return credentialError('Use a password with 12–128 characters.', 'invalid_password');
  const recoveryCode = recoveryValue(data?.recoveryCode);
  const recoveryHash = await hash(`recite-recovery-v1:${recoveryCode}`);
  const identity = await env.DB.prepare('SELECT * FROM recite_password_accounts WHERE username = ?').bind(username).first();
  if (!identity || !isToken(recoveryCode) || !sameToken(recoveryHash, identity.recovery_hash)) return recoveryFailure();
  const salt = randomToken(), digest = await passwordHash(env, data.password, salt), recovery = await newRecovery(), now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE recite_password_accounts SET password_hash = ?, password_salt = ?, password_iterations = ?,
        recovery_hash = ?, credential_version = credential_version + 1, updated_at = ?
      WHERE user_id = ? AND recovery_hash = ? AND credential_version = ?
      RETURNING user_id
    `).bind(digest, salt, PASSWORD_ITERATIONS, recovery.hash, now, identity.user_id, recoveryHash, identity.credential_version),
    env.DB.prepare(`
      DELETE FROM recite_sessions WHERE user_id = ?
      AND EXISTS (SELECT 1 FROM recite_password_accounts WHERE user_id = ? AND recovery_hash = ?)
    `).bind(identity.user_id, identity.user_id, recovery.hash),
  ]);
  if (!results[0].results.length) return recoveryFailure();
  // A recovery code is single-use. A replacement is returned only in this
  // uncached response; forgotten passwords never trigger fictitious email.
  return json({ recovered: true, recoveryCode: recovery.code }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
}

async function changePassword(request, env, account) {
  if (account.user.provider !== 'password') return credentialError('This account uses Google sign-in.', 'google_account', 400);
  const data = await credentialsBody(request), limited = await authLimit(request, env, 'change', account.user.username);
  if (limited) return limited;
  if (!validPassword(data?.newPassword)) return credentialError('Use a password with 12–128 characters.', 'invalid_password');
  const failure = () => credentialError('The current password is incorrect. Please sign in again if your account changed.', 'current_password_incorrect', 401);
  if (!validPassword(data?.currentPassword)) return failure();
  const identity = await env.DB.prepare('SELECT * FROM recite_password_accounts WHERE user_id = ?').bind(account.user.id).first();
  if (!identity) return failure();
  const actual = await passwordHash(env, data.currentPassword, identity.password_salt, identity.password_iterations);
  if (!sameToken(actual, identity.password_hash)) return failure();
  const salt = randomToken(), digest = await passwordHash(env, data.newPassword, salt), token = randomToken(), now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE recite_password_accounts SET password_hash = ?, password_salt = ?, password_iterations = ?,
        credential_version = credential_version + 1, updated_at = ?
      WHERE user_id = ? AND password_hash = ? AND credential_version = ?
      AND EXISTS (SELECT 1 FROM recite_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?)
      RETURNING user_id
    `).bind(digest, salt, PASSWORD_ITERATIONS, now, identity.user_id, identity.password_hash, identity.credential_version, await hash(account.token), identity.user_id, now),
    env.DB.prepare(`
      DELETE FROM recite_sessions WHERE user_id = ?
      AND EXISTS (SELECT 1 FROM recite_password_accounts WHERE user_id = ? AND password_hash = ?)
    `).bind(identity.user_id, identity.user_id, digest),
    env.DB.prepare(`
      INSERT INTO recite_sessions (token_hash, user_id, expires_at)
      SELECT ?, user_id, ? FROM recite_password_accounts WHERE user_id = ? AND password_hash = ?
      RETURNING user_id
    `).bind(await hash(token), now + SESSION_SECONDS * 1000, identity.user_id, digest),
  ]);
  if (!results[0].results.length || !results[2].results.length) return failure();
  return sessionResult(localUser(identity.user_id, identity.username), token);
}

async function savedProgress(env, userId) {
  const row = await env.DB.prepare('SELECT payload, version, updated_at FROM recite_progress WHERE user_id = ?')
    .bind(userId).first();
  return {
    progress: row ? JSON.parse(row.payload) : null,
    version: row?.version || 0,
    updatedAt: row?.updated_at || null,
  };
}

async function login(request, env, origin) {
  const url = new URL(request.url);
  const state = randomToken(), nonce = randomToken(), verifier = randomToken();
  const previousState = readCookie(request, FLOW_COOKIE);
  const statements = [];
  if (isToken(previousState)) statements.push(env.DB.prepare('DELETE FROM recite_oauth_states WHERE state_hash = ?').bind(await hash(previousState)));
  statements.push(env.DB.prepare(`
    INSERT INTO recite_oauth_states (state_hash, nonce, verifier, return_to, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(await hash(state), nonce, verifier, returnPath(url.searchParams.get('returnTo')), Date.now() + FLOW_SECONDS * 1000));
  await env.DB.batch(statements);
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/account/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state, nonce,
    code_challenge: base64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return redirect(target.href, [cookie(FLOW_COOKIE, state, FLOW_SECONDS)]);
}

async function callback(request, env, origin) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const failed = path => redirect(accountReturn(origin, path, 'error'), [cookie(FLOW_COOKIE, '', 0)]);
  if (!sameToken(state, readCookie(request, FLOW_COOKIE))) return failed('/');
  // Consume a browser-bound flow exactly once, including failed provider returns.
  const flow = await env.DB.prepare(`
    DELETE FROM recite_oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING *
  `).bind(await hash(state), Date.now()).first();
  if (!flow) return failed('/');
  if (url.searchParams.has('error') || !url.searchParams.get('code')) return failed(flow.return_to);
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        code: url.searchParams.get('code'),
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${origin}/api/account/callback`,
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return failed(flow.return_to);
    const tokens = await response.json();
    if (typeof tokens.id_token !== 'string') return failed(flow.return_to);
    const { payload: claims } = await jwtVerify(tokens.id_token, googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'],
      maxTokenAge: '10m',
      clockTolerance: 5,
    });
    if (!sameToken(claims.nonce, flow.nonce) || claims.email_verified !== true ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
        typeof claims.email !== 'string' || !claims.email || claims.email.length > 254 ||
        (claims.azp && claims.azp !== env.GOOGLE_CLIENT_ID)) return failed(flow.return_to);
    const now = Date.now(), token = randomToken();
    const statements = [
      env.DB.prepare(`
        INSERT INTO recite_users (id, email, name, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name
      `).bind(claims.sub, claims.email, String(claims.name || 'Reader').slice(0, 100), now),
      env.DB.prepare('INSERT INTO recite_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(await hash(token), claims.sub, now + SESSION_SECONDS * 1000),
    ];
    const oldToken = readCookie(request, SESSION_COOKIE);
    if (isToken(oldToken)) statements.push(env.DB.prepare('DELETE FROM recite_sessions WHERE token_hash = ?').bind(await hash(oldToken)));
    await env.DB.batch(statements);
    // Only the session cookie leaves the server. Google tokens are not stored.
    return redirect(accountReturn(origin, flow.return_to, 'connected'), [
      cookie(SESSION_COOKIE, token, SESSION_SECONDS), cookie(FLOW_COOKIE, '', 0),
    ]);
  } catch { return failed(flow.return_to); }
}

async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/api/account' && !path.startsWith('/api/account/')) return json({ error: 'Not found.' }, 404);
  const origin = appOrigin(env);
  if (!origin || !env.DB) {
    return json({ configured: false, user: null, error: 'Accounts are not configured yet.' }, 503);
  }
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (url.origin !== origin) return json({ error: 'Use the website account address.' }, 403);
  const mutation = !['GET', 'HEAD'].includes(request.method);
  if (mutation && request.headers.get('Origin') !== origin) return json({ error: 'Request origin rejected.' }, 403);
  if (request.method === 'GET' && ['/api/account/login', '/api/account/google', '/api/account/callback'].includes(path)) {
    if (!googleConfigured) return json({ error: 'Google sign-in is not configured yet.', code: 'google_not_configured' }, 503);
    return path === '/api/account/callback' ? callback(request, env, origin) : login(request, env, origin);
  }

  if (request.method === 'POST' && PASSWORD_ACTIONS.has(path)) {
    if (!await passwordConfigured(env)) return credentialError('Username and password sign-in is not configured yet. You can still use Google.', 'password_not_configured', 503);
    const data = await credentialsBody(request);
    if (path === '/api/account/register') return registerPassword(request, env, data);
    if (path === '/api/account/password-login') return loginPassword(request, env, data);
    return recoverPassword(request, env, data);
  }

  const account = await authenticate(request, env);
  if (request.method === 'GET' && path === '/api/account/me') {
    return json({ configured: true, googleConfigured, passwordConfigured: await passwordConfigured(env), user: account?.user || null, csrfToken: account?.csrfToken || null });
  }
  if (!account) return json({ error: 'Please sign in again.' }, 401);
  if ((mutation || path === '/api/account/progress') && request.headers.get('X-Account-User') !== account.user.id) {
    // A second tab may have replaced this browser's cookie since /me was read.
    // This header asserts the UI's confirmed identity; it never selects an owner.
    return json({ error: 'Your account changed. Please reopen your account and try again.' }, 401);
  }
  if (mutation && !sameToken(request.headers.get('X-CSRF-Token'), account.csrfToken)) return json({ error: 'Please reopen your account and try again.' }, 403);
  const { user } = account;

  if (request.method === 'POST' && path === '/api/account/password') {
    if (!await passwordConfigured(env)) return credentialError('Password changes are not configured yet.', 'password_not_configured', 503);
    return changePassword(request, env, account);
  }
  if (request.method === 'GET' && path === '/api/account/progress') return json(await savedProgress(env, user.id));
  if (request.method === 'PUT' && path === '/api/account/progress') {
    let data;
    try { data = await readJson(request); } catch { return json({ error: 'Invalid progress.' }, 400); }
    const progress = cleanProgress(data?.progress);
    if (!progress || !integer(data.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1)) return json({ error: 'Invalid progress.' }, 400);
    const updatedAt = Date.now(), payload = JSON.stringify(progress);
    // Compare-and-swap is atomic in D1. A second device never silently wins.
    const row = data.expectedVersion === 0
      ? await env.DB.prepare(`
          INSERT INTO recite_progress (user_id, payload, version, updated_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(user_id) DO NOTHING RETURNING version
        `).bind(user.id, payload, updatedAt).first()
      : await env.DB.prepare(`
          UPDATE recite_progress SET payload = ?, version = version + 1, updated_at = ?
          WHERE user_id = ? AND version = ? RETURNING version
        `).bind(payload, updatedAt, user.id, data.expectedVersion).first();
    if (row) return json({ version: row.version, updatedAt });
    return json({ error: 'Progress changed on another device.', ...await savedProgress(env, user.id) }, 409);
  }
  if (request.method === 'POST' && path === '/api/account/logout') {
    await env.DB.prepare('DELETE FROM recite_sessions WHERE token_hash = ?').bind(await hash(account.token)).run();
    return json({}, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
  }
  if (request.method === 'DELETE' && ['/api/account', '/api/account/account'].includes(path)) {
    const statements = [
      env.DB.prepare('DELETE FROM recite_progress WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM recite_sessions WHERE user_id = ?').bind(user.id),
    ];
    if (user.provider === 'password') statements.push(env.DB.prepare('DELETE FROM recite_password_accounts WHERE user_id = ?').bind(user.id));
    statements.push(
      env.DB.prepare('DELETE FROM recite_users WHERE id = ?').bind(user.id),
    );
    await env.DB.batch(statements);
    return json({}, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch {
      // Do not log credentials, cookies, provider responses, or user data.
      return json({ error: 'Account service unavailable. Your browser copy is still available.' }, 503);
    }
  },
  async scheduled(event, env) {
    if (!env.DB) return;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM recite_oauth_states WHERE expires_at < ?').bind(Date.now()),
      env.DB.prepare('DELETE FROM recite_sessions WHERE expires_at < ?').bind(Date.now()),
    ]);
    if (await passwordConfigured(env)) await env.DB.prepare('DELETE FROM recite_auth_limits WHERE expires_at < ?').bind(Date.now()).run();
  },
};
