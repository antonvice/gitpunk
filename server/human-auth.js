import { randomBytes, randomUUID, createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import { ProtocolError } from '../shared/index.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const fail = (code, message, status = 400) => { throw new ProtocolError(code, message, status); };
const routes = new Map([['/auth/login', 'GET'], ['/auth/callback', 'GET'], ['/me', 'GET'], ['/auth/logout', 'POST']]);
const LOGIN_TTL = 10 * 60_000, SESSION_TTL = 8 * 60 * 60_000, MAX_RESPONSE = 256 * 1024;
function transaction(db, action) { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
function secureUrl(value) {
  let url; try { url = new URL(value); } catch { fail('invalid_auth_config', 'OIDC URLs must be valid HTTPS URLs.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('invalid_auth_config', 'Provider URLs must use HTTPS without credentials or fragments.');
  return url;
}
function cookie(request, name) {
  const header = request.headers.cookie ?? '';
  if (header.length > 4096) fail('invalid_cookie', 'Cookie header is too large.');
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
  if (values.length > 1 || values.length && !/^[A-Za-z0-9_-]{43}$/.test(values[0])) fail('invalid_cookie', 'Invalid authentication cookie.');
  return values[0];
}

/** One provider, local SQLite state. Initialization never contacts the issuer. */
export function createHumanAuth({ db, config, fetchImpl = globalThis.fetch }) {
  if (config === undefined || config === null || config === false) return { configured: false, async handle(_request, _response, url) { if (!routes.has(url.pathname)) return false; fail('human_auth_not_configured', 'Human sign-in is not configured.', 503); } };
  if (!config || typeof config !== 'object' || typeof config.client_id !== 'string' || !config.client_id || config.client_id.length > 512 || /[\x00-\x1f\x7f]/.test(config.client_id) || typeof config.client_secret !== 'string' || !config.client_secret || config.client_secret.length > 4096 || /[\x00-\x1f\x7f]/.test(config.client_secret)) fail('invalid_auth_config', 'Issuer, client ID, client secret and public URL are required.');
  const issuer = secureUrl(config.issuer);
  if (issuer.search || issuer.pathname.split('/').includes('.well-known')) fail('invalid_auth_config', 'Configure the issuer URL, without a query or discovery path.');
  let publicUrl; try { publicUrl = new URL(config.public_url); } catch { fail('invalid_auth_config', 'Public URL must be a fixed origin.'); }
  const local = publicUrl.protocol === 'http:' && config.allow_loopback_http === true && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !local || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) fail('invalid_auth_config', 'Use a public HTTPS origin or explicitly allowed loopback HTTP.');
  const origin = publicUrl.origin, callback = new URL('/auth/callback', origin).href;
  const sessionCookie = local ? 'gitpunk_dev_session' : '__Host-gitpunk_session', loginCookie = local ? 'gitpunk_dev_login' : '__Host-gitpunk_login';
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_identities(issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(issuer,subject));
    CREATE TABLE IF NOT EXISTS human_logins(state_hash TEXT PRIMARY KEY, cookie_hash TEXT UNIQUE NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS human_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS human_auth_rates(bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  let discovery;
  async function boundedFetch(resource, options) {
    secureUrl(resource);
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]);
    let reader, abort;
    const cancelled = new Promise((_, reject) => { abort = () => { void reader?.cancel().catch(() => {}); reject(new Error('OIDC request aborted')); }; signal.addEventListener('abort', abort, { once: true }); });
    try {
      return await Promise.race([cancelled, (async () => {
        const response = await fetchImpl(resource, { ...options, redirect: 'error', signal });
        signal.throwIfAborted();
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw new Error('OIDC response too large');
        reader = response.body?.getReader();
        if (!reader) throw new Error('OIDC response missing');
        const chunks = []; let size = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('OIDC response too large'); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
      })()]);
    } finally { signal.removeEventListener('abort', abort); }
  }
  async function provider() {
    if (!discovery) discovery = oidc.discovery(issuer, config.client_id, config.client_secret, undefined, { timeout: 10, [oidc.customFetch]: boundedFetch, execute: [oidc.enableNonRepudiationChecks] }).then(value => {
      const metadata = value.serverMetadata();
      if (secureUrl(metadata.issuer).href !== issuer.href) throw new Error('Issuer mismatch');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) secureUrl(metadata[key]);
      return value;
    }).catch(() => { discovery = undefined; fail('oidc_unavailable', 'Identity provider is unavailable.', 503); });
    return discovery;
  }
  function setCookie(name, value, age) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${local ? '' : '; Secure'}`; }
  function headers(response) { response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff'); }
  function json(response, data) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, data, error: null })); }
  function prune() {
    const now = Date.now();
    db.prepare('DELETE FROM human_logins WHERE expires<=?').run(now);
    db.prepare('DELETE FROM human_sessions WHERE expires<=?').run(now);
    db.prepare('DELETE FROM human_auth_rates WHERE expires<=?').run(now);
  }
  function rate(request, kind, limit) {
    const bucket = `${kind}:${hash(request.socket?.remoteAddress ?? 'local')}`;
    const old = db.prepare('SELECT * FROM human_auth_rates WHERE bucket=?').get(bucket);
    if (old?.count >= limit || !old && db.prepare('SELECT count(*) AS n FROM human_auth_rates').get().n >= 1000) fail('auth_rate_limited', 'Too many authentication requests.', 429);
    db.prepare('INSERT INTO human_auth_rates(bucket,count,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(bucket, Date.now() + 60_000);
  }
  function session(request) {
    const token = cookie(request, sessionCookie);
    const row = token && db.prepare('SELECT s.*,u.name,u.state FROM human_sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?').get(hash(token));
    if (!row || row.revoked || row.expires <= Date.now() || row.state !== 'active') fail('human_unauthenticated', 'Human session is missing, expired or revoked.', 401);
    return row;
  }
  return {
    configured: true,
    async handle(request, response, url) {
      if (!routes.has(url.pathname)) return false;
      headers(response);
      if (request.method !== routes.get(url.pathname)) fail('method_not_allowed', 'Authentication route does not support this method.', 405);
      if (request.headers.host !== publicUrl.host || !(request.url ?? '').startsWith('/') || request.url.startsWith('//')) fail('auth_origin_mismatch', 'Use the configured public origin.', 400);
      if ((request.url ?? '').length > 8192 || url.search.length > 8192) fail('invalid_auth_request', 'Authentication request is too large.');
      prune();
      if (url.pathname === '/auth/login') {
        if (url.search) fail('invalid_auth_request', 'Sign-in does not accept redirect parameters.');
        rate(request, 'login', 10);
        if (db.prepare('SELECT count(*) AS n FROM human_logins').get().n >= 500 || db.prepare('SELECT count(*) AS n FROM human_sessions').get().n >= 5000) fail('auth_capacity', 'Authentication capacity reached.', 429);
        const metadata = await provider(), state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier(), browser = random();
        const challenge = await oidc.calculatePKCECodeChallenge(verifier), now = Date.now();
        if (db.prepare('SELECT count(*) AS n FROM human_logins').get().n >= 500) fail('auth_capacity', 'Authentication capacity reached.', 429);
        db.prepare('INSERT INTO human_logins(state_hash,cookie_hash,nonce,verifier,expires,created_at) VALUES(?,?,?,?,?,?)').run(hash(state), hash(browser), nonce, verifier, now + LOGIN_TTL, now);
        const redirect = oidc.buildAuthorizationUrl(metadata, { redirect_uri: callback, response_type: 'code', scope: 'openid profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
        response.setHeader('Set-Cookie', setCookie(loginCookie, browser, LOGIN_TTL / 1000)); response.statusCode = 302; response.setHeader('Location', redirect.href); response.end();
      } else if (url.pathname === '/auth/callback') {
        rate(request, 'callback', 30);
        const states = url.searchParams.getAll('state'), browser = cookie(request, loginCookie);
        if (states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0]) || !browser) fail('invalid_login_transaction', 'Login state or browser binding is invalid.');
        if (db.prepare('SELECT count(*) AS n FROM human_sessions').get().n >= 5000) fail('auth_capacity', 'Authentication capacity reached.', 429);
        const login = db.prepare('DELETE FROM human_logins WHERE state_hash=? AND cookie_hash=? AND expires>? RETURNING *').get(hash(states[0]), hash(browser), Date.now());
        if (!login) fail('invalid_login_transaction', 'Login expired, replayed or does not belong to this browser.');
        response.setHeader('Set-Cookie', setCookie(loginCookie, '', 0));
        let claims;
        try {
          const current = new URL(callback); current.search = url.search;
          const metadata = await provider();
          const tokens = await oidc.authorizationCodeGrant(metadata, current, { pkceCodeVerifier: login.verifier, expectedState: states[0], expectedNonce: login.nonce, idTokenExpected: true });
          claims = tokens.claims();
          const now = Date.now() / 1000;
          if (!claims || claims.iss !== metadata.serverMetadata().issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512 || claims.azp !== undefined && claims.azp !== config.client_id || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp <= now || claims.iat > now + 30) throw new Error('Invalid identity claims');
        } catch { fail('oidc_login_failed', 'Identity provider authentication failed.', 401); }
        const token = random(), now = Date.now();
        const user = transaction(db, () => {
          if (db.prepare('SELECT count(*) AS n FROM human_sessions').get().n >= 5000) fail('auth_capacity', 'Authentication capacity reached.', 429);
          const existing = db.prepare('SELECT u.* FROM human_identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=? AND i.subject=?').get(issuer.href, claims.sub);
          if (existing && existing.state !== 'active') fail('human_blocked', 'Human account is blocked.', 403);
          const id = existing?.id ?? randomUUID(), name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 100) : 'Human';
          if (!existing) { db.prepare('INSERT INTO users(id,name) VALUES(?,?)').run(id, name); db.prepare('INSERT INTO human_identities(issuer,subject,user_id) VALUES(?,?,?)').run(issuer.href, claims.sub, id); }
          const old = cookie(request, sessionCookie); if (old) db.prepare('UPDATE human_sessions SET revoked=1 WHERE token_hash=?').run(hash(old));
          db.prepare('INSERT INTO human_sessions(token_hash,user_id,expires,created_at) VALUES(?,?,?,?)').run(hash(token), id, now + SESSION_TTL, now);
          return { id, name: existing?.name ?? name };
        });
        response.setHeader('Set-Cookie', [setCookie(loginCookie, '', 0), setCookie(sessionCookie, token, SESSION_TTL / 1000)]); response.statusCode = 302; response.setHeader('Location', new URL('/me', origin).href); response.end();
      } else if (url.pathname === '/me') {
        const current = session(request); json(response, { user: { id: current.user_id, name: current.name }, expires_at: current.expires });
      } else {
        if (request.headers.origin !== origin) fail('logout_origin_denied', 'Logout requires the configured origin.', 403);
        const current = session(request); db.prepare('UPDATE human_sessions SET revoked=1 WHERE token_hash=?').run(current.token_hash);
        response.setHeader('Set-Cookie', setCookie(sessionCookie, '', 0)); json(response, { logged_out: true });
      }
      return true;
    },
  };
}
