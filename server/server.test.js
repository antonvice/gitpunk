import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createGitpunkServer, readOidcConfig } from './index.js';
import { signEnvelope, hashContent, exampleIntent } from '../shared/index.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gitpunk-server-test-'));
  let app = await createGitpunkServer({ dataDir, port: 0, bootstrap: true, ...options });
  await app.start();
  t.after(async () => { await app.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (who, route, payload, eventId) => {
    const credential = app.fixture.identities[who];
    const body = payload === undefined ? undefined : await signEnvelope(payload, { eventId, runId: credential.run_id, privateKey: credential.privateKey });
    const response = await fetch(`${app.address()}/v1/repos/demo/${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...await response.json() };
  };
  return { call, get app() { return app; }, async restart() { await app.stop(); app = await createGitpunkServer({ dataDir, port: 0, bootstrap: true, ...options }); await app.start(); } };
}
const request = (files = ['models.py']) => ({ intent: { ...exampleIntent, files }, base_commit: 'a'.repeat(40), workspace_id: 'workspace-a' });
const draft = async (intent, file, content) => ({ intent_id: intent.id, intent_revision: intent.revision, path: file, operation: 'create', base_hash: null, result_hash: await hashContent(content), content, workspace_id: intent.workspace_id, base_commit: intent.base_commit });

test('OIDC credentials load only from private regular files and invalid JSON stays private', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpunk-oidc-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  const fixture = { client_secret: 'fixture-secret' };
  await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
  assert.deepEqual(await readOidcConfig(file), fixture);
  await chmod(file, 0o644);
  await assert.rejects(readOidcConfig(file), /private, owner-controlled/);
  await chmod(file, 0o600);
  const link = path.join(root, 'link.json'); await symlink(file, link);
  await assert.rejects(readOidcConfig(link), /private, owner-controlled/);
  await writeFile(file, '{"client_secret":"fixture-secret"');
  await assert.rejects(readOidcConfig(file), error => !error.message.includes('fixture-secret'));
  await writeFile(file, 'x'.repeat(16_385));
  await assert.rejects(readOidcConfig(file), /at most 16 KiB/);
});

test('human sessions work over HTTP and never replace signed agent credentials', async t => {
  const disabled = await fixture(t);
  assert.equal((await (await fetch(`${disabled.app.address()}/health`)).json()).data.human_login.configured, false);
  const absent = await fetch(`${disabled.app.address()}/auth/login`);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).error.code, 'human_auth_not_configured');

  const origin = 'http://127.0.0.1:8787';
  const env = await fixture(t, { oidcConfig: { issuer: 'https://issuer.example.invalid', client_id: 'fixture-client', client_secret: 'fixture-secret', public_url: origin, allow_loopback_http: true } });
  const token = 'a'.repeat(43), headers = { Host: new URL(origin).host, Cookie: `gitpunk_dev_session=${token}` };
  const authRequest = (route, options = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${env.app.address()}${route}`, { headers, ...options }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('error', reject);
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })));
    });
    outgoing.on('error', reject); outgoing.end();
  });
  env.app.db.prepare('INSERT INTO users(id,name) VALUES(?,?)').run('human-http', 'Human HTTP');
  env.app.db.prepare('INSERT INTO human_sessions(token_hash,user_id,expires,created_at) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'human-http', Date.now() + 60_000, Date.now());
  const health = await (await fetch(`${env.app.address()}/health`)).json();
  assert.equal(health.data.human_login.configured, true);
  assert.ok(!JSON.stringify(health).includes('fixture-secret'));
  const me = await authRequest('/me');
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.user.id, 'human-http');
  const denied = await fetch(`${env.app.address()}/v1/repos/demo/status`, { headers });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'unauthenticated');
  const signedIdentity = await fetch(`${env.app.address()}/v1/repos/demo/status`, { headers: { ...headers, Authorization: `Bearer ${env.app.fixture.identities.alice.token}` } });
  assert.equal((await signedIdentity.json()).data.actor.owner_id, 'alice');
  const logout = await authRequest('/auth/logout', { method: 'POST', headers: { ...headers, Origin: origin } });
  assert.equal(logout.status, 200);
  assert.equal((await authRequest('/me')).status, 401);
});

