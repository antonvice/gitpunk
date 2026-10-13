import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitpunkServer } from '../server/index.js';
import { exampleIntent, hashContent, signEnvelope } from '../shared/index.js';

const baseCommit = 'a'.repeat(40);
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gitpunk-security-'));
  const app = await createGitpunkServer({ dataDir, port: 0, bootstrap: true, kafkaBrokers: [] });
  const { endpoint } = await app.start();
  t.after(async () => { await app.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const envelope = (name, payload, eventId) => signEnvelope(payload, {
    runId: app.fixture.identities[name].run_id,
    privateKey: app.fixture.identities[name].privateKey,
    ...(eventId ? { eventId } : {}),
  });
  async function request(name, route, body, repo = 'demo', token) {
    const response = await fetch(`${endpoint}/v1/repos/${repo}/${route}`, {
      method: body ? 'POST' : 'GET', headers: {
        Authorization: `Bearer ${token ?? app.fixture.identities[name].token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...(await response.json()) };
  }
  const post = async (name, route, payload, eventId) => request(name, route, await envelope(name, payload, eventId));
  const work = (name, files = ['models.py'], extra = {}) => post(name, 'work', {
    intent: { ...exampleIntent, files }, base_commit: baseCommit, workspace_id: `workspace-${name}`, ...extra,
  });
  async function checkpoint(name, intent, path = 'models.py', content = 'class Car: pass\n', extra = {}) {
    return post(name, 'checkpoints', {
      intent_id: intent.id, intent_revision: intent.revision, branch: intent.branch,
      path, operation: 'create', base_hash: null, result_hash: await hashContent(content),
      content, base_content: null, workspace_id: `workspace-${name}`, base_commit: baseCommit, ...extra,
    });
  }
  return { app, endpoint, envelope, request, post, work, checkpoint };
}

test('credentials, signing keys and repository membership are independent gates', async t => {
  const s = await setup(t);
  const payload = { intent: { ...exampleIntent, files: ['models.py'] }, base_commit: baseCommit, workspace_id: 'workspace-alice' };
  const alice = await s.envelope('alice', payload);
  assert.equal((await s.request('alice', 'work', alice, 'demo', 'invalid')).status, 401);
  assert.equal((await s.request('bob', 'work', alice)).status, 400);
  const wrongSigner = await signEnvelope(payload, { runId: 'run-a', privateKey: s.app.fixture.identities.bob.privateKey });
  assert.equal((await s.request('alice', 'work', wrongSigner)).error.code, 'invalid_signature');
  s.app.db.prepare("INSERT INTO repos(id,owner_id,visibility) VALUES('other','alice','public')").run();
  assert.equal((await s.request('alice', 'work', alice, 'other')).status, 403, 'run credential is repository-scoped');
  assert.equal((await s.request('bob', 'status', null, 'other')).status, 403, 'public source does not expose collaboration');
  s.app.db.prepare("DELETE FROM access WHERE repo_id='demo' AND user_id='bob'").run();
  assert.equal((await s.request('bob', 'events')).status, 403);
  s.app.db.prepare("UPDATE agents SET revoked=1 WHERE id='agent-a'").run();
  assert.equal((await s.request('alice', 'status')).status, 401);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM events').get().n, 0);
});

test('retries replay only the same authenticated operation', async t => {
  const s = await setup(t);
  const payload = { intent: { ...exampleIntent, files: ['models.py'] }, base_commit: baseCommit, workspace_id: 'workspace-alice' };
  const first = await s.envelope('alice', payload, 'retry-1');
  const a = await s.request('alice', 'work', first);
  const b = await s.request('alice', 'work', first);
  assert.equal(a.status, 200);
  assert.deepEqual(b.data, a.data);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM events').get().n, 1);
  const changed = await s.envelope('alice', { ...payload, intent: { ...payload.intent, title: 'Different work' } }, 'retry-1');
  assert.equal((await s.request('alice', 'work', changed)).error.code, 'idempotency_conflict');
  const otherActor = await s.envelope('bob', payload, 'retry-1');
  assert.equal((await s.request('bob', 'work', otherActor)).error.code, 'idempotency_conflict');
  s.app.db.prepare("UPDATE runs SET revoked=1 WHERE id='run-a'").run();
  assert.equal((await s.request('alice', 'work', first)).status, 401, 'revocation also denies cached retry responses');
});

test('failed event storage rolls back intent, claim and idempotency receipt together', async t => {
  const s = await setup(t);
  s.app.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
  const body = await s.envelope('alice', { intent: { ...exampleIntent, files: ['models.py'] }, base_commit: baseCommit, workspace_id: 'workspace-alice' }, 'rollback-1');
  assert.equal((await s.request('alice', 'work', body)).status, 500);
  for (const table of ['intents', 'claims', 'events', 'requests'])
    assert.equal(s.app.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  s.app.db.exec('DROP TRIGGER reject_event');
  assert.equal((await s.request('alice', 'work', body)).status, 200);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM events').get().n, 1);
});

test('snapshot admission binds scope, exact baseline, branch, workspace and content', async t => {
  const s = await setup(t);
  const { intent } = (await s.work('alice')).data;
  for (const [extra, code] of [
    [{ result_hash: 'b'.repeat(64) }, 'hash_mismatch'],
    [{ operation: 'modify', base_hash: 'b'.repeat(64), base_content: 'wrong baseline' }, 'hash_mismatch'],
    [{ base_commit: 'b'.repeat(40) }, 'base_mismatch'],
    [{ workspace_id: 'workspace-bob' }, 'base_mismatch'],
    [{ branch: 'different-branch' }, 'base_mismatch'],
  ]) assert.equal((await s.checkpoint('alice', intent, 'models.py', 'safe text', extra)).error.code, code);
  assert.equal((await s.checkpoint('alice', intent, 'services.py')).error.code, 'outside_intent');
  assert.equal((await s.checkpoint('bob', intent)).status, 403);
  assert.equal((await s.checkpoint('alice', intent, '.env')).status, 403);
  assert.equal((await s.checkpoint('alice', intent, '../outside')).status, 400);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM checkpoints').get().n, 0);
  assert.equal((await s.checkpoint('alice', intent)).status, 200);
});

test('leases and peer revisions cannot be bypassed by stale acknowledgements', async t => {
  const s = await setup(t);
  const a = (await s.work('alice')).data.intent;
  const b = (await s.work('bob')).data.intent;
  assert.equal((await s.checkpoint('bob', b)).error.code, 'overlap');
  assert.equal((await s.post('bob', 'respond', { action: 'overlap', intent_id: b.id, peer_intent_id: a.id, peer_revision: a.revision, mode: 'coedit' })).status, 200);
  assert.equal((await s.checkpoint('bob', b)).status, 200);
  const a2 = (await s.work('alice', ['models.py'], { id: a.id, expected_revision: 1 })).data.intent;
  assert.equal(a2.revision, 2);
  assert.equal((await s.post('alice', 'respond', { action: 'overlap', intent_id: a.id, peer_intent_id: b.id, peer_revision: b.revision, mode: 'coedit' })).status, 200);
  assert.equal((await s.checkpoint('bob', b)).error.code, 'overlap');
  assert.equal((await s.post('bob', 'respond', { action: 'overlap', intent_id: b.id, peer_intent_id: a.id, peer_revision: 1, mode: 'coedit' })).error.code, 'stale_revision');
  s.app.db.prepare('UPDATE claims SET expires=0 WHERE intent_id=?').run(b.id);
  assert.equal((await s.checkpoint('bob', b)).error.code, 'lease_expired');
  assert.equal((await s.post('bob', 'respond', { action: 'renew', intent_id: b.id })).error.code, 'lease_expired');
});

test('deleting an uncommitted new file requires a recorded create checkpoint', async t => {
  const s = await setup(t);
  const { intent } = (await s.work('alice')).data;
  const deletion = { operation: 'delete', base_hash: null, result_hash: null, content: null, base_content: null };
  const unsupported = await s.checkpoint('alice', intent, 'models.py', 'unused', deletion);
  assert.equal(unsupported.status, 409);
  assert.equal((await s.checkpoint('alice', intent)).status, 200);
  const deleted = await s.checkpoint('alice', intent, 'models.py', 'unused', deletion);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.checkpoint.content, null);
  assert.equal(deleted.data.checkpoint.base_hash, null);
});

test('private prompts and recognized credentials never enter accepted events', async t => {
  const s = await setup(t);
  for (const intent of [
    { ...exampleIntent, prompt: 'do not publish this raw prompt' },
    { ...exampleIntent, sharing: 'prompt', prompt: '-----BEGIN PRIVATE KEY-----\nprivate' },
  ]) assert.equal((await s.post('alice', 'work', { intent, base_commit: baseCommit, workspace_id: 'workspace-alice' })).status >= 400, true);
  const { intent } = (await s.work('alice')).data;
  assert.equal((await s.checkpoint('alice', intent, 'models.py', 'ghp_' + 'A'.repeat(40))).error.code, 'secret_detected');
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM checkpoints').get().n, 0);
  const stored = s.app.db.prepare('SELECT payload FROM events').all().map(row => row.payload).join('');
  assert.equal(stored.includes('do not publish'), false);
  assert.equal(stored.includes('BEGIN PRIVATE KEY'), false);
});

test('only the handoff recipient can accept and its checkpoint list remains pinned', async t => {
  const s = await setup(t);
  const { intent } = (await s.work('alice', ['models.py', 'services.py'])).data;
  const m1 = (await s.checkpoint('alice', intent, 'models.py', 'model v1')).data.checkpoint;
  const s1 = (await s.checkpoint('alice', intent, 'services.py', 'service v1')).data.checkpoint;
  const offer = (await s.post('alice', 'respond', {
    action: 'handoff_offer', intent_id: intent.id, checkpoint_id: s1.id,
    to_run_id: 'run-b', remaining_criteria: ['CRUD tests pass'],
  })).data;
  assert.deepEqual(new Set(offer.checkpoint_ids), new Set([m1.id, s1.id]));
  await s.checkpoint('alice', intent, 'models.py', 'model v2');
  assert.equal((await s.post('alice', 'respond', { action: 'handoff_accept', handoff_id: offer.id })).status, 403);
  const accepted = await s.post('bob', 'respond', { action: 'handoff_accept', handoff_id: offer.id });
  assert.equal(accepted.status, 200);
  assert.deepEqual(new Set(accepted.data.checkpoint_ids), new Set([m1.id, s1.id]));
  assert.deepEqual(accepted.data.remaining_criteria, ['CRUD tests pass']);
});

test('byte-bounded polling replays large draft backlogs without stranding the cursor', async t => {
  const s = await setup(t);
  const { intent } = (await s.work('alice')).data;
  for (let i = 0; i < 10; i++)
    assert.equal((await s.checkpoint('alice', intent, 'models.py', `draft-${i}:` + 'x'.repeat(240_000))).status, 200);
  let cursor = 0, events = [];
  for (let page = 0; page < 10; page++) {
    const polled = await s.request('bob', `events?after=${cursor}`);
    assert.equal(polled.status, 200);
    assert.ok(Buffer.byteLength(JSON.stringify(polled.data)) < 1_600_000, 'polling stays below the client response limit');
    assert.ok(polled.data.next_cursor > cursor, 'nonempty pages advance the cursor');
    events.push(...polled.data.events);
    cursor = polled.data.next_cursor;
    if (!polled.data.more) break;
  }
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: 11 }, (_, i) => i + 1));
  const checkpointId = events.find(event => event.type === 'draft.changed').payload.id;
  const fetched = await s.request('bob', `checkpoints/${checkpointId}`);
  assert.equal(fetched.status, 200);
  assert.ok(fetched.data.content.startsWith('draft-0:'));
});

test('revocation during a slow upload is checked again before mutation', async t => {
  const s = await setup(t);
  const body = await s.envelope('alice', { intent: { ...exampleIntent, files: ['models.py'] }, base_commit: baseCommit, workspace_id: 'workspace-alice' });
  const result = new Promise((resolve, reject) => {
    const request = http.request(`${s.endpoint}/v1/repos/demo/work`, {
      method: 'POST', headers: { Authorization: `Bearer ${s.app.fixture.identities.alice.token}`, 'Content-Type': 'application/json' },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.write(' ');
    delay(50).then(() => {
      s.app.db.prepare("UPDATE runs SET revoked=1 WHERE id='run-a'").run();
      request.end(JSON.stringify(body));
    }).catch(reject);
  });
  assert.equal((await result).status, 401);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM events').get().n, 0);
});
