import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localObjects } from '../scripts/local-objects.js';
import { importObjects } from '../scripts/import-objects.js';
import { createWorkspaces } from '../scripts/git-fixture.js';
import { objectClient } from '../server/object-client.js';
import { createGitpunkServer } from '../server/index.js';
import { GitpunkClient } from '../client/index.js';
import { git, head } from '../client/git.js';
import { hashContent, canonicalJson } from '../shared/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-object-test-')), workspaces = await createWorkspaces(root, { remote: true });
  const previous = await head(workspaces.source);
  await writeFile(join(workspaces.source, 'models.py'), (await readFile(join(workspaces.source, 'models.py'), 'utf8')) + '# second version\n');
  await writeFile(join(workspaces.source, 'unrelated.bin'), Buffer.alloc(2 * 1024 * 1024, 42));
  await git(workspaces.source, 'add', '.'); await git(workspaces.source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Second version');
  let cloud = await localObjects(join(root, 'cloud')), app; const clients = {};
  t.after(async () => { for (const client of Object.values(clients)) client.close(); await app?.stop(); await cloud.stop(); await rm(root, { recursive: true, force: true }); });
  const imported = await importObjects(workspaces.source, objectClient(cloud)), config = join(root, 'objects.json');
  const policy = { image: 'python@sha256:3dd7cc108ec1493442514f5c2a871af6af0ec31d768ff6e378a93340c3b3db5f', command: ['python','-c','import ast,pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in ("models.py","services.py")]'], source_paths: ['models.py','services.py'], approval: 'automatic', check_concurrency: 2 };
  // State-machine checks use controlled evidence unless real Docker is explicitly enabled.
  const runner = process.env.GITPUNK_DOCKER_TESTS === '1' ? undefined : async ({ candidate, policy }) => ({ candidate, image_digest: policy.image, policy_hash: await hashContent(canonicalJson(policy)), state: 'passed', exit_code: 0, stdout: '', stderr: '', cleanup: 'complete' });
  async function start() {
    await writeFile(config, JSON.stringify({ endpoint: cloud.endpoint, token: cloud.token, repo: 'demo', base: imported.base }), { mode: 0o600 });
    app = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, port: 0, objectConfig: config, checkPolicy: policy, runner }); await app.start();
  }
  await start();
  for (const name of ['alice','bob']) clients[name] = await GitpunkClient.create({ credentials: join(root, 'server', 'fixture.json'), identity: name, remote: true, workspace: workspaces[name], stateDir: join(root, `${name}-state`), debounceMs: 0, cacheDir: join(root, 'client-cache') });
  async function until(predicate) {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) { await app.coordinator.flush(); const state = app.coordinator.status(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail(JSON.stringify(app.coordinator.status()));
  }
  return { root, workspaces, imported, previous, clients, until, get app() { return app; }, get cloud() { return cloud; }, async restart() {
    await app.stop(); await cloud.stop(); cloud = await localObjects(join(root, 'cloud')); await start();
    for (const client of Object.values(clients)) client.options.endpoint = app.address();
  } };
}

test('R2 source reads match native Git; unselected large blobs stay unfetched and caches disappear', { timeout: 60_000 }, async t => {
  const env = await fixture(t), { alice } = env.clients, base = env.imported.base;
  const file = await alice.source({ action: 'file', commit: base, path: 'models.py' });
  assert.deepEqual(Buffer.from(file.content_base64, 'base64'), await readFile(join(env.workspaces.source, 'models.py')));
  const tree = await alice.source({ action: 'tree', commit: base }); assert.equal(tree.entries.find(entry => entry.path === 'unrelated.bin').size, null);
  assert.ok((await alice.source({ action: 'diff', base: env.previous, commit: base, paths: ['models.py'] })).diff.includes('+\x23 second version'));
  assert.deepEqual((await alice.source({ action: 'history', commit: base, path: 'models.py' })).history.map(row => row.commit), [base, env.previous]);
  assert.ok((await alice.source({ action: 'blame', commit: base, path: 'models.py', end: 1 })).blame.includes('\t"""'));
  assert.equal((await alice.source({ action: 'compare', base: env.previous, commit: base })).merge_base, env.previous);
  assert.ok(env.app.gitStore.stats().downloaded_bytes < 64 * 1024, JSON.stringify(env.app.gitStore.stats()));
  const root = await env.app.gitStore.root(base), content = Buffer.from(`tree ${root}\nparent ${base}\nauthor Test <test@example.invalid> 1791936000 +0000\ncommitter Test <test@example.invalid> 1791936000 +0000\n\nUnadmitted\n`);
  const raw = Buffer.concat([Buffer.from(`commit ${content.length}\0`), content]), unadmitted = createHash('sha1').update(raw).digest('hex');
  await objectClient(env.cloud).put(unadmitted, raw);
  await assert.rejects(alice.source({ action: 'file', commit: unadmitted, path: 'models.py' }), error => error.code === 'unknown_commit');
  assert.deepEqual(await readdir(join(env.root, 'server', 'object-caches')), []);
  await assert.rejects(alice.source({ action: 'file', commit: base, path: 'unrelated.bin' }), error => error.code === 'source_too_large');
  env.app.db.prepare("UPDATE runs SET scope=? WHERE id='run-a'").run(JSON.stringify({ files: ['services.py'], operations: ['modify'] }));
  await assert.rejects(alice.source({ action: 'file', commit: base, path: 'models.py' }), error => error.code === 'scope_denied');
});

