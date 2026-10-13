import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GitUpload, CommitUploadEnvelope, BundleContent, MAX_BUNDLE_BYTES, CommitFile,
  hashBytes, hashContent, generateKeyPair, signEnvelope, verifyEnvelope, RespondInput,
  TargetSnapshot, TargetBundle,
} from './index.js';

const file = {
  path: 'models.py', operation: 'modify', base_hash: 'a'.repeat(64), result_hash: 'b'.repeat(64),
  base_mode: '100644', result_mode: '100755',
};
const payload = {
  intent_id: 'intent-1', intent_revision: 1, branch: 'main', workspace_id: 'workspace-1',
  base_commit: 'a'.repeat(40), commit: 'b'.repeat(40), bundle_hash: 'c'.repeat(64), files: [file],
};

test('signed upload binds detached bundle bytes without broadcasting their content', async () => {
  const keys = await generateKeyPair();
  const bundle = Uint8Array.from([0, 255, 254, 128, 10]);
  const request = GitUpload.parse({ ...payload, bundle_hash: await hashBytes(bundle) });
  const signed = await signEnvelope(request, { runId: 'agent-1', eventId: 'upload-1', privateKey: keys.privateKey });
  const wire = CommitUploadEnvelope.parse({ ...signed, bundle_content: Buffer.from(bundle).toString('base64') });
  const { bundle_content, ...manifest } = wire;
  assert.equal(await verifyEnvelope(manifest, keys.publicKey), true);
  assert.equal(await hashBytes(Buffer.from(bundle_content, 'base64')), manifest.payload.bundle_hash);
  assert.notEqual(await hashBytes(Buffer.from('different bundle')), manifest.payload.bundle_hash);
  assert.equal(JSON.stringify(manifest).includes('bundle_content'), false);
  assert.equal(await verifyEnvelope({ ...manifest, payload: { ...manifest.payload, bundle_hash: '0'.repeat(64) } }, keys.publicKey), false);
});

test('manifest hashes include file operations and executable modes', () => {
  assert.equal(GitUpload.safeParse(payload).success, true);
  assert.equal(CommitFile.safeParse({ ...file, operation: 'create', base_hash: null, base_mode: null }).success, true);
  assert.equal(CommitFile.safeParse({ ...file, operation: 'delete', result_hash: null, result_mode: null }).success, true);
  for (const mutation of [{ operation: 'rename' }, { base_mode: '120000' }, { result_mode: '160000' },
    { result_hash: null }, { base_mode: null }, { path: '../models.py' }])
    assert.equal(CommitFile.safeParse({ ...file, ...mutation }).success, false);
  assert.equal(GitUpload.safeParse({ ...payload, files: [file, file] }).success, false);
  assert.equal(GitUpload.safeParse({ ...payload, files: [], verified: true }).success, false);
  assert.equal(RespondInput.safeParse({ action: 'fetch_commit', commit_id: 'upload-1' }).success, true);
});

test('bundle transport rejects aliases and decoded oversize values', () => {
  for (const value of ['AA==', 'AAA=', 'AAAA']) assert.equal(BundleContent.safeParse(value).success, true);
  for (const value of ['', 'A', 'AA', 'AB==', 'AAB=', ' AA==', 'AA==\n', '_A==', 'AA==='])
    assert.equal(BundleContent.safeParse(value).success, false, value);
  assert.equal(BundleContent.safeParse(Buffer.alloc(MAX_BUNDLE_BYTES).toString('base64')).success, true);
  assert.equal(BundleContent.safeParse(Buffer.alloc(MAX_BUNDLE_BYTES + 1).toString('base64')).success, false);
});

test('byte hashes preserve exact binary data and typed-array view boundaries', async () => {
  const container = Uint8Array.from([7, 0, 255, 254, 10, 9]);
  const view = container.subarray(1, 5);
  assert.equal(await hashBytes(view), await hashBytes(Uint8Array.from([0, 255, 254, 10]).buffer));
  assert.notEqual(await hashBytes(view), await hashBytes(container));
  assert.notEqual(await hashBytes(view), await hashContent(new TextDecoder().decode(view)));
  assert.equal(await hashBytes(new TextEncoder().encode('car\n')), await hashContent('car\n'));
});

test('server target snapshots distinguish original base from bounded canonical bundles', () => {
  const original = { origin: 'server', branch: 'main', base_commit: payload.base_commit, commit: payload.base_commit, bundle_hash: null, files: [] };
  assert.equal(TargetSnapshot.safeParse(original).success, true);
  assert.equal(TargetBundle.safeParse({ ...original, bundle_content: null }).success, true);
  const advanced = { ...original, commit: payload.commit, bundle_hash: payload.bundle_hash, files: [file] };
  assert.equal(TargetBundle.safeParse({ ...advanced, bundle_content: 'AA==' }).success, true);
  for (const input of [{ ...original, files: [file] }, { ...advanced, bundle_hash: null }, { ...original, origin: 'agent' }])
    assert.equal(TargetSnapshot.safeParse(input).success, false);
  assert.equal(TargetBundle.safeParse({ ...original, files: [file], bundle_content: null }).success, false);
  assert.equal(TargetBundle.safeParse({ ...advanced, bundle_content: null }).success, false);
});
