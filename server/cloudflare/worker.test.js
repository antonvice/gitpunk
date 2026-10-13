import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';
import { hashBytes } from '../../shared/index.js';

const secret = 'gitpunk-internal-test-token-only-32bytes';
const commit = 'a'.repeat(40);
const info = name => ({ id: `id-${name}`, name, remote: `https://artifacts.example/${name}.git`, defaultBranch: 'main' });
function fixture(overrides = {}) {
  const calls = [];
  const handle = name => ({
    [Symbol.dispose]() { calls.push(['dispose', name]); },
    async info() { calls.push(['info', name]); return info(name); },
    async revokeToken(token) { calls.push(['revoke', name, token]); return true; },
    async createToken(scope, ttl) { calls.push(['mint', name, scope, ttl]); return { id: 'token-id', plaintext: 'minted-secret', scope, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
    async fork(target, options) { calls.push(['fork', name, target, options]); return { ...info(target), token: 'initial-secret' }; },
    async readCommit(hash) { calls.push(['commit', name, hash]); return { hash, treeHash: 'b'.repeat(40), message: 'hello' }; },
    async readFile(args) { calls.push(['file', name, args]); return new Blob([Uint8Array.from([0, 255, 254, 10])], { type: 'application/octet-stream' }); },
    ...overrides,
  });
  const ARTIFACTS = {
    async get(name) { calls.push(['get', name]); return handle(name); },
    async create(name, options) { calls.push(['create', name, options]); return { ...info(name), token: 'initial-secret' }; },
    async import(params) { calls.push(['import', params]); return { ...info(params.target.name), token: 'initial-secret' }; },
  };
  return { calls, env: { ARTIFACTS, GITPUNK_INTERNAL_TOKEN: secret, GITPUNK_ENABLED_UNTIL: new Date(Date.now() + 60_000).toISOString(), GITPUNK_IMPORT_HOSTS: 'github.com' } };
}
function invoke(input, env, { url = 'https://bridge.example/artifacts', token = secret, headers = {}, body } = {}) {
  return worker.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: body ?? JSON.stringify(input) }), env);
}

test('bridge rejects absent/wrong server secret and cleartext before any provider call', async () => {
  const { env, calls } = fixture();
  assert.equal((await invoke({ action: 'info', repo: 'demo' }, { ...env, GITPUNK_INTERNAL_TOKEN: undefined })).status, 503);
  assert.equal((await invoke({ action: 'info', repo: 'demo' }, env, { token: 'wrong' })).status, 401);
  assert.equal((await invoke({ action: 'info', repo: 'demo' }, env, { url: 'http://bridge.example/artifacts' })).status, 400);
  assert.equal((await invoke({ action: 'info', repo: 'demo' }, { ...env, TEST_MODE: true }, { url: 'http://bridge.example/artifacts' })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await invoke({ action: 'info', repo: 'demo' }, { ...env, TEST_MODE: true }, { url: 'http://localhost/artifacts' })).status, 200);
});

test('create/import/fork revoke initial credentials and dispose every repository capability', async () => {
  const { env, calls } = fixture();
  for (const input of [{ action: 'create', name: 'new' }, { action: 'import', name: 'imported', source_url: 'https://github.com/example/repo', source_branch: 'main', depth: 1 }, { action: 'fork', repo: 'demo', name: 'forked' }]) {
    const result = await invoke(input, env);
    assert.equal(result.status, 200);
    const body = await result.text();
    assert.equal(body.includes('initial-secret'), false);
    assert.equal(JSON.parse(body).name, input.name);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.filter(call => call[0] === 'revoke').length, 3);
  assert.equal(calls.filter(call => call[0] === 'dispose').length, 4);
  assert.deepEqual(calls.find(call => call[0] === 'import')[1].source, { url: 'https://github.com/example/repo', branch: 'main', depth: 1 });
});

test('missing or expired cloud test window denies provider operations', async () => {
  const { env, calls } = fixture();
  for (const GITPUNK_ENABLED_UNTIL of [undefined, 'invalid', new Date(Date.now() - 1).toISOString()]) {
    const result = await invoke({ action: 'create', name: 'demo' }, { ...env, GITPUNK_ENABLED_UNTIL });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, 'cloud_disabled');
  }
  assert.deepEqual(calls, []);
  assert.equal((await invoke({ action: 'revoke_token', repo: 'demo', token_or_id: 'token-id' }, { ...env, GITPUNK_ENABLED_UNTIL: undefined })).status, 200);
  assert.equal(calls.some(call => call[0] === 'revoke'), true);
});