test('two signed draft commits integrate over R2/DO, recover a lost receipt and survive runtime restart', { timeout: 90_000 }, async t => {
  const env = await fixture(t); const submissions = [];
  env.app.db.exec("CREATE TRIGGER lose_receipt BEFORE INSERT ON events WHEN NEW.type='integration.finished' BEGIN SELECT RAISE(ABORT,'receipt loss'); END;");
  for (const [name, file] of [['alice','models.py'],['bob','services.py']]) {
    const client = env.clients[name];
    await client.work({ title: `Update ${name}`, summary: 'Add a source comment.', type: 'change', files: [file], done_when: ['Syntax checks pass'] });
    await client.prepareWrite({ action: 'prepare_write', files: [file] });
    await writeFile(join(env.workspaces[name], file), (await readFile(join(env.workspaces[name], file), 'utf8')) + `# ${name} change\n`);
    await client.observeFiles(); await client.observeFiles(); await client.flush();
    const result = await client.respond({ action: 'commit', message: `Update ${name}` });
    assert.equal(result.checked, false); submissions.push(result);
  }
  const pending = await env.until(state => state.last_error && state.operations.some(op => op.state === 'prepared'));
  const op = pending.operations.find(op => op.state === 'prepared'), remote = objectClient(env.cloud);
  assert.equal((await remote.receipt(op.id)).candidate, op.candidate);
  assert.equal(await remote.head(), op.candidate);
  env.app.db.exec('DROP TRIGGER lose_receipt');
  await env.until(state => state.submissions.length === 2 && state.submissions.every(row => row.state === 'integrated'));
  const canonical = await remote.head();
  for (const [name, file] of [['alice','models.py'],['bob','services.py']]) assert.ok(Buffer.from((await env.clients.alice.source({ action: 'file', commit: canonical, path: file })).content_base64, 'base64').toString().includes(`# ${name} change`));
  assert.equal(env.app.db.prepare("SELECT count(*) n FROM events WHERE type='integration.finished'").get().n, 2);
  await env.restart();
  assert.equal(await env.app.gitStore.readRef('refs/heads/main'), canonical);
  assert.equal((await objectClient(env.cloud).receipt(op.id)).candidate, op.candidate);
  assert.equal(env.app.coordinator.status().operations.filter(op => op.state === 'integrated').length, 2);
  assert.deepEqual(await readdir(join(env.root, 'server', 'object-caches')), []);
});

test('Worker authenticates before storage, verifies hashes, serializes racing CAS and enforces a durable quota', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-quota-')), cloud = await localObjects(root, { requests: 40, bytes: 8192 });
  t.after(async () => { await cloud.stop(); await rm(root, { recursive: true, force: true }); });
  const remote = objectClient(cloud), raw = Buffer.from('commit 6\0hello\n'), oid = createHash('sha1').update(raw).digest('hex');
  const outsideLoopback = await cloud.runtime.dispatchFetch('https://example.com/v1/repos/demo/head', { headers: { authorization: `Bearer ${cloud.token}` } });
  assert.equal(outsideLoopback.status, 503); assert.equal((await outsideLoopback.json()).error, 'cloud_disabled', 'Local test mode cannot extend a cloud activation window.');
  const unauthorized = await fetch(`${cloud.endpoint}/v1/repos/demo/head`); assert.equal(unauthorized.status, 401);
  const corrupt = await remote.request(`objects/${'0'.repeat(40)}`, 'PUT', deflateSync(raw)).catch(error => error); assert.equal(corrupt.status, 409);
  assert.equal((await remote.put(oid, raw)).created, true); assert.equal((await remote.put(oid, raw)).created, false);
  assert.deepEqual(await remote.get(oid), raw);
  const contenders = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => remote.cas(null, oid, `cas-${i}`)));
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);
  const winner = contenders.findIndex(result => result.status === 'fulfilled');
  assert.equal((await remote.cas(null, oid, `cas-${winner}`)).state, 'applied');
  const count = (await (await remote.request('usage')).json()).requests; assert.equal(count, 22);
  const attempts = await Promise.allSettled(Array.from({ length: 40 }, () => remote.head()));
  assert.ok(attempts.some(result => result.status === 'rejected' && result.reason.status === 429));
});
