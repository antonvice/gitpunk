import test from 'node:test';
import assert from 'node:assert/strict';
import { boardProfile, draftDiff } from './board-data.js';

test('board profiles cannot redirect credentials or load signing keys', () => {
  const profile = { server: 'http://127.0.0.1:8787', repo: 'demo', branch: 'main', token: 'fixture_token_for_local_board' };
  assert.deepEqual(boardProfile(profile, profile.server), { repo: 'demo', branch: 'main', token: profile.token });
  assert.throws(() => boardProfile({ ...profile, server: 'https://external.example' }, profile.server), /different server/);
  assert.throws(() => boardProfile({ ...profile, privateKey: 'do-not-load' }, profile.server), /board.profile.json/);
  assert.throws(() => boardProfile({ ...profile, repo: '../private' }, profile.server), /invalid/);
});

test('draft viewer distinguishes exact create/delete from an unshared baseline', () => {
  assert.match(draftDiff({ path: 'cars.py', base_content: null, content: 'class Car: pass\n' }), /\+class Car/);
  assert.match(draftDiff({ path: 'cars.py', base_content: 'old\n', content: null }), /-old/);
  assert.match(draftDiff({ path: 'cars.py', content: 'draft\n' }), /Baseline text was not shared/);
});