test('tokens require explicit read/write scope and bounded TTL; revoke takes token ID', async () => {
  const { env, calls } = fixture();
  for (const input of [{ action: 'mint_token', repo: 'demo', ttl: 300 }, { action: 'mint_token', repo: 'demo', scope: 'write' }, { action: 'mint_token', repo: 'demo', scope: 'read', ttl: 59 }, { action: 'mint_token', repo: 'demo', scope: 'write', ttl: 3601 }])
    assert.equal((await invoke(input, env)).status, 400);
  assert.deepEqual(calls, []);
  for (const scope of ['read', 'write']) {
    const result = await invoke({ action: 'mint_token', repo: 'demo', scope, ttl: 300 }, env);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).scope, scope);
  }
  assert.equal((await (await invoke({ action: 'revoke_token', repo: 'demo', token_or_id: 'token-id' }, env)).json()).revoked, true);
  assert.deepEqual(calls.filter(call => call[0] === 'mint').map(call => call.slice(2)), [['read', 300], ['write', 300]]);
});

test('commit/file reads pin exact SHA and hash exact binary bytes', async () => {
  const { env, calls } = fixture();
  assert.equal((await invoke({ action: 'read_commit', repo: 'demo', commit }, env)).status, 200);
  const result = await invoke({ action: 'read_file', repo: 'demo', commit, path: 'src/data.bin' }, env);
  assert.equal(result.status, 200);
  const body = await result.json(), bytes = Buffer.from(body.content_base64, 'base64');
  assert.deepEqual([...bytes], [0, 255, 254, 10]);
  assert.equal(body.sha256, await hashBytes(bytes));
  assert.deepEqual(calls.find(call => call[0] === 'file')[2], { ref: commit, path: 'src/data.bin' });
  assert.equal((await invoke({ action: 'read_file', repo: 'demo', commit, path: 'src/data.bin', expected_sha256: '0'.repeat(64) }, env)).status, 409);
  assert.equal((await invoke({ action: 'read_commit', repo: 'demo', commit: 'main' }, env)).status, 400);
  assert.equal((await invoke({ action: 'read_file', repo: 'demo', commit, path: '.git/config' }, env)).status, 400);
});

test('strict bounded inputs reject unallowed imports, traversal, delete and oversized streaming bodies', async () => {
  const { env, calls } = fixture();
  for (const source_url of ['http://github.com/a/b', 'https://user:secret@github.com/a/b', 'https://github.com/a/b?token=secret', 'https://127.0.0.1/repo', 'https://github.com:444/a/b', 'https://evil.example/repo'])
    assert.equal((await invoke({ action: 'import', name: 'imported', source_url }, env)).status, 400);
  for (const input of [{ action: 'delete', repo: 'demo' }, { action: 'info', repo: '../demo' }, { action: 'info', repo: 'demo', command: ['sh'] }])
    assert.equal((await invoke(input, env)).status, 400);
  assert.equal((await invoke({}, env, { body: ' '.repeat(16_385) })).status, 413);
  assert.equal((await invoke({}, env, { headers: { 'content-length': '20000' } })).status, 413);
  assert.equal((await invoke({}, env, { body: Uint8Array.from([255]) })).status, 400);
  assert.deepEqual(calls, []);
});

test('missing/oversized results, provider errors and failed creation cleanup release handles without leaking credentials', async () => {
  for (const [overrides, action, expected] of [
    [{ readFile: async () => null }, { action: 'read_file', repo: 'demo', commit, path: 'missing' }, 404],
    [{ readFile: async () => new Blob([new Uint8Array(1024 * 1024 + 1)]) }, { action: 'read_file', repo: 'demo', commit, path: 'big' }, 413],
    [{ readCommit: async () => ({ hash: 'b'.repeat(40) }) }, { action: 'read_commit', repo: 'demo', commit }, 502],
    [{ readCommit: async () => ({ hash: commit, message: '☃'.repeat(100_000) }) }, { action: 'read_commit', repo: 'demo', commit }, 413],
    [{ info: async () => { throw Object.assign(new Error('token=provider-secret'), { code: 'NOT_FOUND' }); } }, { action: 'info', repo: 'demo' }, 404],
    [{ info: async () => { throw Object.assign(new Error('token=provider-secret'), { code: 'FORK_IN_PROGRESS' }); } }, { action: 'info', repo: 'demo' }, 409],
    [{ info: async () => { throw new Error('token=provider-secret'); } }, { action: 'info', repo: 'demo' }, 502],
    [{ revokeToken: async () => { throw new Error('initial-secret'); } }, { action: 'create', name: 'new' }, 502],
  ]) {
    const { env, calls } = fixture(overrides), result = await invoke(action, env);
    assert.equal(result.status, expected);
    assert.equal((await result.text()).includes('secret'), false);
    assert.equal(calls.filter(call => call[0] === 'dispose').length, 1);
  }
});
