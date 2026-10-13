import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, chmod, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, head, atCommit, snapshot, restoreCheckpoints, committedFiles, exportCommitBundle, fetchCommitBundle } from './git.js';
import { ClientStore } from './store.js';
import { GitpunkClient } from './index.js';
import { createGitpunkServer } from '../server/index.js';
import { createWorkspaces } from '../scripts/git-fixture.js';
import { hashBytes } from '../shared/index.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gitpunk-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'user.name', 'Gitpunk test');
  await writeFile(join(dir, 'models.py'), 'class Car:\n    pass\n\n');
  await git(dir, 'add', 'models.py');
  await git(dir, 'commit', '-m', 'base');
  return dir;
}

test('Git baseline preserves trailing newlines, snapshots never stage changes', async t => {
  const dir = await fixture(t);
  assert.equal(await atCommit(dir, await head(dir), 'models.py'), 'class Car:\n    pass\n\n');
  await writeFile(join(dir, 'models.py'), 'class Car:\n    color = "red"\n\n');
  assert.equal((await snapshot(dir, 'models.py')).content, 'class Car:\n    color = "red"\n\n');
  assert.equal(await git(dir, 'diff', '--cached'), '');
});

test('receipt cursor and unconsumed inbox survive restart independently', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gitpunk-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new ClientStore(join(dir, 'state.sqlite'));
  store.receive([{ seq: 1, type: 'intent' }, { seq: 2, type: 'checkpoint' }], 2);
  store.close();
  store = new ClientStore(join(dir, 'state.sqlite'));
  assert.equal(store.get('cursor'), 2);
  assert.equal(store.inbox().length, 2);
  store.receive([{ seq: 2, type: 'checkpoint' }], 2);
  assert.equal(store.inbox().length, 2);
  store.consume(1);
  assert.deepEqual(store.inbox(), [{ seq: 2, type: 'checkpoint' }]);
  store.close();
});

test('handoff refuses dirty import and leaves edits untouched', async t => {
  const dir = await fixture(t);
  const base = await head(dir);
  await writeFile(join(dir, 'models.py'), 'private local edit\n');
  await assert.rejects(restoreCheckpoints(dir, [{ base_commit: base, path: 'models.py', content: 'peer\n' }], 'gitpunk/handoff'), /clean workspace/);
  assert.equal(await readFile(join(dir, 'models.py'), 'utf8'), 'private local edit\n');
  assert.equal(await git(dir, 'branch', '--show-current'), 'main');
});

test('handoff rechecks symlink parents introduced by its base tree', async t => {
  const dir = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'gitpunk-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.txt'), 'untouched\n');
  await git(dir, 'switch', '-c', 'peer');
  await symlink(outside, join(dir, 'linked'));
  await git(dir, 'add', 'linked');
  await git(dir, 'commit', '-m', 'symlink base');
  const base = await head(dir);
  await git(dir, 'switch', 'main');
  await assert.rejects(restoreCheckpoints(dir, [{ base_commit: base, path: 'linked/secret.txt', content: 'bad\n' }], 'gitpunk/handoff'), /Symlink source path/);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'untouched\n');
  assert.equal(await git(dir, 'branch', '--show-current'), 'main');
});

test('handoff restores all pinned files in one isolated branch', async t => {
  const dir = await fixture(t);
  const base = await head(dir);
  await restoreCheckpoints(dir, [
    { base_commit: base, path: 'models.py', content: 'class Car:\n    color = "blue"\n' },
    { base_commit: base, path: 'services.py', content: 'def create_car(): pass\n' },
  ], 'gitpunk/handoff');
  assert.equal(await git(dir, 'branch', '--show-current'), 'gitpunk/handoff');
  assert.equal(await readFile(join(dir, 'services.py'), 'utf8'), 'def create_car(): pass\n');
  assert.equal(await git(dir, 'diff', '--cached'), '');
  assert.equal(await git(dir, 'rev-parse', 'main'), base);
});