test('ordered polling, idempotent retry and SQLite restart retain accepted work', async t => {
  const env = await fixture(t);
  const first = await env.call('alice', 'work', request(), 'work-1');
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.intent.actor, { run_id: 'run-a', agent_id: 'agent-a', owner_id: 'alice' });
  const again = await env.call('alice', 'work', request(), 'work-1');
  assert.deepEqual(again.data, first.data);
  const changed = await env.call('alice', 'work', request(['services.py']), 'work-1');
  assert.equal(changed.error.code, 'idempotency_conflict');
  const saved = await env.call('alice', 'checkpoints', await draft(first.data.intent, 'models.py', 'class Car: pass\n'), 'save-1');
  assert.equal(saved.status, 200);
  const events = await env.call('bob', 'events?after=0');
  assert.deepEqual(events.data.events.map(event => event.seq), [1, 2]);
  assert.equal(events.data.events[1].type, 'draft.changed');
  assert.deepEqual(events.data.events[1].actor, { run_id: 'run-a', agent_id: 'agent-a', owner_id: 'alice' });
  await env.restart();
  const checkpoint = await env.call('bob', 'checkpoints/save-1');
  assert.equal(checkpoint.data.content, 'class Car: pass\n');
  assert.deepEqual(checkpoint.data.actor, { run_id: 'run-a', agent_id: 'agent-a', owner_id: 'alice' });
  assert.deepEqual((await env.call('bob', 'status')).data.actor, { run_id: 'run-b', agent_id: 'agent-b', owner_id: 'bob' });
  const tail = await env.call('bob', 'events?after=2');
  assert.equal(tail.data.next_cursor, 2);
  assert.deepEqual(tail.data.events, []);
});

test('later overlapping intent blocks only the newcomer until pinned acknowledgement', async t => {
  const env = await fixture(t);
  const a = (await env.call('alice', 'work', request(), 'alice-work')).data.intent;
  const bResult = await env.call('bob', 'work', { ...request(), workspace_id: 'workspace-b' }, 'bob-work');
  assert.equal(bResult.data.state, 'blocked');
  const b = bResult.data.intent;
  assert.equal((await env.call('alice', 'checkpoints', await draft(a, 'models.py', 'a'), 'alice-save')).status, 200);
  assert.equal((await env.call('bob', 'checkpoints', await draft(b, 'models.py', 'b'), 'bob-save')).error.code, 'overlap');
  assert.equal((await env.call('bob', 'respond', { action: 'overlap', intent_id: b.id, peer_intent_id: a.id, peer_revision: a.revision, mode: 'coedit' }, 'ack-overlap')).status, 200);
  assert.equal((await env.call('bob', 'checkpoints', await draft(b, 'models.py', 'b'), 'bob-save')).status, 200);
  assert.equal((await env.call('alice', 'checkpoints', await draft(a, 'models.py', 'a2'), 'alice-save-2')).status, 200);
});

test('decision acceptance and multi-file pinned handoff produce usable continuation', async t => {
  const env = await fixture(t);
  const a = (await env.call('alice', 'work', request(['models.py','services.py']), 'work-a')).data.intent;
  await env.call('alice', 'checkpoints', await draft(a, 'models.py', 'class Car: pass\n'), 'save-model');
  await env.call('alice', 'checkpoints', await draft(a, 'services.py', 'def list_cars(): return []\n'), 'save-services');
  const decision = await env.call('alice', 'respond', { action: 'decision', intent_id: a.id, title: 'Car ID is UUID', description: 'Use stable UUID car IDs across model and CRUD API.' }, 'decision-a');
  assert.equal(decision.data.state, 'proposed');
  const agreed = await env.call('bob', 'respond', { action: 'decision_accept', decision_id: 'decision-a' }, 'accept-decision');
  assert.equal(agreed.data.state, 'agreed');
  const offer = await env.call('alice', 'respond', { action: 'handoff_offer', intent_id: a.id, checkpoint_id: 'save-services', to_run_id: 'run-b', remaining_criteria: ['Add CRUD tests'] }, 'offer-a');
  assert.deepEqual(offer.data.checkpoint_ids, ['save-model', 'save-services']);
  assert.deepEqual(offer.data.decision_ids, ['decision-a']);
  const accepted = await env.call('bob', 'respond', { action: 'handoff_accept', handoff_id: 'offer-a', workspace_id: 'workspace-b' }, 'accept-handoff');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.intent.run_id, 'run-b');
  assert.deepEqual(accepted.data.intent.done_when, ['Add CRUD tests']);
  assert.equal((await env.call('bob', 'checkpoints', await draft(accepted.data.intent, 'services.py', 'def list_cars(): return [1]\n'), 'continue-b')).status, 200);
  const status = await env.call('alice', 'status');
  assert.equal(status.data.intents.find(intent => intent.id === a.id).state, 'handed_off');
});

