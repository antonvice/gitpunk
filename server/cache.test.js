import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImmutableCache } from './cache.js';
import { SourceCache } from '../client/source.js';
import { blobHash } from './git-objects.js';

test('immutable cache coalesces misses, stays bounded and retries failed loads', async () => {
  const cache = new ImmutableCache(32, 2); let loads = 0;
  const load = async () => { loads++; await new Promise(resolve => setTimeout(resolve, 10)); return Buffer.alloc(16); };
  await Promise.all(Array.from({ length: 8 }, () => cache.get('one', load)));
  assert.equal(loads, 1); assert.equal(cache.stats().hits, 7);
  for (const key of ['two', 'three', 'four']) await cache.get(key, load);
  assert.equal(cache.stats().bytes, 32); assert.equal(cache.stats().entries, 2);
  await assert.rejects(cache.get('error', () => { throw new Error('retry'); }));
  assert.equal(await cache.get('error', () => 'recovered'), 'recovered');
  assert.equal(cache.stats().pending, 0);
});

test('shared node cache bounds concurrent writers, verifies content and authorizes every reuse', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'cache'), commit = 'a'.repeat(40);
  const contents = ['a', 'b', 'c'].map(value => Buffer.from(value.repeat(16)));
  let manifests = 0, downloads = 0, authorized = true;
  const query = async input => {
    if (!authorized) throw new Error('revoked');
    const bytes = contents[Number(input.path || input.paths[0])];
    if (input.action === 'snapshot') { manifests++; return { commit, object_format: 'sha1', files: [{ path: input.paths[0], oid: blobHash(bytes), size: bytes.length, mode: '100644' }] }; }
    downloads++; return { oid: blobHash(bytes), content_base64: bytes.toString('base64') };
  };
  const clients = contents.map(() => new SourceCache(query, directory, 32));
  await Promise.all(clients.map((cache, index) => cache.files(commit, [String(index)])));
  const files = await readdir(directory);
  assert.equal((await Promise.all(files.map(name => stat(join(directory, name))))).reduce((sum, value) => sum + value.size, 0), 32);
  const oid = files[0], index = contents.findIndex(bytes => blobHash(bytes) === oid);
  await clients[0].files(commit, [String(index)]);
  assert.equal(downloads, 3); assert.equal(manifests, 4);
  await writeFile(join(directory, oid), 'corruption');
  await clients[0].files(commit, [String(index)]);
  assert.deepEqual(await readFile(join(directory, oid)), contents[index]);
  authorized = false;
  await assert.rejects(clients[0].files(commit, [String(index)]), /revoked/);
});

test('node cache refuses symlink roots and file response substitutions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-cache-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('safe'), commit = 'a'.repeat(40);
  const query = async input => input.action === 'snapshot' ? { commit, object_format: 'sha1', files: [{ path: 'file', oid: blobHash(bytes), size: 4, mode: '100644' }] } : { oid: blobHash(bytes), content_base64: Buffer.from('evil').toString('base64') };
  await symlink(root, join(root, 'link'));
  await assert.rejects(new SourceCache(query, join(root, 'link')).files(commit, ['file']), /private owned/);
  await assert.rejects(new SourceCache(query, join(root, 'cache')).files(commit, ['file']), /pinned manifest/);
});
