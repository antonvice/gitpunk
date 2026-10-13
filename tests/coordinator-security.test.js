import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitpunkServer } from '../server/index.js';
import { createWorkspaces } from '../scripts/git-fixture.js';
import { git, head, committedFiles, exportCommitBundle } from '../client/git.js';
import { canonicalJson, hashContent, exampleIntent, signEnvelope } from '../shared/index.js';

// These test admission/authorization state, using a controlled runner. Docker proof is separate.
async function fixture(t, { approval = 'manual' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-integration-security-'));
  const workspaces = await createWorkspaces(root);
  const runner = async ({ candidate, policy }) => ({ candidate, policy_hash: await hashContent(canonicalJson(policy)),
    image_digest: policy.image, state: 'passed', exit_code: 0, cleanup: 'complete', stdout: '', stderr: '', truncated: false });
  const app = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, port: 0,
    gitSource: workspaces.source, checkPolicy: { image: `test@sha256:${'a'.repeat(64)}`, command: ['true'], approval }, runner });
  await app.start();
  t.after(async () => { await app.stop(); await rm(root, { recursive: true, force: true }); });
  async function request(name, route, payload, attachment = {}, repo = 'demo', token) {
    const identity = app.fixture.identities[name];
    const envelope = payload ? await signEnvelope(payload, { runId: identity.run_id, privateKey: identity.privateKey }) : null;
    const response = await fetch(`${app.address()}/v1/repos/${repo}/${route}`, {
      method: envelope ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token ?? identity.token}`, 'Content-Type': 'application/json' },
      ...(envelope ? { body: JSON.stringify({ ...envelope, ...attachment }) } : {}),
    });
    return { status: response.status, ...await response.json() };
  }
  async function submit(branch = 'main') {
    const workspace = workspaces.alice, base = await head(workspace);
    const declared = await request('alice', 'work', { intent: { ...exampleIntent, files: ['models.py'] },
      base_commit: base, branch, workspace_id: 'workspace-alice' });
    assert.equal(declared.status, 200);
    await writeFile(join(workspace, 'models.py'), 'model = "new work"\n');
    await git(workspace, 'add', 'models.py');
    await git(workspace, '-c', 'user.name=Gitpunk test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Agent change');
    const commit = await head(workspace), bundle = await exportCommitBundle(workspace, base, commit);
    const uploaded = await request('alice', 'commits', { intent_id: declared.data.intent.id, intent_revision: 1,
      workspace_id: 'workspace-alice', branch, base_commit: base, commit,
      bundle_hash: bundle.bundle_hash, files: await committedFiles(workspace, base, commit) }, { bundle_content: bundle.bundle_content });
    assert.equal(uploaded.status, 200);
    return uploaded.data;
  }
  async function until(predicate) {
    for (let i = 0; i < 100; i++) {
      await app.coordinator.flush();
      const state = app.coordinator.status('demo', 'main');
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(JSON.stringify(app.coordinator.status('demo', 'main')));
  }
  return { app, workspaces, request, submit, until };
}

test('a submission targeting another branch cannot change configured main', async t => {
  const env = await fixture(t, { approval: 'automatic' });
  const before = await env.app.gitStore.readRef('refs/heads/main');
  const uploaded = await env.submit('dev');
  // Allow the coordinator to process the accepted upload without relying on a hidden target.
  for (let i = 0; i < 25; i++) { await env.app.coordinator.flush(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(await env.app.gitStore.readRef('refs/heads/main'), before);
  assert.equal(env.app.db.prepare('SELECT state FROM submissions WHERE id=?').get(uploaded.id)?.state, 'failed');
  assert.equal(env.app.db.prepare('SELECT count(*) n FROM checks WHERE submission_id=?').get(uploaded.id).n, 0);
});

test('checks and submission status stay within the authorized repository and branch', async t => {
  const env = await fixture(t);
  const upload = await env.submit();
  await env.until(status => status.submissions.some(row => row.id === upload.id && row.state === 'awaiting_approval'));
  const branch = await env.request('alice', 'status?branch=unrelated');
  assert.equal(branch.status, 200);
  assert.deepEqual(branch.data.integration.submissions, []);
  assert.deepEqual(branch.data.integration.checks, []);
  const bob = env.app.fixture.identities.bob;
  const token = 'other-repository-test-token';
  env.app.db.prepare("INSERT INTO repos(id,owner_id,visibility) VALUES('other','bob','private')").run();
  env.app.db.prepare("INSERT INTO runs(id,agent_id,owner_id,repo_id,token_hash,scope,expires) VALUES('run-other',?,'bob','other',?,?,?)")
    .run(bob.agent_id, createHash('sha256').update(token).digest('hex'), JSON.stringify({ files: ['**'], operations: ['modify'] }), Date.now() + 60_000);
  const other = await env.request('bob', 'status', null, {}, 'other', token);
  assert.equal(other.status, 200);
  for (const key of ['submissions', 'checks', 'operations']) assert.deepEqual(other.data.integration[key], []);
  assert.equal(JSON.stringify(other.data).includes(upload.id), false);
});

test('revoking the source run after a passing check still blocks canonical admission', async t => {
  const env = await fixture(t);
  const before = await env.app.gitStore.readRef('refs/heads/main');
  const uploaded = await env.submit();
  const status = await env.until(status => status.submissions.some(row => row.id === uploaded.id && row.state === 'awaiting_approval'));
  const checked = status.checks.find(row => row.submission_id === uploaded.id);
  env.app.db.prepare("UPDATE access SET role='maintainer' WHERE repo_id='demo' AND user_id='bob'").run();
  env.app.db.prepare("UPDATE runs SET revoked=1 WHERE id='run-a'").run();
  const approved = await env.request('bob', 'respond', { action: 'approve', submission_id: uploaded.id,
    check_id: checked.id, candidate: checked.candidate, target: checked.target, policy_hash: checked.policy_hash });
  assert.equal(approved.status, 200);
  await env.until(status => status.submissions.some(row => row.id === uploaded.id && row.state === 'failed'));
  assert.equal(await env.app.gitStore.readRef('refs/heads/main'), before);
});
