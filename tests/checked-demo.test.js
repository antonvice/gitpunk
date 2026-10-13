import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCheckedDemo } from '../scripts/checked-demo.js';

test('real Docker: individual passes, combined failure, canonical-safe repair', { skip: process.env.GITPUNK_DOCKER_TESTS !== '1', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-checked-demo-'));
  try { const result = await runCheckedDemo({ root }); assert.equal(result.integrated, 2); assert.equal(result.failed, 1); }
  finally { await rm(root, { recursive: true, force: true }); }
});