test('lease expiration does not revive on polling and requires explicit work revision', async t => {
  const env = await fixture(t, { leaseMs: 10 });
  const a = (await env.call('alice', 'work', request(), 'work-a')).data.intent;
  await new Promise(resolve => setTimeout(resolve, 20));
  await env.call('alice', 'events?after=0');
  assert.equal((await env.call('alice', 'checkpoints', await draft(a, 'models.py', 'expired'), 'expired')).error.code, 'lease_expired');
  const resumed = await env.call('alice', 'work', { ...request(), id: a.id, expected_revision: a.revision }, 'resumed');
  assert.equal(resumed.data.revision, 2);
});

test('large signed draft history pages remain bounded and replay without gaps', async t => {
  const env = await fixture(t);
  const intent = (await env.call('alice', 'work', request(), 'page-work')).data.intent;
  const content = 'x'.repeat(100_000);
  for (let i = 0; i < 20; i++) assert.equal((await env.call('alice', 'checkpoints', await draft(intent, 'models.py', content + i), `page-save-${i}`)).status, 200);
  const sequences = []; let cursor = 0, pages = 0, more;
  do {
    const result = await env.call('bob', `events?after=${cursor}`);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_600_000);
    sequences.push(...result.data.events.map(event => event.seq));
    cursor = result.data.next_cursor; more = result.data.more; pages++;
  } while (more);
  assert.ok(pages > 1);
  assert.deepEqual(sequences, Array.from({ length: 21 }, (_, index) => index + 1));
});

test('an obsolete decision proposal cannot become agreed after the intent changes', async t => {
  const env = await fixture(t);
  const intent = (await env.call('alice', 'work', request(), 'decision-work')).data.intent;
  assert.equal((await env.call('alice', 'respond', { action: 'decision', intent_id: intent.id, title: 'Integer IDs', description: 'Use integer IDs.' }, 'old-decision')).status, 200);
  await env.call('alice', 'work', { ...request(), id: intent.id, expected_revision: 1 }, 'decision-work-update');
  const acceptance = await env.call('bob', 'respond', { action: 'decision_accept', decision_id: 'old-decision' }, 'old-decision-accept');
  assert.equal(acceptance.error.code, 'stale_decision');
});

test('permission changes during Git read-back block final upload admission', async t => {
  const { createWorkspaces } = await import('../scripts/git-fixture.js');
  const { git, head, committedFiles, exportCommitBundle } = await import('../client/git.js');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpunk-scope-upload-'));
  const workspaces = await createWorkspaces(root);
  const base = await head(workspaces.alice);
  const app = await createGitpunkServer({ dataDir: path.join(root, 'server'), port: 0, bootstrap: true, gitSource: workspaces.source });
  await app.start();
  t.after(async () => { await app.stop(); await rm(root, { recursive: true, force: true }); });
  const who = app.fixture.identities.alice;
  const send = async (route, payload, attachment = {}) => {
    const envelope = await signEnvelope(payload, { runId: who.run_id, privateKey: who.privateKey });
    const response = await fetch(`${app.address()}/v1/repos/demo/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...envelope, ...attachment }) });
    return { status: response.status, ...await response.json() };
  };
  const work = await send('work', { ...request(), base_commit: base });
  await writeFile(path.join(workspaces.alice, 'models.py'), '# Actual permission-controlled change\n');
  await git(workspaces.alice, 'add', 'models.py');
  await git(workspaces.alice, '-c', 'user.name=Gitpunk test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Change model');
  const commit = await head(workspaces.alice), bundle = await exportCommitBundle(workspaces.alice, base, commit);
  const readRef = app.gitStore.readRef.bind(app.gitStore);
  app.gitStore.readRef = async ref => {
    const result = await readRef(ref);
    app.db.prepare("UPDATE runs SET scope=? WHERE id='run-a'").run(JSON.stringify({ files: [], operations: [] }));
    return result;
  };
  const rejected = await send('commits', { intent_id: work.data.intent.id, intent_revision: 1, branch: 'main', workspace_id: 'workspace-a', base_commit: base, commit, bundle_hash: bundle.bundle_hash, files: await committedFiles(workspaces.alice, base, commit) }, { bundle_content: bundle.bundle_content });
  assert.equal(rejected.error.code, 'scope_changed');
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM uploads').get().n, 0);
  assert.equal(await readRef('refs/heads/main'), base);
});
