import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitpunkServer } from '../server/index.js';
import { createWorkspaces } from '../scripts/git-fixture.js';
import { GitpunkClient } from '../client/index.js';
import { head, git } from '../client/git.js';
import { signEnvelope, hashContent, verifyServerCommit } from '../shared/index.js';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-source-'));
  const workspaces = await createWorkspaces(root, { remote: true });
  const previous = await head(workspaces.source);
  await mkdir(join(workspaces.source, 'pkg')); await mkdir(join(workspaces.source, 'infra'));
  await writeFile(join(workspaces.source, 'pkg/code.py'), 'value = 1\n');
  await writeFile(join(workspaces.source, 'pkg/bytes.bin'), Buffer.from([0, 128, 255, 10]));
  await writeFile(join(workspaces.source, 'infra/private.txt'), 'protected\n');
  await writeFile(join(workspaces.source, 'models.py'), 'model = 2\n');
  await git(workspaces.source, 'add', '.');
  await git(workspaces.source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Nested source');
  const app = await createGitpunkServer({ dataDir: join(root, 'server'), port: 0, bootstrap: true, gitSource: workspaces.source });
  const started = await app.start(), clients = {};
  for (const name of ['alice', 'bob']) clients[name] = await GitpunkClient.create({ credentials: started.fixture_path, identity: name, remote: true, workspace: workspaces[name], stateDir: join(root, `${name}-state`), cacheDir: join(root, 'cache'), debounceMs: 0 });
  const env = { root, workspaces, app, clients, previous, base: await head(workspaces.source) };
  t.after(async () => { for (const client of Object.values(clients)) client.close(); await env.app.stop(); await rm(root, { recursive: true, force: true }); });
  return env;
}
const intent = files => ({ title: 'Scoped work', summary: 'Use the exact source snapshot.', type: 'feature', files, done_when: ['Contract passes'] });
async function save(client, path, content) { await writeFile(join(client.options.workspace, path), content); await client.observeFiles(); await client.observeFiles(); await client.flush(); }

test('checkout-free queries match Git, preserve binary bytes and reuse immutable results', async t => {
  const { app, clients: { alice }, base, previous, workspaces } = await setup(t);
  const first = await alice.source({ action: 'tree', commit: base, limit: 1 });
  assert.equal(first.entries.length, 1); assert.equal(first.more, true);
  const next = await alice.source({ action: 'tree', commit: base, after: first.next_cursor });
  assert.ok(![...first.entries, ...next.entries].some(entry => entry.path === 'infra'));
  const file = await alice.source({ action: 'file', commit: base, path: 'pkg/bytes.bin' });
  assert.deepEqual(Buffer.from(file.content_base64, 'base64'), await readFile(join(workspaces.source, file.path)));
  const commands = app.sourceStore.stats().git_commands;
  await Promise.all(Array.from({ length: 8 }, () => alice.source({ action: 'file', commit: base, path: file.path })));
  assert.equal(app.sourceStore.stats().git_commands, commands);
  const history = await alice.source({ action: 'history', commit: base, path: 'models.py' });
  assert.deepEqual(history.history.map(item => item.commit), [base, previous]);
  const blame = await alice.source({ action: 'blame', commit: base, path: 'models.py', end: 1 });
  assert.ok(blame.blame.includes('\tmodel = 2'));
  const diff = await alice.source({ action: 'diff', base: previous, commit: base, paths: ['models.py'] });
  assert.ok(diff.diff.includes('+model = 2'));
  const compared = await alice.source({ action: 'compare', base: previous, commit: base });
  assert.equal(compared.merge_base, previous); assert.equal(compared.base_is_ancestor, true);
  await assert.rejects(alice.source({ action: 'blame', commit: base, path: 'models.py', start: 1, end: 501 }), error => error.code === 'invalid_range');
  await assert.rejects(alice.source({ action: 'file', commit: base, path: '../escape' }));
  await assert.rejects(access(join(workspaces.alice, '.git')), { code: 'ENOENT' });
});

test('cached queries still enforce narrowed scope, read-only role, repository access and revocation', async t => {
  const { app, clients: { alice, bob }, base } = await setup(t);
  await alice.sourceCache.files(base, ['models.py']);
  app.db.prepare('UPDATE runs SET scope=? WHERE id=?').run(JSON.stringify({ files: ['pkg/code.py'], operations: ['modify'] }), 'run-a');
  await assert.rejects(alice.sourceCache.files(base, ['models.py']), error => error.code === 'scope_denied');
  assert.deepEqual((await alice.source({ action: 'tree', commit: base })).entries.map(item => item.path), ['pkg']);
  assert.deepEqual((await alice.source({ action: 'tree', commit: base, path: 'pkg' })).entries.map(item => item.path), ['pkg/code.py']);
  app.db.prepare("UPDATE access SET role='reader' WHERE user_id='bob'").run();
  assert.equal((await bob.source({ action: 'file', commit: base, path: 'models.py' })).commit, base);
  await assert.rejects(bob.work(intent(['models.py'])), error => error.code === 'forbidden');
  app.db.prepare("DELETE FROM access WHERE user_id='bob'").run();
  await assert.rejects(bob.source({ action: 'file', commit: base, path: 'models.py' }), error => error.code === 'forbidden');
  app.db.prepare("UPDATE runs SET revoked=1 WHERE id='run-a'").run();
  await assert.rejects(alice.source({ action: 'file', commit: base, path: 'pkg/code.py' }), error => error.code === 'unauthenticated');
});

