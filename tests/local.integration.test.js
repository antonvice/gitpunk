import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo } from '../scripts/demo.js';

test('two real Git workspaces coordinate drafts, decisions, handoff and restart over HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-integration-'));
  try {
    const receipt = await runDemo({ root });
    assert.ok(receipt.accepted_events >= 10);
    assert.ok(receipt.signed_checkpoints >= 3);
    assert.equal(receipt.verification, 'checks not configured in this demo; uploads remain unverified');
  } finally { await rm(root, { recursive: true, force: true }); }
});
