import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHumanAuth } from './human-auth.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const keyPairs = Promise.all([generateKeyPair('RS256', { extractable: true }), generateKeyPair('RS256', { extractable: true })]);
const config = { issuer: 'https://issuer.example', client_id: 'gitpunk-human', client_secret: 'provider-client-secret', public_url: 'http://127.0.0.1:8787', allow_loopback_http: true };
async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-human-auth-')), file = join(root, 'auth.sqlite');
  const [trusted, attacker] = await keyPairs, jwk = { ...await exportJWK(trusted.publicKey), kid: 'trusted', alg: 'RS256', use: 'sig' };
  let cfg = { ...config, ...overrides }, db = new DatabaseSync(file), auth;
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active'); CREATE TABLE repos(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id)); CREATE TABLE access(repo_id TEXT,user_id TEXT,role TEXT); INSERT INTO users VALUES('alice','Alice','active'); INSERT INTO repos VALUES('demo','alice'); INSERT INTO access VALUES('demo','alice','admin');");
  const codes = new Map(), calls = []; let fault = {};
  const fetchImpl = async (resource, options) => {
    calls.push({ url: resource, method: options.method });
    assert.equal(new URL(resource).protocol, 'https:'); assert.equal(options.redirect, 'error');
    if (fault.transport) throw new Error(`provider-refresh-secret ${cfg.client_secret}`);
    if (fault.oversized === 'all' || fault.oversized === new URL(resource).pathname) return new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
    if (resource.endsWith('/.well-known/openid-configuration')) {
      if (fault.hang) return new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } });
      return Response.json({ issuer: fault.discoveryIssuer ?? cfg.issuer, authorization_endpoint: 'https://issuer.example/authorize', token_endpoint: fault.tokenEndpoint ?? 'https://tokens.example/token', jwks_uri: 'https://keys.example/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    }
    if (resource === 'https://keys.example/jwks') return Response.json({ keys: [jwk] });
    assert.equal(resource, 'https://tokens.example/token');
    const body = new URLSearchParams(options.body);
    const code = codes.get(body.get('code')); assert.ok(code, 'unknown offline authorization code');
    assert.equal(body.get('redirect_uri'), new URL('/auth/callback', cfg.public_url).href);
    assert.equal(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url'), code.params.get('code_challenge'));
    const authHeader = new Headers(options.headers).get('authorization');
    assert.ok(body.get('client_secret') === cfg.client_secret || authHeader === `Basic ${Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64')}`);
    const now = Math.floor(Date.now() / 1000), claims = { iss: cfg.issuer, sub: fault.subject ?? 'external-human', aud: cfg.client_id, exp: now + 300, iat: now, nonce: code.params.get('nonce'), name: 'Alice', email: 'alice@example.invalid', ...fault.claims };
    const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'trusted' }).sign(fault.badSignature ? attacker.privateKey : trusted.privateKey);
    return Response.json({ access_token: 'provider-access-secret', refresh_token: 'provider-refresh-secret', token_type: 'Bearer', expires_in: 300, ...(fault.missingId ? {} : { id_token: idToken }) });
  };
  const initialize = () => auth = createHumanAuth({ db, config: cfg, fetchImpl }); initialize();
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', cookie, headers = {}, rawUrl = route } = {}) {
    const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body = '') { this.body = body; } };
    try {
      const handled = await auth.handle({ method, url: rawUrl, headers: { host: new URL(cfg.public_url).host, ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: '127.0.0.1' } }, response, new URL(route, 'http://localhost'));
      return { ...response, handled, ...(response.body ? { json: JSON.parse(response.body) } : {}) };
    } catch (error) { return { ...response, error, statusCode: error.status ?? 500 }; }
  }
  function responseCookie(response, type) {
    const values = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']];
    return values.find(value => value?.startsWith(cfg.public_url.startsWith('https:') ? `__Host-gitpunk_${type}=` : `gitpunk_dev_${type}=`))?.split(';')[0];
  }
  async function login() {
    const response = await request('/auth/login'); assert.equal(response.statusCode, 302, response.error?.message);
    const params = new URL(response.headers.location).searchParams, code = randomUUID(); codes.set(code, { params });
    const query = new URLSearchParams({ state: params.get('state'), code });
    return { response, params, code, callback: `/auth/callback?${query}`, cookie: responseCookie(response, 'login') };
  }
  async function signIn() { const flow = await login(), response = await request(flow.callback, { cookie: flow.cookie }); return { flow, response, cookie: responseCookie(response, 'session') }; }
  return { get db() { return db; }, get auth() { return auth; }, get cfg() { return cfg; }, calls, request, login, signIn, responseCookie, fault(value) { fault = value; }, restart(options = {}) { db.close(); db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON'); cfg = { ...cfg, ...options }; initialize(); } };
}

test('optional disabled auth and configuration validation make no startup requests', async () => {
  const disabled = createHumanAuth({ db: {}, config: undefined, fetchImpl() { assert.fail('startup fetch'); } });
  assert.equal(disabled.configured, false);
  assert.equal(await disabled.handle({}, {}, new URL('http://localhost/health')), false);
  await assert.rejects(disabled.handle({}, {}, new URL('http://localhost/me')), { code: 'human_auth_not_configured' });
  for (const change of [{ issuer: 'http://issuer.example' }, { issuer: 'https://issuer.example/.well-known/openid-configuration' }, { public_url: 'http://external.example', allow_loopback_http: true }, { public_url: 'http://localhost', allow_loopback_http: false }, { public_url: 'https://gitpunk.example/path' }, { public_url: 'https://user:password@gitpunk.example' }]) assert.throws(() => createHumanAuth({ db: {}, config: { ...config, ...change } }), { code: 'invalid_auth_config' });
});

test('signed Google-shaped three-host OIDC with PKCE creates a distinct human and persists only opaque session hashes', async t => {
  const env = await setup(t);
  assert.equal(env.calls.length, 0);
  const { flow, response, cookie } = await env.signIn();
  assert.equal(response.statusCode, 302, response.error?.message);
  assert.equal(flow.params.get('scope'), 'openid profile'); assert.equal(flow.params.get('code_challenge_method'), 'S256');
  assert.equal(flow.params.get('redirect_uri'), 'http://127.0.0.1:8787/auth/callback');
  assert.equal(response.headers.location, 'http://127.0.0.1:8787/me');
  assert.match(cookie, /^gitpunk_dev_session=[A-Za-z0-9_-]{43}$/);
  const me = await env.request('/me', { cookie }); assert.equal(me.statusCode, 200);
  assert.notEqual(me.json.data.user.id, 'alice'); assert.equal(me.json.data.user.name, 'Alice');
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM access').get().n, 1);
  assert.equal(env.db.prepare('SELECT owner_id FROM repos').get().owner_id, 'alice');
  const stored = env.db.prepare('SELECT * FROM human_sessions').get();
  assert.equal(stored.token_hash, hash(cookie.split('=')[1])); assert.notEqual(stored.token_hash, cookie.split('=')[1]);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM human_logins').get().n, 0);
  assert.equal(JSON.stringify(env.db.prepare('SELECT * FROM human_sessions').all()).includes('provider-'), false);
  assert.equal(JSON.stringify(me.json).includes('provider-'), false);
  const calls = env.calls.length; env.restart();
  assert.equal((await env.request('/me', { cookie })).json.data.user.id, me.json.data.user.id); assert.equal(env.calls.length, calls);
  const again = await env.signIn(); assert.equal((await env.request('/me', { cookie: again.cookie })).json.data.user.id, me.json.data.user.id);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM human_identities').get().n, 1);
  env.restart({ issuer: 'https://another-issuer.example' });
  const different = await env.signIn(); assert.equal(different.response.statusCode, 302, different.response.error?.message);
  assert.notEqual((await env.request('/me', { cookie: different.cookie })).json.data.user.id, me.json.data.user.id);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM human_identities').get().n, 2);
});

test('state and browser cookie bind a one-use login, expiry and replay stop before code exchange', async t => {
  const env = await setup(t), flow = await env.login();
  const calls = env.calls.length;
  assert.equal((await env.request(flow.callback, { cookie: `gitpunk_dev_login=${'x'.repeat(43)}` })).error.code, 'invalid_login_transaction');
  assert.equal((await env.request(`${flow.callback}&state=${flow.params.get('state')}`, { cookie: flow.cookie })).error.code, 'invalid_login_transaction');
  assert.equal(env.calls.length, calls);
  const valid = await env.request(flow.callback, { cookie: flow.cookie }); assert.equal(valid.statusCode, 302);
  const after = env.calls.length;
  assert.equal((await env.request(flow.callback, { cookie: flow.cookie })).error.code, 'invalid_login_transaction'); assert.equal(env.calls.length, after);
  const expired = await env.login(); env.db.prepare('UPDATE human_logins SET expires=?').run(Date.now() - 1);
  const prior = env.calls.length;
  assert.equal((await env.request(expired.callback, { cookie: expired.cookie })).error.code, 'invalid_login_transaction'); assert.equal(env.calls.length, prior);
});

for (const [name, fault] of [
  ['signature', { badSignature: true }], ['issuer', { claims: { iss: 'https://attacker.example' } }], ['audience', { claims: { aud: 'another-client' } }], ['single-audience authorized party', { claims: { azp: 'another-client' } }], ['nonce', { claims: { nonce: 'wrong-nonce' } }], ['missing ID token', { missingId: true }], ['strict expiry', { claims: { exp: Math.floor(Date.now() / 1000) - 1 } }], ['future issue time', { claims: { iat: Math.floor(Date.now() / 1000) + 3600 } }],
]) test(`rejects ${name} and consumes the transaction before exchange`, async t => {
  const env = await setup(t), flow = await env.login(); env.fault(fault);
  const denied = await env.request(flow.callback, { cookie: flow.cookie }); assert.equal(denied.error.code, 'oidc_login_failed'); assert.equal(denied.statusCode, 401);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM human_sessions').get().n, 0);
  const calls = env.calls.length;
  assert.equal((await env.request(flow.callback, { cookie: flow.cookie })).error.code, 'invalid_login_transaction'); assert.equal(env.calls.length, calls);
  assert.equal(String(denied.error).includes('provider-'), false);
});

test('fixed host and callback prohibit forwarded or absolute redirect injection; secure cookies use host prefix', async t => {
  const env = await setup(t, { public_url: 'https://gitpunk.example', allow_loopback_http: false });
  assert.equal((await env.request('/auth/login?return_to=https://attacker.example')).error.code, 'invalid_auth_request');
  assert.equal((await env.request('/auth/login', { headers: { host: 'attacker.example' } })).error.code, 'auth_origin_mismatch');
  assert.equal((await env.request('/auth/login', { rawUrl: 'https://attacker.example/auth/login' })).error.code, 'auth_origin_mismatch');
  assert.equal(env.calls.length, 0);
  const flow = await env.login(); assert.match(flow.response.headers['set-cookie'], /^__Host-gitpunk_login=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  const result = await env.request(flow.callback, { cookie: flow.cookie, headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' } });
  assert.equal(result.headers.location, 'https://gitpunk.example/me');
  assert.match(env.responseCookie(result, 'session'), /^__Host-gitpunk_session=/);
  assert.ok(result.headers['set-cookie'].every(value => value.endsWith('; Secure')));
});

test('logout requires exact origin and POST, revokes durable session; blocked users and expired sessions fail closed', async t => {
  const env = await setup(t), signed = await env.signIn();
  assert.equal((await env.request('/auth/logout', { cookie: signed.cookie })).statusCode, 405);
  assert.equal((await env.request('/auth/logout', { method: 'POST', cookie: signed.cookie, headers: { origin: 'https://attacker.example' } })).error.code, 'logout_origin_denied');
  assert.equal((await env.request('/me', { cookie: signed.cookie })).statusCode, 200);
  const result = await env.request('/auth/logout', { method: 'POST', cookie: signed.cookie, headers: { origin: new URL(config.public_url).origin } });
  assert.equal(result.json.data.logged_out, true); assert.match(result.headers['set-cookie'], /Max-Age=0/);
  assert.equal(env.db.prepare('SELECT revoked FROM human_sessions').get().revoked, 1);
  env.restart(); assert.equal((await env.request('/me', { cookie: signed.cookie })).statusCode, 401);
  const next = await env.signIn(); env.db.prepare("UPDATE users SET state='blocked' WHERE id=(SELECT user_id FROM human_identities LIMIT 1)").run();
  assert.equal((await env.request('/me', { cookie: next.cookie })).statusCode, 401);
  const blocked = await env.signIn(); assert.equal(blocked.response.error.code, 'human_blocked');
  env.db.prepare("UPDATE users SET state='active'").run(); env.db.prepare('UPDATE human_sessions SET expires=?').run(Date.now() - 1);
  assert.equal((await env.request('/me', { cookie: next.cookie })).statusCode, 401);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM human_sessions').get().n, 0);
});

test('discovery, token and JWKS responses are bounded; failed discovery can retry without leaking provider errors', async t => {
  const env = await setup(t); env.fault({ transport: true });
  const failure = await env.request('/auth/login'); assert.equal(failure.error.code, 'oidc_unavailable'); assert.equal(String(failure.error).includes('provider-'), false);
  env.fault({ oversized: 'all' }); assert.equal((await env.request('/auth/login')).error.code, 'oidc_unavailable');
  env.fault({ discoveryIssuer: 'https://attacker.example' }); assert.equal((await env.request('/auth/login')).error.code, 'oidc_unavailable');
  env.fault({ tokenEndpoint: 'http://tokens.example/token' }); assert.equal((await env.request('/auth/login')).error.code, 'oidc_unavailable');
  env.fault({}); const first = await env.login(); env.fault({ oversized: '/token' });
  assert.equal((await env.request(first.callback, { cookie: first.cookie })).error.code, 'oidc_login_failed');
  env.fault({}); const next = await env.login(); env.fault({ oversized: '/jwks' });
  assert.equal((await env.request(next.callback, { cookie: next.cookie })).error.code, 'oidc_login_failed');
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM human_sessions').get().n, 0);
});

test('pending capacity and per-address rate limits are enforced before discovery', async t => {
  const env = await setup(t);
  env.db.exec('BEGIN'); const insert = env.db.prepare('INSERT INTO human_logins VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 500; index++) insert.run(`state-${index}`, `cookie-${index}`, 'nonce', 'verifier', Date.now() + 60_000, Date.now());
  env.db.exec('COMMIT');
  assert.equal((await env.request('/auth/login')).error.code, 'auth_capacity'); assert.equal(env.calls.length, 0);
  env.db.exec('DELETE FROM human_logins'); env.fault({ transport: true });
  for (let index = 0; index < 9; index++) assert.equal((await env.request('/auth/login')).error.code, 'oidc_unavailable');
  const calls = env.calls.length;
  assert.equal((await env.request('/auth/login')).error.code, 'auth_rate_limited'); assert.equal(env.calls.length, calls);
});

test('a stalled discovery body times out and cannot leave a pending login', { timeout: 15_000 }, async t => {
  const env = await setup(t); env.fault({ hang: true });
  const started = Date.now(), result = await env.request('/auth/login');
  assert.equal(result.error.code, 'oidc_unavailable'); assert.ok(Date.now() - started >= 9000 && Date.now() - started < 14_000);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM human_logins').get().n, 0);
});