test('handoff preparation failure leaves earlier files and original branch intact', async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'occupied'));
  await writeFile(join(dir, 'occupied', 'keep.txt'), 'keep\n');
  await git(dir, 'add', 'occupied');
  await git(dir, 'commit', '-m', 'directory baseline');
  const base = await head(dir);
  await assert.rejects(restoreCheckpoints(dir, [
    { base_commit: base, path: 'models.py', content: 'peer changed this\n' },
    { base_commit: base, path: 'occupied', content: 'would replace a directory\n' },
  ], 'gitpunk/failed-handoff'), /not a regular file/);
  assert.equal(await readFile(join(dir, 'models.py'), 'utf8'), 'class Car:\n    pass\n\n');
  assert.equal(await readFile(join(dir, 'occupied', 'keep.txt'), 'utf8'), 'keep\n');
  assert.equal(await git(dir, 'status', '--porcelain'), '');
  assert.equal(await git(dir, 'branch', '--show-current'), 'main');
});

test('handoff rolls back earlier replacements if a later delete fails', { skip: process.getuid?.() === 0 }, async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'readonly'));
  await writeFile(join(dir, 'readonly', 'keep.txt'), 'keep\n');
  await git(dir, 'add', 'readonly');
  await git(dir, 'commit', '-m', 'readonly baseline');
  const base = await head(dir);
  await chmod(join(dir, 'readonly'), 0o500);
  try {
    await assert.rejects(restoreCheckpoints(dir, [
      { base_commit: base, path: 'models.py', content: 'first file replaced\n' },
      { base_commit: base, path: 'readonly/keep.txt', content: null },
    ], 'gitpunk/failed-delete'), /EACCES|EPERM/);
    assert.equal(await readFile(join(dir, 'models.py'), 'utf8'), 'class Car:\n    pass\n\n');
    assert.equal(await readFile(join(dir, 'readonly', 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(await git(dir, 'status', '--porcelain'), '');
    assert.equal(await git(dir, 'branch', '--show-current'), 'main');
  } finally { await chmod(join(dir, 'readonly'), 0o700); }
});

test('saving then deleting a new uncommitted file publishes its cancellation to peers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-transient-'));
  const workspaces = await createWorkspaces(root);
  const server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, port: 0 });
  const started = await server.start();
  const options = name => ({ credentials: started.fixture_path, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`), debounceMs: 0 });
  const alice = await GitpunkClient.create(options('alice'));
  const bob = await GitpunkClient.create(options('bob'));
  t.after(async () => { alice.close(); bob.close(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  await alice.work({ title: 'Try new car helper', type: 'feature', summary: 'Explore a helper before committing.', files: ['new.py'], done_when: ['Keep or discard the helper.'], sharing: 'summary' });
  await writeFile(join(workspaces.alice, 'new.py'), 'def helper(): pass\n');
  await alice.tick(); await alice.tick();
  await bob.tick();
  const created = (await bob.status()).server.checkpoints.find(item => item.path === 'new.py');
  assert.equal(created.operation, 'create');
  await unlink(join(workspaces.alice, 'new.py'));
  await alice.tick(); await alice.tick();
  await bob.tick();
  const snapshots = (await bob.status()).server.checkpoints.filter(item => item.path === 'new.py');
  assert.equal(snapshots.at(-1).operation, 'delete');
  assert.equal(snapshots.at(-1).result_hash, null);
  const cancelled = await bob.request(`checkpoints/${snapshots.at(-1).id}`);
  assert.equal((cancelled.checkpoint || cancelled).content, null);
  assert.equal((await alice.status()).counts.outbox, 0);
  assert.equal(await git(workspaces.alice, 'status', '--porcelain'), '');
});

test('commit bundles contain committed bytes and fetch without changing dirty peer work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = await createWorkspaces(root);
  const base = await head(workspaces.alice);
  const committed = 'class Car:\n    color = "blue"\n';
  await writeFile(join(workspaces.alice, 'models.py'), committed);
  await git(workspaces.alice, 'add', 'models.py');
  await git(workspaces.alice, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Car color');
  const commit = await head(workspaces.alice);
  // These hooks reject ref updates; managed export/fetch must suppress them.
  for (const workspace of [workspaces.alice, workspaces.bob]) {
    await writeFile(join(workspace, '.git', 'hooks', 'reference-transaction'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(git(workspace, 'update-ref', 'refs/gitpunk/hook-probe', base), error => error.code === 128);
    assert.equal(await git(workspace, 'for-each-ref', '--format=%(refname)', 'refs/gitpunk/hook-probe'), '');
  }
  await writeFile(join(workspaces.alice, 'models.py'), 'unstaged sender work\n');
  const files = await committedFiles(workspaces.alice, base, commit);
  assert.deepEqual(files.map(file => file.path), ['models.py']);
  assert.equal(files[0].result_hash, await hashBytes(Buffer.from(committed)));
  const exported = await exportCommitBundle(workspaces.alice, base, commit);
  await writeFile(join(workspaces.bob, 'models.py'), 'staged peer work\n');
  await git(workspaces.bob, 'add', 'models.py');
  await writeFile(join(workspaces.bob, 'models.py'), 'unstaged peer work\n');
  const before = { head: await head(workspaces.bob), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') };
  const ref = await fetchCommitBundle(workspaces.bob, Buffer.from(exported.bundle_content, 'base64'), commit, 'test-upload', { base_commit: base, files });
  assert.equal(await atCommit(workspaces.bob, ref, 'models.py'), committed);
  assert.deepEqual({ head: await head(workspaces.bob), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') }, before);
  assert.equal(await git(workspaces.alice, 'for-each-ref', '--format=%(refname)', 'refs/gitpunk/exports'), '');
  assert.equal(await git(workspaces.bob, 'for-each-ref', '--format=%(refname)', 'refs/gitpunk/fetching'), '');
});

test('intent revisions keep their baseline across commits and closed tasks start fresh', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-revisions-'));
  const workspaces = await createWorkspaces(root);
  const server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, port: 0 });
  const started = await server.start();
  const client = await GitpunkClient.create({ credentials: started.fixture_path, identity: 'alice', workspace: workspaces.alice, stateDir: join(root, 'client') });
  t.after(async () => { client.close(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  const intent = { title: 'Improve model', type: 'change', summary: 'Improve the model.', files: ['models.py'], done_when: ['Model works.'], sharing: 'summary' };
  const initial = await client.work(intent);
  const originalBase = (await client.status()).work.base_commit;
  await writeFile(join(workspaces.alice, 'models.py'), 'class Car: pass\n');
  await git(workspaces.alice, 'add', 'models.py');
  await git(workspaces.alice, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'model');
  const revised = await client.work({ ...intent, files: ['models.py', 'services.py'] });
  assert.equal(revised.intent_id, initial.intent_id);
  assert.equal((await client.status()).work.base_commit, originalBase);
  await client.respond({ action: 'cancel', intent_id: initial.intent_id });
  const next = await client.work(intent);
  assert.notEqual(next.intent_id, initial.intent_id);
  assert.equal((await client.status()).work.base_commit, await head(workspaces.alice));
  await client.respond({ action: 'finish', intent_id: next.intent_id });
  const followup = await client.work({ ...intent, title: 'A separate finished-task follow-up', files: ['services.py'] });
  assert.notEqual(followup.intent_id, next.intent_id);
  assert.equal((await client.status()).server.intents.find(item => item.id === next.intent_id).title, intent.title);
  assert.equal((await client.status()).server.intents.find(item => item.id === next.intent_id).state, 'ready');
});

test('automatic peer fetch filters scope and retries after restart without losing receipt or dirty work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-peer-retry-'));
  const workspaces = await createWorkspaces(root);
  let server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, gitSource: workspaces.source, port: 0 });
  const started = await server.start();
  const options = name => ({ credentials: started.fixture_path, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`), pollMs: 1, ...(name === 'alice' ? { upload: true } : {}) });
  const alice = await GitpunkClient.create(options('alice'));
  let bob = await GitpunkClient.create(options('bob'));
  t.after(async () => { alice.close(); bob.close(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  const intent = { title: 'Improve model', type: 'change', summary: 'Improve Car.', files: ['models.py'], done_when: ['Car works.'], sharing: 'summary' };
  const first = await alice.work(intent);
  await bob.work({ ...intent, title: 'Improve services', files: ['services.py'] });
  await writeFile(join(workspaces.bob, 'services.py'), 'staged peer work\n');
  await git(workspaces.bob, 'add', 'services.py');
  await writeFile(join(workspaces.bob, 'services.py'), 'unstaged peer work\n');
  const before = { head: await head(workspaces.bob), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') };
  await writeFile(join(workspaces.alice, 'models.py'), 'class Car: pass\n');
  await git(workspaces.alice, 'add', 'models.py');
  await git(workspaces.alice, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'model');
  await alice.tick();
  const uploaded = (await alice.status()).commit;
  assert.equal(uploaded.upload, 'uploaded');
  await bob.tick();
  assert.deepEqual((await bob.status()).peer_updates, []);
  const revised = await bob.work({ ...intent, files: ['models.py', 'services.py'] });
  await bob.respond({ action: 'overlap', intent_id: revised.intent_id, peer_intent_id: first.intent_id, peer_revision: first.revision, expected_revision: revised.revision, mode: 'coedit' });
  await bob.poll();
  const receivedCursor = (await bob.status({ refresh: false })).cursor;
  await server.stop();
  await bob.fetchPeerUpdates();
  assert.equal((await bob.status({ refresh: false })).peer_updates[0].state, 'pending');
  assert.equal((await bob.status({ refresh: false })).cursor, receivedCursor);
  bob.close();
  server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, gitSource: workspaces.source, port: started.port });
  await server.start();
  bob = await GitpunkClient.create(options('bob'));
  await bob.tick();
  const fetched = (await bob.status()).peer_updates.find(item => item.commit_id === uploaded.upload_id);
  assert.equal(fetched.state, 'fetched');
  assert.equal(await git(workspaces.bob, 'rev-parse', fetched.git_ref), uploaded.commit);
  assert.ok((await bob.status()).cursor >= receivedCursor);
  assert.deepEqual({ head: await head(workspaces.bob), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') }, before);
});

test('canonical target fetch rejects a bad HTTP hash and preserves dirty work while retrying exact merged code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-target-'));
  const workspaces = await createWorkspaces(root);
  const server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, gitSource: workspaces.source, port: 0 });
  const started = await server.start();
  const options = name => ({ credentials: started.fixture_path, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`), pollMs: 1, ...(name === 'alice' ? { upload: true } : {}) });
  const alice = await GitpunkClient.create(options('alice'));
  const bob = await GitpunkClient.create(options('bob'));
  t.after(async () => { alice.close(); bob.close(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  const base = await head(workspaces.alice);
  await bob.tick();
  assert.equal((await bob.status()).target.commit, base);
  await writeFile(join(workspaces.bob, 'models.py'), 'staged local model\n');
  await git(workspaces.bob, 'add', 'models.py');
  await writeFile(join(workspaces.bob, 'services.py'), 'unstaged local services\n');
  const before = { head: await head(workspaces.bob), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') };
  await alice.work({ title: 'Improve model', type: 'change', summary: 'Improve Car.', files: ['models.py', 'Z.py', 'a.py'], done_when: ['Car works.'], sharing: 'summary' });
  await writeFile(join(workspaces.alice, 'models.py'), 'class Car: pass\n');
  await writeFile(join(workspaces.alice, 'Z.py'), 'value = 1\n');
  await writeFile(join(workspaces.alice, 'a.py'), 'value = 2\n');
  await git(workspaces.alice, 'add', 'models.py', 'Z.py', 'a.py');
  await git(workspaces.alice, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'model');
  await alice.tick();
  const upload = (await alice.status()).commit;
  assert.equal(upload.upload, 'uploaded');
  // An administrator fixture advances the actual canonical Git ref; this tests transport, not checks.
  const candidate = await server.gitStore.buildCandidate({ base, target: base, commit: upload.commit, operationId: 'target-fixture', createdAt: Date.now() });
  assert.notEqual(candidate.candidate, upload.commit);
  server.gitStore.compareAndSwap(base, candidate.candidate);
  const original = server.gitStore.targetSnapshot.bind(server.gitStore);
  let corrupt = true;
  server.gitStore.targetSnapshot = async withBundle => { const value = await original(withBundle); return corrupt && withBundle ? { ...value, bundle_hash: '0'.repeat(64) } : value; };
  await bob.tick();
  const failed = (await bob.status()).target;
  assert.equal(failed.state, 'pending');
  assert.equal(failed.error.code, 'target_hash_mismatch');
  assert.equal(await git(workspaces.bob, 'rev-parse', 'refs/gitpunk/targets/main'), base);
  corrupt = false;
  await new Promise(resolve => setTimeout(resolve, 5));
  await bob.tick();
  const fetched = (await bob.status()).target;
  assert.equal(fetched.state, 'fetched');
  assert.equal(fetched.commit, candidate.candidate);
  assert.equal(await git(workspaces.bob, 'cat-file', '-t', fetched.commit), 'commit');
  assert.equal(await git(workspaces.bob, 'rev-parse', fetched.git_ref), candidate.candidate);
  assert.deepEqual({ head: await head(workspaces.bob), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') }, before);
});

test('prepare_write reads fresh bounded peer metadata without publishing, acknowledging or changing Git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-prepare-'));
  const workspaces = await createWorkspaces(root);
  const server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, gitSource: workspaces.source, port: 0 });
  const started = await server.start();
  const options = name => ({ credentials: started.fixture_path, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`), debounceMs: 0 });
  const alice = await GitpunkClient.create(options('alice'));
  const bob = await GitpunkClient.create(options('bob'));
  t.after(async () => { alice.close(); bob.close(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  const definition = { title: 'Car work', type: 'change', summary: 'Improve Car.', files: ['models.py', 'services.py'], done_when: ['Car works.'], sharing: 'summary' };
  const a = await alice.work({ ...definition, summary: 'Untrusted peer summary '.repeat(100), sharing: 'context', prompt: 'RAW_PROMPT_MUST_NOT_LEAK', context: { private: 'RAW_CONTEXT_MUST_NOT_LEAK' } });
  const b = await bob.work({ ...definition, files: ['models.py'] });
  await bob.respond({ action: 'overlap', intent_id: b.intent_id, peer_intent_id: a.intent_id, peer_revision: a.revision, expected_revision: b.revision, mode: 'coedit' });
  await bob.poll();
  const cached = bob.store.get('remote');
  assert.equal(cached.checkpoints.length, 0);
  for (const content of ['first peer draft\n', 'LATEST_PEER_CONTENT_MUST_NOT_LEAK\n']) {
    await writeFile(join(workspaces.alice, 'models.py'), content);
    await alice.observeFiles(); await alice.observeFiles(); await alice.flush();
  }
  const proposal = await alice.respond({ action: 'decision', intent_id: a.intent_id, title: 'Car contract', description: 'Use a stable car ID.' });
  await bob.respond({ action: 'decision_accept', decision_id: proposal.id });
  // A real backlog proves that one preflight page is bounded and never silently consumes it.
  for (let i = 0; i < 101; i++) await alice.enqueue('respond', { action: 'decision', intent_id: a.intent_id, title: `Pending ${i}`, description: 'Unagreed proposal.' });
  while (alice.store.pending().length) await alice.flush();
  await writeFile(join(workspaces.bob, 'models.py'), 'staged local work\n');
  await git(workspaces.bob, 'add', 'models.py');
  await writeFile(join(workspaces.bob, 'models.py'), 'unstaged local work\n');
  await writeFile(join(workspaces.bob, 'notes.txt'), 'untracked local note\n');
  const before = { head: await head(workspaces.bob), refs: await git(workspaces.bob, 'show-ref'), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff'), notes: await readFile(join(workspaces.bob, 'notes.txt'), 'utf8') };
  await bob.enqueue('respond', { action: 'ack', event_seq: 0 });
  const queued = bob.store.counts().outbox;
  const eventCount = server.db.prepare('SELECT count(*) AS n FROM events').get().n;
  bob.tick = bob.flush = async () => { throw new Error('prepare_write must only read'); };
  const briefing = await bob.respond({ action: 'prepare_write', files: ['models.py'] });
  assert.equal(briefing.state, 'prepared');
  assert.equal(briefing.intent.revision, b.revision);
  assert.ok(briefing.intent.permissions['models.py'].includes('modify'));
  assert.deepEqual(briefing.peers[0].files, ['models.py']);
  assert.equal(briefing.peers[0].text_trust, 'untrusted');
  assert.equal(briefing.peers[0].summary.length, briefing.limits.text_chars);
  assert.ok(briefing.truncation.text_fields > 0);
  assert.equal(briefing.checkpoints.length, 1);
  assert.equal(briefing.checkpoints[0].result_hash, await hashBytes(Buffer.from('LATEST_PEER_CONTENT_MUST_NOT_LEAK\n')));
  assert.deepEqual(briefing.decisions.map(item => item.id), [proposal.id]);
  assert.equal(briefing.decisions[0].text_trust, 'untrusted');
  assert.equal(briefing.target.commit, before.head);
  assert.equal(briefing.freshness.source, 'authenticated_server_snapshot');
  assert.equal(briefing.freshness.guarantee, 'snapshot_only');
  assert.equal(briefing.freshness.event_backlog, true);
  assert.ok(briefing.freshness.received_cursor < briefing.freshness.events_cursor);
  assert.doesNotMatch(JSON.stringify(briefing), /RAW_PROMPT|RAW_CONTEXT|LATEST_PEER_CONTENT/);
  assert.equal(bob.store.counts().outbox, queued);
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM events').get().n, eventCount);
  assert.equal(bob.store.db.prepare('SELECT count(*) AS n FROM inbox WHERE consumed=1').get().n, 0);
  assert.deepEqual({ head: await head(workspaces.bob), refs: await git(workspaces.bob, 'show-ref'), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff'), notes: await readFile(join(workspaces.bob, 'notes.txt'), 'utf8') }, before);
});

test('prepare_write refuses missing, stale, overlapping, expired, out-of-scope, offline and revoked work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-prepare-blocked-'));
  const workspaces = await createWorkspaces(root);
  const server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, port: 0 });
  const started = await server.start();
  const options = name => ({ credentials: started.fixture_path, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`) });
  const alice = await GitpunkClient.create(options('alice'));
  const bob = await GitpunkClient.create(options('bob'));
  t.after(async () => { alice.close(); bob.close(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(workspaces.bob, 'models.py'), 'staged local work\n');
  await git(workspaces.bob, 'add', 'models.py');
  await writeFile(join(workspaces.bob, 'models.py'), 'unstaged local work\n');
  const before = { head: await head(workspaces.bob), refs: await git(workspaces.bob, 'show-ref'), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') };
  const prepare = () => bob.respond({ action: 'prepare_write', files: ['models.py'] });
  const rejects = code => assert.rejects(prepare(), error => error.code === code);
  await rejects('intent_missing');
  const definition = { title: 'Car work', type: 'change', summary: 'Improve Car.', files: ['models.py'], done_when: ['Car works.'], sharing: 'summary' };
  let a = await alice.work(definition);
  const b = await bob.work(definition);
  await rejects('overlap');
  const acknowledge = () => bob.respond({ action: 'overlap', intent_id: b.intent_id, peer_intent_id: a.intent_id, peer_revision: a.revision, expected_revision: bob.store.get('work').revision, mode: 'coedit' });
  await acknowledge();
  assert.equal((await prepare()).state, 'prepared');
  a = await alice.work({ ...definition, summary: 'Revised peer contract.' });
  await rejects('overlap');
  await acknowledge();
  assert.equal((await prepare()).state, 'prepared');
  await assert.rejects(bob.respond({ action: 'prepare_write', files: ['services.py'] }), error => error.code === 'outside_intent');
  await assert.rejects(bob.respond({ action: 'prepare_write', files: ['.git/config'] }), error => error.code === 'invalid_write_scope');
  await assert.rejects(bob.respond({ action: 'prepare_write', files: ['models.py'], prompt: 'never upload this' }), error => error.code === 'invalid_write_scope');
  const scope = server.db.prepare('SELECT scope FROM runs WHERE id=?').get('run-b').scope;
  server.db.prepare('UPDATE runs SET scope=? WHERE id=?').run(JSON.stringify({ files: ['services.py'], operations: ['modify'] }), 'run-b');
  await rejects('scope_denied');
  server.db.prepare('UPDATE runs SET scope=? WHERE id=?').run(scope, 'run-b');
  const role = server.db.prepare('SELECT role FROM access WHERE repo_id=? AND user_id=?').get('demo', server.fixture.identities.bob.human_id).role;
  server.db.prepare('UPDATE access SET role=? WHERE repo_id=? AND user_id=?').run('reader', 'demo', server.fixture.identities.bob.human_id);
  await rejects('scope_denied');
  server.db.prepare('UPDATE access SET role=? WHERE repo_id=? AND user_id=?').run(role, 'demo', server.fixture.identities.bob.human_id);
  await assert.rejects(bob.work({ ...definition, files: ['**'] }), error => error.name === 'ZodError');
  const stale = bob.store.get('work');
  await bob.work({ ...definition, summary: 'Revised own contract.' });
  await acknowledge();
  const current = bob.store.get('work');
  bob.store.set('work', stale);
  await rejects('stale_intent');
  bob.store.set('work', current);
  server.db.prepare('UPDATE claims SET expires=0 WHERE intent_id=?').run(b.intent_id);
  await rejects('lease_expired');
  await bob.work({ ...definition, summary: 'Revised own contract.' });
  await acknowledge();
  assert.equal((await prepare()).state, 'prepared');
  const eventCount = server.db.prepare('SELECT count(*) AS n FROM events').get().n;
  server.db.prepare('UPDATE runs SET revoked=1 WHERE id=?').run('run-b');
  await rejects('unauthenticated');
  server.db.prepare('UPDATE runs SET revoked=0 WHERE id=?').run('run-b');
  const request = bob.request.bind(bob);
  let queuedDuringRefresh;
  bob.request = async (...args) => {
    const value = await request(...args);
    if (args[0].startsWith('status?')) queuedDuringRefresh = await bob.enqueue('work', { id: current.id, expected_revision: bob.store.get('work').revision, branch: 'main', workspace_id: bob.options.workspaceId, base_commit: current.base_commit, intent: { ...definition, files: ['services.py'] } });
    return value;
  };
  await rejects('intent_pending');
  bob.request = request;
  bob.store.failed(queuedDuringRefresh, { code: 'cancelled_test', message: 'Discard this test fixture request.' }, true);
  bob.options.server = 'http://127.0.0.1:1';
  await rejects('offline');
  // Outbox batching must not hide a declaration queued behind ordinary publications.
  for (let i = 0; i < 51; i++) await bob.enqueue('respond', { action: 'ack', event_seq: 0 });
  await bob.enqueue('work', { id: current.id, expected_revision: bob.store.get('work').revision, branch: 'main', workspace_id: bob.options.workspaceId, base_commit: current.base_commit, intent: { ...definition, files: ['services.py'] } });
  await rejects('intent_pending');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM events').get().n, eventCount);
  assert.deepEqual({ head: await head(workspaces.bob), refs: await git(workspaces.bob, 'show-ref'), staged: await git(workspaces.bob, 'diff', '--cached'), work: await git(workspaces.bob, 'diff') }, before);
});
