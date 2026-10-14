import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { ProtocolError } from '../shared/index.js';
import { storedGit, gitChanges, buildGitCandidate } from './git-store.js';
import { objectClient, readObjectConfig, parseObject } from './object-client.js';
import { installObjects } from './remote-helper.js';
import { ImmutableCache } from './cache.js';

const fail = (code, message, status = 503) => { throw new ProtocolError(code, message, status); };

/** R2 is authoritative. Each operation uses an isolated, disposable native Git cache. */
export async function createObjectStore({ dataDir, file, db }) {
  file = resolve(file);
  const remoteConfig = await readObjectConfig(file), remote = objectClient(remoteConfig), context = new AsyncLocalStorage();
  if (!await remote.head()) fail('object_repo_missing', 'Import the trusted repository before starting the object backend.');
  db.exec(`CREATE TABLE IF NOT EXISTS git_repos(repo_id TEXT PRIMARY KEY REFERENCES repos(id), base_commit TEXT NOT NULL, branch TEXT NOT NULL, object_format TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS object_refs(ref TEXT PRIMARY KEY, commit_id TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO git_repos VALUES('demo',?,'main','sha1')").run(remoteConfig.base);
  const config = db.prepare("SELECT * FROM git_repos WHERE repo_id='demo'").get();
  if (config.base_commit !== remoteConfig.base || config.object_format !== 'sha1') throw new Error('Object backend does not match the configured repository.');
  db.prepare('INSERT OR IGNORE INTO git_commits VALUES(?,?)').run(config.repo_id, config.base_commit);
  const caches = join(dataDir, 'object-caches'); await mkdir(caches, { recursive: true, mode: 0o700 });
  for (const name of await readdir(caches)) if (name.startsWith('read-')) await rm(join(caches, name), { recursive: true, force: true });
  const stats = { active: 0, peak_active: 0, operations: 0, downloaded_bytes: 0, downloaded_objects: 0, peak_cache_bytes: 0 };
  const cache = new ImmutableCache(32 * 1024 * 1024, 8192);
  const object = id => cache.get(id, async () => { const raw = await remote.get(id); stats.downloaded_bytes += raw.length; stats.downloaded_objects++; return raw; });
  function entries(bytes) {
    const result = []; let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space);
      if (space < offset || end < space || end + 21 > bytes.length) throw new Error('Invalid Git tree.');
      const mode = bytes.subarray(offset, space).toString('ascii').padStart(6, '0'), name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(space + 1, end));
      if (!name || /[\/\x00]/.test(name)) throw new Error('Invalid Git tree name.');
      result.push({ path: name, oid: bytes.subarray(end + 1, end + 21).toString('hex'), mode, type: mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob', size: null }); offset = end + 21;
    }
    return result;
  }
  async function root(id) { const item = parseObject(await object(id), id); const tree = item.bytes.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1]; if (item.type !== 'commit' || !tree) throw new Error('Invalid Git commit.'); return tree; }
  async function tree(id) { const item = parseObject(await object(id), id); if (item.type !== 'tree') throw new Error('Tree required.'); return entries(item.bytes); }
  const directory = () => context.getStore()?.directory ?? fail('cache_required', 'Git operation requires an isolated object cache.');
  async function ensure() {
    const scope = context.getStore(); if (!scope) fail('cache_required', 'Git operation requires a cache scope.');
    scope.ready ??= (async () => {
      scope.directory = await mkdtemp(join(caches, 'read-'));
      await storedGit(scope.directory, 'init', '--bare');
      await writeFile(join(scope.directory, 'config'), `[core]\nrepositoryformatversion = 1\nbare = true\nhooksPath = /dev/null\n[extensions]\npartialClone = origin\n[remote "origin"]\nurl = ${JSON.stringify(`gitpunk::${file}`)}\npromisor = true\npartialclonefilter = blob:none\n`, { mode: 0o600 });
      const head = await remote.head(), raw = await object(head);
      await installObjects(scope.directory, [parseObject(raw, head)]);
      scope.installed = new Set([head]);
      await writeFile(join(scope.directory, 'download.json'), JSON.stringify({ bytes: raw.length, requests: 1, helper_bytes: 0, helper_requests: 0 }), { mode: 0o600 });
      await storedGit(scope.directory, 'update-ref', 'refs/heads/main', head);
    })();
    await scope.ready;
  }
  async function use(action, lazy = false) {
    if (context.getStore()) { if (!lazy) await ensure(); return action(); }
    if (stats.active >= 16) fail('source_busy', 'Object service is busy; retry shortly.', 429);
    stats.active++; stats.peak_active = Math.max(stats.peak_active, stats.active);
    const scope = {};
    try { return await context.run(scope, async () => { if (!lazy) await ensure(); return action(); }); }
    finally {
      try {
        if (scope.directory) {
          const usage = JSON.parse(await readFile(join(scope.directory, 'download.json'), 'utf8').catch(() => '{"bytes":0,"requests":0}'));
          stats.downloaded_bytes += usage.helper_bytes ?? 0; stats.downloaded_objects += usage.helper_requests ?? 0; stats.operations++;
          async function size(dir) { let bytes = 0; for (const entry of await readdir(dir, { withFileTypes: true })) bytes += entry.isDirectory() ? await size(join(dir, entry.name)) : (await stat(join(dir, entry.name))).size; return bytes; }
          stats.peak_cache_bytes = Math.max(stats.peak_cache_bytes, await size(scope.directory));
        }
      } finally { if (scope.directory) await rm(scope.directory, { recursive: true, force: true }); stats.active--; }
    }
  }
  async function persist() {
    let bytes = 0, objects = 0;
    const root = join(directory(), 'objects');
    for (const prefix of (await readdir(root)).filter(value => /^[a-f0-9]{2}$/.test(value))) for (const suffix of await readdir(join(root, prefix))) {
      if (!/^[a-f0-9]{38}$/.test(suffix)) continue;
      const raw = inflateSync(await readFile(join(root, prefix, suffix)), { maxOutputLength: 4 * 1024 * 1024 });
      if ((bytes += raw.length) > 32 * 1024 * 1024 || ++objects > 4096) fail('source_too_large', 'New objects exceed this operation budget.', 413);
      await remote.put(prefix + suffix, raw);
    }
  }
  async function knownBase(base) {
    if (db.prepare('SELECT 1 FROM git_commits WHERE repo_id=? AND commit_id=?').get(config.repo_id, base)) return true;
    const tip = await remote.head(); if (base === tip) return true;
    return use(async () => { try { await hydrateHistory([config.base_commit, base]); await storedGit(directory(), 'merge-base', '--is-ancestor', base, config.base_commit); return true; } catch (error) { if (error instanceof ProtocolError && error.status !== 404) throw error; return false; } });
  }
  async function hydrateHistory(tips) {
    await ensure();
    const seen = new Set(), pending = [...tips], objects = []; let bytes = 0;
    // Native Git lazily fetches trees/blobs, but commit walks require their parent graph.
    // Bound the graph explicitly; never mistake missing parents for a repository root.
    while (pending.length) {
      const id = pending.pop(); if (seen.has(id)) continue; seen.add(id);
      if (seen.size > 4096) fail('history_budget_exhausted', 'This history walk exceeds 4,096 commits; use a path-history index for larger walks.', 413);
      const raw = await object(id), item = parseObject(raw, id);
      if (item.type !== 'commit' || (bytes += raw.length) > 16 * 1024 * 1024) fail('history_budget_exhausted', 'This history graph exceeds the metadata budget.', 413);
      pending.push(...[...item.bytes.toString().split('\n\n')[0].matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1])); objects.push(item);
    }
    await installFresh(objects);
  }
  async function installFresh(objects) {
    const fresh = objects.filter(item => !context.getStore().installed.has(item.oid)); if (!fresh.length) return;
    const bytes = fresh.reduce((total, item) => total + item.bytes.length + Buffer.byteLength(`${item.type} ${item.bytes.length}\0`), 0);
    const file = join(directory(), 'download.json'), usage = JSON.parse(await readFile(file, 'utf8'));
    if (usage.bytes + bytes > 32 * 1024 * 1024 || usage.requests + fresh.length > 4096) fail('source_too_large', 'Git input exceeds the operation object budget.', 413);
    usage.bytes += bytes; usage.requests += fresh.length; await writeFile(file, JSON.stringify(usage), { mode: 0o600 });
    await installObjects(directory(), fresh); for (const item of fresh) context.getStore().installed.add(item.oid);
  }
  async function hydrate(tips, paths, recursive = false) {
    await ensure(); const collected = new Map(); let bytes = 0;
    async function load(id) {
      if (collected.has(id)) return collected.get(id);
      if (collected.size >= 4096) fail('source_too_large', 'Selected Git input exceeds 4,096 objects.', 413);
      const raw = await object(id), item = parseObject(raw, id);
      if ((bytes += raw.length) > 32 * 1024 * 1024) fail('source_too_large', 'Selected Git input exceeds 32 MiB.', 413);
      collected.set(id, item); return item;
    }
    async function walk(id, parts) {
      const item = await load(id); if (item.type !== 'tree') return;
      const children = entries(item.bytes);
      if (!parts.length) { if (recursive) for (const entry of children) await walk(entry.oid, []); return; }
      const child = children.find(entry => entry.path === parts[0]); if (child) await walk(child.oid, parts.slice(1));
    }
    for (const tip of new Set(tips)) {
      await load(tip); const oid = await root(tip); await load(oid);
      for (const path of paths?.length ? paths : recursive ? [''] : []) await walk(oid, path ? path.split('/') : []);
    }
    await installFresh([...collected.values()]);
  }
  const unavailable = () => fail('source_api_required', 'The object backend uses source queries and signed draft commits; legacy bundles use the local/Artifacts backend.');
  return {
    config, distributed: true, get directory() { return directory(); }, use, ensure, persist, knownBase, hydrateHistory, hydrate, root, tree,
    blob: async id => { const item = parseObject(await object(id), id); if (item.type !== 'blob') throw new Error('Blob required.'); return item.bytes; },
    stats: () => ({ ...stats, retained_git_bytes: stats.active ? null : 0, object_cache: cache.stats() }),
    objectSize: id => cache.get(`size:${id}`, () => remote.size(id)),
    history: (base, commit) => use(async () => { await hydrateHistory([base, commit]); return (await storedGit(directory(), 'rev-list', commit, `^${base}`)).toString().trim().split('\n').filter(Boolean); }),
    changes: (base, commit, paths) => use(async () => { await hydrate([base, commit], paths); return gitChanges(directory(), base, commit); }),
    candidateChanges: (target, candidate, paths) => use(async () => { await hydrate([target, candidate], paths); return gitChanges(directory(), target, candidate); }),
    buildCandidate: input => use(async () => { await hydrate([input.base, input.target, input.commit], input.paths); const result = await buildGitCandidate(directory(), input); if (result.candidate) await persist(); return result; }),
    async readRef(ref) {
      if (ref === 'refs/heads/main') return remote.head();
      return db.prepare('SELECT commit_id FROM object_refs WHERE ref=?').get(ref)?.commit_id ?? fail('not_found', 'Ref not found.', 404);
    },
    async recordCreated(commit, { eventId, runId }) {
      const ref = `refs/gitpunk/runs/${runId}/${eventId}`, existing = db.prepare('SELECT commit_id FROM object_refs WHERE ref=?').get(ref);
      if (existing && existing.commit_id !== commit) fail('idempotency_conflict', 'Request already names another commit.', 409);
      db.prepare('INSERT OR IGNORE INTO object_refs VALUES(?,?)').run(ref, commit); return ref;
    },
    async targetSnapshot(withBundle = false) { if (withBundle) unavailable(); return { origin: 'server', branch: 'main', base_commit: config.base_commit, commit: await remote.head() }; },
    compareAndSwap: (target, candidate, operationId) => remote.cas(target, candidate, operationId),
    operationReceipt: id => remote.receipt(id),
    prepare: unavailable, exportCreated: unavailable, readBundle: unavailable,
  };
}
