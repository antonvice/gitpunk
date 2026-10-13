import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IntentInput, WorkRequest, CheckpointInput, RespondInput, SafePath, ProtocolError,
  parseInput, canonicalJson, hashContent, generateKeyPair, signEnvelope, verifyEnvelope, exampleIntent,
} from './index.js';

test('signatures survive JSON transport and key order, but bind every event field', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const envelope = await signEnvelope({ intent: exampleIntent, base_commit: 'a'.repeat(40) },
    { eventId: 'event-1', runId: 'agent-1', privateKey });
  assert.equal(await verifyEnvelope(JSON.parse(JSON.stringify(envelope)), publicKey), true);
  assert.equal(await verifyEnvelope({ ...envelope, payload: { base_commit: 'a'.repeat(40), intent: exampleIntent } }, publicKey), true);
  for (const mutation of [
    { run_id: 'agent-2' }, { event_id: 'event-2' },
    { payload: { ...envelope.payload, base_commit: 'b'.repeat(40) } },
    { payload: { ...envelope.payload, intent: { ...exampleIntent, summary: 'Delete database' } } },
    { signature: 'A'.repeat(86) + '==' },
    { extra_unsigned_claim: 'owner' },
  ]) assert.equal(await verifyEnvelope({ ...envelope, ...mutation }, publicKey), false);
  assert.equal(await verifyEnvelope(envelope, (await generateKeyPair()).publicKey), false);
  assert.equal(await verifyEnvelope(envelope, {}), false);
});

test('prompt privacy fails closed before publishing', () => {
  assert.equal(IntentInput.safeParse({ ...exampleIntent, prompt: 'private' }).success, false);
  assert.equal(IntentInput.safeParse({ ...exampleIntent, context: { secret: 'private' } }).success, false);
  assert.equal(IntentInput.safeParse({ ...exampleIntent, sharing: 'prompt', prompt: 'approved' }).success, true);
  assert.equal(IntentInput.safeParse({ ...exampleIntent, sharing: 'prompt', context: [] }).success, false);
  assert.equal(IntentInput.safeParse({ ...exampleIntent, sharing: 'context', prompt: 'approved', context: { selected: 'file' } }).success, true);
  assert.throws(() => parseInput(IntentInput, { ...exampleIntent, prompt: 'secret' }), error =>
    error instanceof ProtocolError && error.code === 'invalid_input' && error.status === 400);
});

test('repository paths reject traversal and .git independently of server file policy', () => {
  for (const path of ['../secrets', 'x/../models.py', '/tmp/file', 'C:\\file', 'x\\..\\file',
    '.git/config', 'x/.GIT/config', './models.py', 'x//models.py', 'models.py/', 'bad\0file'])
    assert.equal(SafePath.safeParse(path).success, false, path);
  for (const path of ['models.py', 'src/models.py', 'src/car model.py', '.gitignore', '.env'])
    assert.equal(SafePath.safeParse(path).success, true, path);
  assert.equal(IntentInput.safeParse({ ...exampleIntent, files: ['models.py', 'models.py'] }).success, false);
});

test('declared intent scopes reject wildcard patterns before coordination can evaluate them', () => {
  for (const file of ['**', 'src/**', 'models*.py', 'a*'.repeat(20) + 'b']) {
    assert.equal(SafePath.safeParse(file).success, true); // Generic paths and administrator scope policy remain separate.
    assert.equal(IntentInput.safeParse({ ...exampleIntent, files: [file] }).success, false, file);
    assert.equal(WorkRequest.safeParse({ intent: { ...exampleIntent, files: [file] }, base_commit: 'a'.repeat(40), workspace_id: 'workspace-1' }).success, false);
  }
  assert.equal(IntentInput.safeParse({ ...exampleIntent, files: ['src/models.py', 'src/services.py'] }).success, true);
});

test('checkpoint snapshots represent create, modify and delete explicitly', async () => {
  const before = 'class Car: pass\n';
  const after = 'class Car: id: int\n';
  const checkpoint = {
    intent_id: 'intent-1', intent_revision: 1, path: 'models.py', operation: 'modify',
    base_hash: await hashContent(before), result_hash: await hashContent(after),
    base_content: before, content: after, workspace_id: 'workspace-1', base_commit: 'a'.repeat(40),
  };
  assert.equal(parseInput(CheckpointInput, checkpoint).branch, 'main');
  assert.equal(CheckpointInput.safeParse({ ...checkpoint, operation: 'create', base_hash: null, base_content: null }).success, true);
  assert.equal(CheckpointInput.safeParse({ ...checkpoint, operation: 'delete', result_hash: null, content: null }).success, true);
  assert.equal(CheckpointInput.safeParse({ ...checkpoint, operation: 'delete', base_hash: null, base_content: null, result_hash: null, content: null }).success, true);
  for (const mutation of [
    { operation: 'create' }, { base_hash: null }, { content: null },
    { operation: 'delete' }, { result_hash: null }, { result_hash: 'fake' },
  ]) assert.equal(CheckpointInput.safeParse({ ...checkpoint, ...mutation }).success, false);
  assert.equal(await hashContent(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.notEqual(await hashContent(before), await hashContent(after));
});

test('work and responses separate proposals from signed acceptance', () => {
  const work = parseInput(WorkRequest, { intent: exampleIntent, base_commit: 'a'.repeat(40), workspace_id: 'workspace-1' });
  assert.equal(work.branch, 'main');
  assert.equal(WorkRequest.safeParse({ ...work, branch: '../main' }).success, false);
  for (const base of ['HEAD', '--upload-pack=malicious', 'a'.repeat(39), 'a'.repeat(40) + ':models.py'])
    assert.equal(WorkRequest.safeParse({ ...work, base_commit: base }).success, false);
  assert.equal(RespondInput.safeParse({ action: 'renew', intent_id: 'intent-1' }).success, true);
  assert.equal(RespondInput.safeParse({ action: 'decision', intent_id: 'intent-1', title: 'Car IDs', description: 'Use UUIDs' }).success, true);
  assert.equal(RespondInput.safeParse({ action: 'decision_accept', decision_id: 'decision-1' }).success, true);
  assert.equal(RespondInput.safeParse({ action: 'handoff_offer', intent_id: 'intent-1', checkpoint_id: 'checkpoint-1',
    to_run_id: 'agent-2', remaining_criteria: ['CRUD tests pass'] }).success, true);
  assert.equal(RespondInput.safeParse({ action: 'handoff_accept', handoff_id: 'handoff-1' }).success, true);
  assert.equal(RespondInput.safeParse({ action: 'overlap', intent_id: 'intent-1', peer_intent_id: 'intent-2', peer_revision: 2, mode: 'coedit' }).success, true);
  assert.equal(RespondInput.safeParse({ action: 'decision_accept', title: 'Trust me' }).success, false);
});

test('canonical JSON refuses lossy values and cyclic objects', () => {
  assert.equal(canonicalJson({ z: [true, null, 'hi'], a: 1 }), '{"a":1,"z":[true,null,"hi"]}');
  const cycle = {};
  cycle.self = cycle;
  for (const input of [undefined, NaN, Infinity, { value: undefined }, [undefined], new Array(2),
    1n, new Date(), cycle]) assert.throws(() => canonicalJson(input), ProtocolError);
});
