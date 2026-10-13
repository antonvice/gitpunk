import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckPolicy, CheckResult, RespondInput, WorkRequest, GitUpload,
  canonicalJson, hashContent, signEnvelope, verifyEnvelope, generateKeyPair, exampleIntent } from './index.js';

const image = `python@sha256:${'a'.repeat(64)}`;
const target = 'b'.repeat(40), candidate = 'c'.repeat(40), policy_hash = 'd'.repeat(64);

test('administrator check policy is digest-pinned and normalized to manual approval', async () => {
  const short = CheckPolicy.parse({ image, command: ['python', '-m', 'unittest'] });
  assert.equal(short.approval, 'manual');
  assert.equal(short.timeout_ms, 30_000);
  assert.equal(short.max_source_bytes, 16 * 1024 * 1024);
  assert.equal(await hashContent(canonicalJson(short)), await hashContent(canonicalJson(CheckPolicy.parse(short))));
  for (const mutation of [
    { image: 'python:latest' }, { command: [] }, { command: [''] }, { command: ['python\0malicious'] },
    { timeout_ms: 0 }, { cpus: -1 }, { max_source_bytes: Infinity },
    { network: 'host' }, { mounts: ['/Users:/host'] },
  ]) assert.equal(CheckPolicy.safeParse({ image, command: ['python', '-m', 'unittest'], ...mutation }).success, false);
  assert.equal(CheckPolicy.parse({ image, command: ['python'], approval: 'automatic' }).approval, 'automatic');
});

test('signed approval binds exact check, target, candidate and policy', async () => {
  const input = { action: 'approve', submission_id: 'submission-1', check_id: 'check-1', candidate, target, policy_hash };
  assert.deepEqual(RespondInput.parse(input), input);
  const keys = await generateKeyPair();
  const signed = await signEnvelope(input, { runId: 'maintainer-1', privateKey: keys.privateKey });
  assert.equal(await verifyEnvelope(signed, keys.publicKey), true);
  for (const mutation of [{ check_id: 'check-2' }, { target: 'e'.repeat(40) },
    { candidate: 'e'.repeat(40) }, { policy_hash: 'e'.repeat(64) }])
    assert.equal(await verifyEnvelope({ ...signed, payload: { ...input, ...mutation } }, keys.publicKey), false);
  assert.equal(RespondInput.safeParse({ ...input, policy: { approval: 'automatic' } }).success, false);
  assert.equal(RespondInput.safeParse({ action: 'approve', submission_id: 'submission-1' }).success, false);
});

test('check outcomes and agent commands cannot redefine configured checks', () => {
  const result = { target, candidate, policy_hash, image_digest: image, state: 'passed', exit_code: 0, cleanup: 'complete' };
  assert.equal(CheckResult.safeParse(result).success, true);
  assert.equal(CheckResult.safeParse({ ...result, target: 'main' }).success, false);
  assert.equal(CheckResult.safeParse({ ...result, image_digest: 'python:latest' }).success, false);
  assert.equal(CheckResult.safeParse({ ...result, state: 'integrated' }).success, false);
  assert.equal(CheckResult.safeParse({ ...result, administrator_override: true }).success, false);
  assert.equal(WorkRequest.safeParse({ intent: exampleIntent, base_commit: target, workspace_id: 'workspace-1',
    check_policy: { image, command: ['true'] } }).success, false);
  assert.equal(GitUpload.safeParse({ check_policy: { image, command: ['true'] } }).success, false);
  assert.equal(RespondInput.safeParse({ action: 'retry_check', submission_id: 'submission-1', command: ['true'] }).success, false);
});