test('a repository object without accepted provenance is unreadable', async t => {
  const { app, clients: { alice }, base } = await setup(t);
  const tree = await git(app.gitStore.directory, 'rev-parse', `${base}^{tree}`);
  const unaccepted = await git(app.gitStore.directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', tree, '-p', base, '-m', 'Unaccepted object');
  await git(app.gitStore.directory, 'update-ref', 'refs/private/staging', unaccepted);
  await assert.rejects(alice.source({ action: 'file', commit: unaccepted, path: 'models.py' }), error => error.code === 'unknown_commit');
});

test('signed saved drafts create an incremental Git commit, with lazy legacy export and exact proof', async t => {
  const { root, app, clients: { alice }, base, workspaces } = await setup(t);
  await alice.work(intent(['models.py', 'pkg/new.py', 'pkg/cancel.py']));
  await alice.prepareWrite({ action: 'prepare_write', files: ['models.py', 'pkg/new.py'] });
  await save(alice, 'models.py', 'model = 3\n');
  await mkdir(join(workspaces.alice, 'pkg'));
  await save(alice, 'pkg/new.py', 'new = True\n');
  await save(alice, 'pkg/cancel.py', 'temporary = True\n');
  await rm(join(workspaces.alice, 'pkg/cancel.py')); await alice.observeFiles(); await alice.observeFiles(); await alice.flush();
  const response = await alice.respond({ action: 'commit', message: 'Apply signed drafts' });
  assert.equal(response.provenance, 'server_commit'); assert.equal(response.checked, false);
  assert.deepEqual(response.files.map(file => file.path), ['models.py', 'pkg/new.py']);
  assert.equal(await git(app.gitStore.directory, 'show', `${response.commit}:models.py`), 'model = 3');
  assert.equal(await git(app.gitStore.directory, 'rev-parse', `${response.commit}:pkg/bytes.bin`), await git(app.gitStore.directory, 'rev-parse', `${base}:pkg/bytes.bin`));
  assert.equal(await app.gitStore.readRef('refs/heads/main'), base);
  assert.deepEqual(await readdir(join(root, 'server/bundles')), []);
  const retry = await alice.request('changesets', response.signed);
  assert.equal(retry.commit, response.commit); assert.equal(app.db.prepare('SELECT count(*) AS n FROM uploads').get().n, 1);
  const proof = await alice.request(`commits/${response.id}/bundle`);
  assert.equal((await verifyServerCommit(proof)).commit, response.commit);
  await assert.rejects(verifyServerCommit({ ...proof, manifest: { ...proof.manifest, files: proof.manifest.files.map(file => ({ ...file, result_hash: '0'.repeat(64) })) } }), /signed draft/);
  const legacy = join(root, 'legacy'); await git(root, 'clone', workspaces.source, legacy);
  const peer = await GitpunkClient.create({ credentials: alice.options.credentials, identity: 'bob', workspace: legacy, stateDir: join(root, 'legacy-state') });
  try { const fetched = await peer.fetchUploadedCommit(response.id); assert.equal(await git(legacy, 'rev-parse', fetched.git_ref), response.commit); assert.equal(await head(legacy), base); } finally { peer.close(); }
  const snapshot = await alice.respond({ action: 'source_snapshot', commit: response.commit, paths: ['models.py', 'pkg/new.py'] });
  assert.equal(await readFile(join(snapshot.directory, 'pkg/new.py'), 'utf8'), 'new = True\n');
  assert.equal(snapshot.git_checkout, false);
  await alice.respond({ action: 'finish', intent_id: response.intent_id });
  await alice.work(intent(['models.py']));
  assert.equal(alice.store.get('work').base_commit, response.commit, 'New work uses its workspace base rather than silently adopting a different canonical tree.');
});

test('commit admission rejects a forged checkpoint baseline and rechecks current write permissions', async t => {
  const { app, clients: { alice }, base } = await setup(t);
  await alice.work(intent(['models.py']));
  const work = alice.store.get('work');
  const payload = { intent_id: work.id, intent_revision: work.revision, base_commit: base, workspace_id: alice.options.workspaceId, branch: 'main', path: 'models.py', operation: 'modify', base_content: 'forged\n', base_hash: await hashContent('forged\n'), content: 'replacement\n', result_hash: await hashContent('replacement\n') };
  await alice.request('checkpoints', await signEnvelope(payload, { runId: 'run-a', privateKey: alice.options.privateKey }));
  await assert.rejects(alice.respond({ action: 'commit', message: 'Reject incorrect parent' }), error => error.code === 'base_mismatch');
  await save(alice, 'models.py', 'legitimate\n');
  app.db.prepare('UPDATE runs SET scope=? WHERE id=?').run(JSON.stringify({ files: ['services.py'], operations: ['modify'] }), 'run-a');
  await assert.rejects(alice.respond({ action: 'commit', message: 'Reject removed scope' }), error => error.code === 'scope_denied');
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM uploads').get().n, 0);
});

test('checkout-free handoff preserves decisions and exact WIP, and refuses local edits', async t => {
  const { clients: { alice, bob }, workspaces } = await setup(t);
  const declared = await alice.work(intent(['models.py']));
  await save(alice, 'models.py', 'handed_off = True\n');
  const draft = (await alice.remoteStatus()).checkpoints.at(-1);
  const decision = await alice.respond({ action: 'decision', intent_id: declared.intent_id, title: 'Contract', description: 'Keep the model interface stable.' });
  await alice.respond({ action: 'decision_accept', decision_id: decision.id });
  const handoff = await alice.respond({ action: 'handoff_offer', intent_id: declared.intent_id, checkpoint_id: draft.id, to_run_id: 'run-b', remaining_criteria: ['Review model contract'] });
  await writeFile(join(workspaces.bob, 'models.py'), 'my local edits\n');
  await assert.rejects(bob.respond({ action: 'handoff_accept', handoff_id: handoff.id }), /unchanged source/);
  await rm(join(workspaces.bob, 'models.py'));
  const accepted = await bob.respond({ action: 'handoff_accept', handoff_id: handoff.id });
  assert.equal(accepted.state, 'accepted'); assert.ok(accepted.decision_ids.includes(decision.id));
  assert.equal(await readFile(join(workspaces.bob, 'models.py'), 'utf8'), 'handed_off = True\n');
  assert.equal(bob.store.get('work').intent.done_when[0], 'Review model contract');
  await assert.rejects(access(join(workspaces.bob, '.git')), { code: 'ENOENT' });
});

test('server commit receipt loss retries the same Git object and rejects a changed request', async t => {
  const { app, clients: { alice } } = await setup(t);
  await alice.work(intent(['models.py'])); await save(alice, 'models.py', 'durable = True\n');
  app.db.exec("CREATE TRIGGER reject_source_receipt BEFORE INSERT ON uploads BEGIN SELECT RAISE(ABORT,'simulate receipt loss'); END;");
  const pending = await alice.respond({ action: 'commit', message: 'Durable source commit' });
  assert.equal(pending.state, 'pending');
  const { envelope } = alice.store.pending().find(row => row.id === pending.event_id);
  const commit = await app.gitStore.readRef(`refs/gitpunk/runs/run-a/${envelope.event_id}`);
  await assert.rejects(alice.source({ action: 'file', commit, path: 'models.py' }), error => error.code === 'unknown_commit');
  const changed = await signEnvelope({ ...envelope.payload, message: 'Different message' }, { eventId: envelope.event_id, runId: 'run-a', privateKey: alice.options.privateKey });
  await assert.rejects(alice.request('changesets', changed), error => error.code === 'idempotency_conflict');
  app.db.exec('DROP TRIGGER reject_source_receipt');
  await alice.flush();
  assert.equal(alice.store.get('commit').commit, commit);
  assert.equal(alice.store.get('commit').upload_id, pending.event_id);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM uploads').get().n, 1);
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM events WHERE type='commit.uploaded'").get().n, 1);
  assert.equal(Buffer.from((await alice.source({ action: 'file', commit, path: 'models.py' })).content_base64, 'base64').toString(), 'durable = True\n');
});

test('accepted multi-commit Git history is indexed and old stores backfill on restart', async t => {
  const env = await setup(t), workspace = join(env.root, 'legacy-history');
  await git(env.root, 'clone', env.workspaces.source, workspace);
  const client = await GitpunkClient.create({ credentials: env.clients.alice.options.credentials, identity: 'alice', workspace, stateDir: join(env.root, 'history-state'), upload: true });
  try {
    await client.work(intent(['models.py'])); await client.tick();
    const commits = [];
    for (let value = 3; value <= 4; value++) {
      await writeFile(join(workspace, 'models.py'), `value = ${value}\n`); await git(workspace, 'add', '.');
      await git(workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `Model ${value}`); commits.push(await head(workspace));
    }
    await client.tick(); assert.equal(client.store.get('commit').upload, 'uploaded');
    for (const commit of commits) assert.equal((await client.source({ action: 'file', commit, path: 'models.py' })).commit, commit);
    env.app.db.exec('DELETE FROM git_commits');
    const port = Number(new URL(env.app.address()).port); await env.app.stop();
    env.app = await createGitpunkServer({ dataDir: join(env.root, 'server'), port, bootstrap: true, gitSource: env.workspaces.source }); await env.app.start();
    assert.equal(env.app.db.prepare('SELECT count(*) AS n FROM git_commits').get().n, 2);
    for (const commit of commits) assert.equal((await client.source({ action: 'file', commit, path: 'models.py' })).commit, commit);
  } finally { client.close(); }
});
