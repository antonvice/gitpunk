import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitpunkServer } from './index.js';
import { createWorkspaces } from '../scripts/git-fixture.js';
import { git, head, committedFiles, exportCommitBundle } from '../client/git.js';
import { exampleIntent, canonicalJson, hashContent, hashBytes, signEnvelope } from '../shared/index.js';

// These isolate coordinator state-machine tests. Actual Docker execution is tested separately.
const policy = { image: `test@sha256:${'a'.repeat(64)}`, command: ['true'], approval: 'automatic' };
async function setup(t, { approval = 'automatic', result = () => 'passed' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-coordinator-'));
  const workspaces = await createWorkspaces(root);
  const dataDir = join(root, 'server');
  const calls = [];
  const runner = async ({ candidate, policy }) => { calls.push(candidate); return { state: result(candidate, calls.length), candidate, image_digest: policy.image, policy_hash: await hashContent(canonicalJson(policy)), exit_code: 0, stdout: '', stderr: '', truncated: false }; };
  let app = await createGitpunkServer({ dataDir, bootstrap: true, port: 0, gitSource: workspaces.source, checkPolicy: { ...policy, approval }, runner });
  await app.start();
  t.after(async () => { await app.stop(); await rm(root, { recursive: true, force: true }); });
  async function request(name, route, payload, attachment = {}) {
    const identity = app.fixture.identities[name];
    const envelope = payload ? await signEnvelope(payload, { runId: identity.run_id, privateKey: identity.privateKey }) : null;
    const response = await fetch(`${app.address()}/v1/repos/demo/${route}`, { method: envelope ? 'POST' : 'GET', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' }, ...(envelope ? { body: JSON.stringify({ ...envelope, ...attachment }) } : {}) });
    return { status: response.status, ...await response.json() };
  }
  async function submit(name, file, suffix) {
    const workspace = workspaces[name], base = await head(workspace);
    const declared = await request(name, 'work', { intent: { ...exampleIntent, files: [file] }, base_commit: base, branch: 'main', workspace_id: `workspace-${name}` });
    assert.equal(declared.status, 200);
    for (const peer of declared.data.overlaps) assert.equal((await request(name, 'respond', { action: 'overlap', intent_id: declared.data.intent.id, peer_intent_id: peer.intent_id, peer_revision: peer.revision, mode: 'coedit' })).status, 200);
    await writeFile(join(workspace, file), suffix);
    await git(workspace, 'add', file);
    await git(workspace, '-c', 'user.name=Gitpunk test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `Change ${file}`);
    const commit = await head(workspace), bundle = await exportCommitBundle(workspace, base, commit);
    const manifest = { intent_id: declared.data.intent.id, intent_revision: 1, workspace_id: `workspace-${name}`, branch: 'main', base_commit: base, commit, bundle_hash: bundle.bundle_hash, files: await committedFiles(workspace, base, commit) };
    const response = await request(name, 'commits', manifest, { bundle_content: bundle.bundle_content });
    assert.equal(response.status, 200);
    return response.data;
  }
  async function until(predicate) {
    const limit = Date.now() + 6000;
    while (Date.now() < limit) { await app.coordinator.flush(); const status = app.coordinator.status(); if (predicate(status)) return status; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(JSON.stringify(app.coordinator.status()));
  }
  return { get app() { return app; }, request, submit, until, calls, workspaces, async restart() { await app.stop(); app = await createGitpunkServer({ dataDir, bootstrap: true, port: 0, gitSource: workspaces.source, checkPolicy: { ...policy, approval }, runner }); await app.start(); } };
}

test('FIFO integration preserves earlier target changes in a three-way candidate', async t => {
  const env = await setup(t);
  const a = await env.submit('alice', 'models.py', 'model = "first agent"\n');
  await env.until(status => status.submissions.find(row => row.id === a.id)?.state === 'integrated');
  const b = await env.submit('bob', 'services.py', 'service = "second agent"\n');
  const status = await env.until(status => status.submissions.filter(row => row.state === 'integrated').length === 2);
  const target = await env.app.gitStore.readRef('refs/heads/main');
  assert.equal(await git(env.app.gitStore.directory, 'show', `${target}:models.py`), 'model = "first agent"');
  assert.equal(await git(env.app.gitStore.directory, 'show', `${target}:services.py`), 'service = "second agent"');
  const events = env.app.db.prepare("SELECT payload FROM events WHERE type='integration.finished' ORDER BY seq").all().map(row => JSON.parse(row.payload));
  assert.deepEqual(events.map(event => event.submission_id), [a.id, b.id]);
  assert.equal(status.checks[1].target, status.checks[0].candidate);
  const snapshot = await env.request('bob', 'target/bundle');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.origin, 'server');
  assert.equal(snapshot.data.commit, target);
  assert.equal(await hashBytes(Buffer.from(snapshot.data.bundle_content, 'base64')), snapshot.data.bundle_hash);
  assert.deepEqual(snapshot.data.files.map(file => file.path), ['models.py', 'services.py']);
  const branchStatus = await env.request('bob', 'status?branch=dev');
  assert.equal(branchStatus.data.git.configured, false);
  assert.deepEqual(branchStatus.data.integration.submissions, []);
});

test('failed checks leave the ready queue so later eligible work can integrate', async t => {
  const env = await setup(t, { result: (_candidate, n) => n === 1 ? 'failed' : 'passed' });
  const a = await env.submit('alice', 'models.py', 'model = "fails check"\n');
  await env.until(status => status.submissions.find(row => row.id === a.id)?.state === 'failed');
  const b = await env.submit('bob', 'services.py', 'service = "passes check"\n');
  const status = await env.until(status => status.submissions.find(row => row.id === b.id)?.state === 'integrated');
  assert.equal(status.submissions.find(row => row.id === a.id).state, 'failed');
  const target = await env.app.gitStore.readRef('refs/heads/main');
  assert.ok(!(await git(env.app.gitStore.directory, 'show', `${target}:models.py`)).includes('fails check'));
});

test('manual approval rejects contributors and stale tuples then integrates exact passing candidate', async t => {
  const env = await setup(t, { approval: 'manual' });
  const a = await env.submit('alice', 'models.py', 'model = "approved"\n');
  let status = await env.until(status => status.submissions[0]?.state === 'awaiting_approval');
  const old = status.checks[0];
  const action = checked => ({ action: 'approve', submission_id: a.id, check_id: checked.id, candidate: checked.candidate, target: checked.target, policy_hash: checked.policy_hash });
  assert.equal((await env.request('bob', 'respond', action(old))).status, 403);
  const b = await env.submit('bob', 'services.py', 'service = "externally advanced target"\n');
  env.app.gitStore.compareAndSwap(old.target, b.commit); // Trusted administrator race fixture.
  assert.equal((await env.request('alice', 'respond', action(old))).status, 409);
  status = await env.until(status => status.checks.length >= 2 && status.submissions[0].state === 'awaiting_approval');
  const current = status.checks.filter(row => row.submission_id === a.id).at(-1);
  assert.notEqual(current.candidate, old.candidate);
  assert.equal(current.target, b.commit);
  assert.equal((await env.request('alice', 'respond', action(current))).status, 200);
  await env.until(status => status.submissions[0].state === 'integrated');
});

test('prepared canonical update recovers the missing SQLite receipt without applying twice', async t => {
  const env = await setup(t);
  env.app.db.exec("CREATE TRIGGER reject_integrated_event BEFORE INSERT ON events WHEN NEW.type='integration.finished' BEGIN SELECT RAISE(ABORT,'simulate receipt loss'); END;");
  const a = await env.submit('alice', 'models.py', 'model = "durable integration"\n');
  const before = await env.until(status => status.operations.some(row => row.state === 'prepared'));
  const operation = before.operations[0];
  assert.equal(await env.app.gitStore.readRef('refs/heads/main'), operation.candidate);
  assert.equal(env.app.db.prepare("SELECT count(*) AS n FROM events WHERE type='integration.finished'").get().n, 0);
  env.app.db.exec('DROP TRIGGER reject_integrated_event');
  await env.restart();
  const after = await env.until(status => status.submissions[0]?.state === 'integrated');
  assert.equal(after.operations[0].state, 'integrated');
  assert.equal(after.operations[0].candidate, operation.candidate);
  assert.equal(env.calls.length, 1);
  assert.equal(env.app.db.prepare("SELECT count(*) AS n FROM events WHERE type='integration.finished'").get().n, 1);
});

test('restart closes interrupted check evidence before retrying the exact submission', async t => {
  const env = await setup(t, { approval: 'manual' });
  const a = await env.submit('alice', 'models.py', 'model = "interrupted check"\n');
  const before = await env.until(status => status.submissions[0]?.state === 'awaiting_approval');
  const old = before.checks[0];
  // Persist the state a process crash leaves while its external runner is active.
  env.app.db.prepare("UPDATE submissions SET state='checking' WHERE id=?").run(a.id);
  env.app.db.prepare("UPDATE checks SET state='running',result=NULL WHERE id=?").run(old.id);
  await env.restart();
  const after = await env.until(status => status.checks.length === 2 && status.submissions[0]?.state === 'awaiting_approval');
  assert.equal(after.checks[0].state, 'error');
  assert.equal(after.checks[0].result.code, 'interrupted_check');
  assert.equal(after.checks[1].state, 'passed');
  assert.equal(env.calls.length, 2);
  assert.equal(env.app.db.prepare("SELECT count(*) AS n FROM events WHERE type='checks.interrupted'").get().n, 1);
  const staleApproval = { action: 'approve', submission_id: a.id, check_id: old.id, candidate: old.candidate, target: old.target, policy_hash: old.policy_hash };
  assert.equal((await env.request('alice', 'respond', staleApproval)).status, 409);
});

test('a transient canonical bundle export error can be retried for the same target', async t => {
  const env = await setup(t);
  const a = await env.submit('alice', 'models.py', 'model = "retry export"\n');
  await env.until(status => status.submissions.find(row => row.id === a.id)?.state === 'integrated');
  const blocker = join(env.app.gitStore.directory, 'refs', 'gitpunk', 'exports');
  // A trusted administrator's temporary ref blocks the export namespace.
  await writeFile(blocker, `${env.app.gitStore.config.base_commit}\n`);
  assert.equal((await env.request('bob', 'target/bundle')).status, 500);
  await rm(blocker);
  const retried = await env.request('bob', 'target/bundle');
  assert.equal(retried.status, 200);
  assert.equal(retried.data.commit, await env.app.gitStore.readRef('refs/heads/main'));
  assert.equal(await hashBytes(Buffer.from(retried.data.bundle_content, 'base64')), retried.data.bundle_hash);
});

test('a throwing runner closes the new check when a previously failed submission is retried', async t => {
  const env = await setup(t, { result: (_candidate, n) => { if (n === 2) throw new Error('Runner transport failed'); return n === 1 ? 'failed' : 'passed'; } });
  const a = await env.submit('alice', 'models.py', 'model = "retry runner"\n');
  await env.until(status => status.submissions[0]?.state === 'failed');
  assert.equal((await env.request('alice', 'respond', { action: 'retry_check', submission_id: a.id })).status, 200);
  const status = await env.until(status => status.checks.length === 2 && status.submissions[0]?.state === 'failed');
  assert.equal(status.checks[0].state, 'failed');
  assert.equal(status.checks[1].state, 'error');
  assert.equal(status.checks[1].result.message, 'Runner transport failed');
  assert.equal(status.submissions[0].check_id, status.checks[1].id);
  const b = await env.submit('bob', 'services.py', 'service = "survives failed runner"\n');
  await env.until(status => status.submissions.find(row => row.id === b.id)?.state === 'integrated');
});

test('a real three-way merge conflict preserves canonical code and does not run checks', async t => {
  const env = await setup(t);
  const a = await env.submit('alice', 'models.py', 'model = "first conflicting author"\n');
  await env.until(status => status.submissions[0]?.state === 'integrated');
  const pinned = await env.app.gitStore.readRef('refs/heads/main');
  const b = await env.submit('bob', 'models.py', 'model = "second conflicting author"\n');
  const blocked = await env.until(status => status.submissions.find(row => row.id === b.id)?.state === 'conflict');
  assert.equal(await env.app.gitStore.readRef('refs/heads/main'), pinned);
  assert.equal(env.calls.length, 1);
  assert.equal(blocked.checks.find(row => row.submission_id === b.id).state, 'conflict');
  const conflict = JSON.parse(env.app.db.prepare("SELECT payload FROM events WHERE type='integration.conflict'").get().payload);
  assert.ok(conflict.details.includes('models.py'));
  const c = await env.submit('alice', 'services.py', 'service = "continues past conflict"\n');
  await env.until(status => status.submissions.find(row => row.id === c.id)?.state === 'integrated');
  const target = await env.app.gitStore.readRef('refs/heads/main');
  assert.equal(await git(env.app.gitStore.directory, 'show', `${target}:models.py`), 'model = "first conflicting author"');
  assert.equal(env.calls.length, 2);
});
