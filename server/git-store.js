import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename, access, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ProtocolError, canonicalJson, MAX_BUNDLE_BYTES } from '../shared/index.js';
import { readBlobs } from './git-objects.js';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deny = (code, message, status = 400, details) => { throw new ProtocolError(code, message, status, details); };
const gitEnvironment = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', ...extra });
// Fetching bundles never checks out code, runs hooks or reads agent Git config.
export async function storedGit(directory, ...args) {
  const env = gitEnvironment();
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', '-c', 'transfer.fsckObjects=true', '-C', directory, ...args], { encoding: 'buffer', timeout: 30_000, maxBuffer: 20 * 1024 * 1024, env });
  return result.stdout;
}
const text = async (directory, ...args) => (await storedGit(directory, ...args)).toString('utf8').trim();
const exists = async file => { try { await access(file); return true; } catch { return false; } };

export async function createGitStore({ dataDir, source, db }) {
  const directory = path.join(dataDir, 'git', 'demo.git');
  db.exec('CREATE TABLE IF NOT EXISTS git_repos(repo_id TEXT PRIMARY KEY REFERENCES repos(id), base_commit TEXT NOT NULL, branch TEXT NOT NULL, object_format TEXT NOT NULL)');
  let config = db.prepare("SELECT * FROM git_repos WHERE repo_id='demo'").get();
  if (source && !config) {
    source = path.resolve(source);
    const base = await text(source, 'rev-parse', '--verify', 'HEAD^{commit}');
    const format = await text(source, 'rev-parse', '--show-object-format');
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(path.dirname(directory), 'seed-'));
    try {
      await storedGit(temporary, 'init', '--bare', `--object-format=${format}`);
      await storedGit(temporary, 'fetch', '--no-tags', '--no-write-fetch-head', source, `${base}:refs/heads/main`);
      await storedGit(temporary, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      if (await text(temporary, 'rev-parse', 'refs/heads/main') !== base) throw new Error('Initial Git read-back failed.');
      if (await exists(directory)) await rm(temporary, { recursive: true, force: true });
      else await rename(temporary, directory);
      // Lost metadata writes recover the already-created directory by read-back.
      if (await text(directory, 'rev-parse', 'refs/heads/main') !== base) throw new Error('Existing Git store differs from the trusted source.');
      db.prepare('INSERT INTO git_repos(repo_id,base_commit,branch,object_format) VALUES(?,?,?,?)').run('demo', base, 'main', format);
      config = db.prepare("SELECT * FROM git_repos WHERE repo_id='demo'").get();
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (!config) return null;
  if (!(await exists(directory))) throw new Error('Configured Git store is missing.');
  if (source && await text(path.resolve(source), 'rev-parse', 'HEAD^{commit}') !== config.base_commit) throw new Error('The trusted source changed; canonical updates require a future integration operation.');
  const bundles = path.join(dataDir, 'bundles');
  await mkdir(bundles, { recursive: true, mode: 0o700 });
  async function knownBase(base) {
    if (db.prepare('SELECT 1 FROM git_commits WHERE repo_id=? AND commit_id=?').get(config.repo_id, base)) return true;
    try { await storedGit(directory, 'merge-base', '--is-ancestor', base, 'refs/heads/main'); return true; } catch {}
    return false;
  }
  async function changes(repo, base, commit) {
    const raw = await storedGit(repo, 'diff-tree', '--no-commit-id', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev', '--raw', '-r', '-z', base, commit);
    let parts;
    try { parts = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0'); }
    catch { deny('invalid_git_path', 'Git paths must use valid UTF-8.'); }
    const result = [];
    for (let i = 0; i < parts.length - 1; i += 2) {
      const [, oldMode, newMode, oldId, newId, status] = parts[i].match(/^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/) ?? [];
      if (!status || !['A','M','D','T'].includes(status)) deny('unsupported_git_change', 'Unsupported Git change type.');
      const oldPresent = oldMode !== '000000', newPresent = newMode !== '000000';
      if ([oldPresent && oldMode, newPresent && newMode].some(mode => mode && !['100644','100755'].includes(mode))) deny('unsupported_git_mode', 'Symlinks and submodules are not accepted.', 403, { path: parts[i + 1] });
      result.push({ path: parts[i + 1], operation: !oldPresent ? 'create' : !newPresent ? 'delete' : 'modify', oldId: oldPresent ? oldId : null, newId: newPresent ? newId : null, base_mode: oldPresent ? oldMode : null, result_mode: newPresent ? newMode : null });
    }
    const blobs = await readBlobs(repo, result.flatMap(file => [file.oldId, file.newId].filter(Boolean)), 20 * 1024 * 1024);
    return result.map(({ oldId, newId, ...file }) => {
      const baseBytes = oldId ? blobs.get(oldId) : null, resultBytes = newId ? blobs.get(newId) : null;
      return { ...file, base_hash: baseBytes === null ? null : hash(baseBytes), result_hash: resultBytes === null ? null : hash(resultBytes), baseBytes, resultBytes };
    });
  }
  let targetCache, targetTask;
  return {
    directory, config, knownBase,
    history: async (base, commit) => (await text(directory, 'rev-list', commit, `^${base}`)).split('\n').filter(Boolean),
    changes: (base, commit) => changes(directory, base, commit),
    async recordCreated(commit, { eventId, runId }) {
      const ref = `refs/gitpunk/runs/${runId}/${eventId}`;
      const existing = await text(directory, 'rev-parse', '--verify', ref).catch(() => null);
      if (existing && existing !== commit) deny('idempotency_conflict', 'Request already names another commit.', 409);
      if (!existing) await storedGit(directory, 'update-ref', ref, commit, '0'.repeat(config.object_format === 'sha1' ? 40 : 64));
      return ref;
    },
    async exportCreated(id, base, commit) {
      const file = path.join(bundles, `${id}.bundle`);
      if (!await exists(file)) {
        const temporary = await mkdtemp(path.join(dataDir, 'export-'));
        const ref = `refs/gitpunk/exports/${randomUUID()}`;
        try {
          const created = path.join(temporary, 'commit.bundle');
          await storedGit(directory, 'update-ref', ref, commit);
          await storedGit(directory, 'bundle', 'create', created, ref, `^${base}`);
          if ((await lstat(created)).size > MAX_BUNDLE_BYTES) deny('bundle_too_large', 'Use the source API for this commit; its legacy bundle exceeds 4 MiB.', 413);
          await rename(created, file);
        } finally { await storedGit(directory, 'update-ref', '-d', ref, commit).catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
      }
      const bytes = await readFile(file);
      return { bundle_content: bytes.toString('base64'), bundle_hash: hash(bytes) };
    },
    async targetSnapshot(withBundle = false) {
      const commit = await text(directory, 'rev-parse', 'refs/heads/main');
      if (!withBundle) return { origin: 'server', branch: config.branch, base_commit: config.base_commit, commit };
      if (targetCache?.commit !== commit) {
        if (!targetTask || targetTask.commit !== commit) {
          const promise = (async () => {
            const snapshot = { origin: 'server', branch: config.branch, base_commit: config.base_commit, commit, files: [], bundle_hash: null, bundle_content: null };
            if (commit === config.base_commit) return snapshot;
            snapshot.files = (await changes(directory, config.base_commit, commit)).map(({ baseBytes, resultBytes, ...file }) => file).sort((a,b) => a.path.localeCompare(b.path));
            const temporary = await mkdtemp(path.join(dataDir, 'target-'));
            const file = path.join(temporary, 'target.bundle'), ref = `refs/gitpunk/exports/${randomUUID()}`;
            try {
              await storedGit(directory, 'update-ref', ref, commit);
              await storedGit(directory, 'bundle', 'create', file, ref, `^${config.base_commit}`);
              if ((await lstat(file)).size > MAX_BUNDLE_BYTES) deny('target_bundle_too_large', 'Canonical bundle exceeds the local 4 MiB limit.', 413);
              const bytes = await readFile(file);
              snapshot.bundle_hash = hash(bytes); snapshot.bundle_content = bytes.toString('base64');
              return snapshot;
            } finally { await storedGit(directory, 'update-ref', '-d', ref, commit).catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
          })();
          targetTask = { commit, promise };
        }
        const task = targetTask;
        try { targetCache = await task.promise; }
        catch (error) { if (targetTask === task) targetTask = null; throw error; }
      }
      const { bundle_content, ...metadata } = targetCache;
      return withBundle ? { ...metadata, bundle_content } : metadata;
    },
    async buildCandidate({ base, target, commit, operationId, createdAt }) {
      let output;
      try { output = await text(directory, 'merge-tree', '--write-tree', `--merge-base=${base}`, target, commit); }
      catch (error) {
        if (error.code === 1) return { state: 'conflict', details: error.stdout?.toString('utf8').slice(0, 8000) ?? 'Git reported a merge conflict.' };
        throw error;
      }
      const tree = output.split('\n')[0];
      const date = `${Math.floor(createdAt / 1000)} +0000`;
      // Stable parents, metadata and operation ID make crash replay deterministic.
      const env = gitEnvironment({ GIT_AUTHOR_NAME: 'Gitpunk integrator', GIT_AUTHOR_EMAIL: 'integrator@example.invalid', GIT_COMMITTER_NAME: 'Gitpunk integrator', GIT_COMMITTER_EMAIL: 'integrator@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, 'commit-tree', tree, '-p', target, '-p', commit, '-m', `Gitpunk integration ${operationId}`], { encoding: 'utf8', timeout: 30_000, env });
      return { state: 'candidate', candidate: result.stdout.trim(), tree };
    },
    async candidateChanges(target, candidate) { return changes(directory, target, candidate); },
    readRefSync(ref) { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, 'rev-parse', '--verify', ref], { encoding: 'utf8', timeout: 5000, env: gitEnvironment() }).trim(); },
    compareAndSwap(target, candidate) {
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, 'update-ref', 'refs/heads/main', candidate, target], { encoding: 'utf8', timeout: 5000, env: gitEnvironment() });
      const observed = execFileSync('git', ['-C', directory, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8', timeout: 5000, env: gitEnvironment() }).trim();
      if (observed !== candidate) throw new Error('Canonical ref read-back failed.');
      return observed;
    },
    async prepare(input, bundleContent, { eventId, runId, inspect }) {
      if (!(await knownBase(input.base_commit))) deny('unknown_base', 'The base is not in trusted or accepted repository history.', 409);
      const bytes = Buffer.from(bundleContent, 'base64');
      if (hash(bytes) !== input.bundle_hash) deny('bundle_hash_mismatch', 'Bundle bytes do not match the signed hash.');
      const temporary = await mkdtemp(path.join(dataDir, 'quarantine-'));
      const bundlePath = path.join(temporary, 'upload.bundle');
      try {
        await writeFile(bundlePath, bytes, { mode: 0o600 });
        await storedGit(temporary, 'init', '--bare', `--object-format=${config.object_format}`);
        await storedGit(temporary, 'fetch', '--no-tags', '--no-write-fetch-head', directory, `${input.base_commit}:refs/gitpunk/base`);
        try { await storedGit(temporary, 'bundle', 'verify', bundlePath); }
        catch { deny('invalid_bundle', 'Git rejected the bundle or its prerequisites.'); }
        const advertised = (await text(temporary, 'bundle', 'list-heads', bundlePath)).split('\n').filter(Boolean);
        if (advertised.length !== 1 || advertised[0].split(' ')[0] !== input.commit) deny('bundle_commit_mismatch', 'Bundle must advertise only the exact signed commit.');
        try { await storedGit(temporary, 'fetch', '--no-tags', '--no-write-fetch-head', bundlePath, `${input.commit}:refs/gitpunk/candidate`); }
        catch { deny('invalid_bundle', 'Git could not import the exact candidate.'); }
        try { await storedGit(temporary, 'merge-base', '--is-ancestor', input.base_commit, input.commit); }
        catch { deny('base_not_ancestor', 'The signed base must be an ancestor of the candidate.'); }
        const objects = (await text(temporary, 'rev-list', '--objects', input.commit, `^${input.base_commit}`)).split('\n').filter(Boolean).map(line => line.split(' ')[0]);
        const reachable = new Set((await text(temporary, 'rev-list', '--objects', input.commit)).split('\n').filter(Boolean).map(line => line.split(' ')[0]));
        const packed = (await text(temporary, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)')).split('\n').filter(Boolean);
        if (packed.some(object => !reachable.has(object))) deny('extraneous_git_objects', 'The bundle contains objects outside the signed candidate history.');
        let total = 0;
        for (const object of objects) {
          const size = Number(await text(temporary, 'cat-file', '-s', object)); total += size;
          if (size > 1_000_000 || total > 16 * 1024 * 1024 || objects.length > 10_000) deny('git_content_too_large', 'New Git objects exceed prototype limits.', 413);
        }
        const commits = (await text(temporary, 'rev-list', '--reverse', '--topo-order', input.commit, `^${input.base_commit}`)).split('\n').filter(Boolean);
        if (!commits.length) deny('empty_upload', 'Upload must contain new committed changes.');
        if (commits.length > 128) deny('git_history_too_large', 'An upload may contain at most 128 new commits.', 413);
        for (const commit of commits) {
          const metadata = await storedGit(temporary, 'cat-file', 'commit', commit);
          inspect(null, metadata, 'metadata');
          const parents = (await text(temporary, 'rev-list', '--parents', '-n', '1', commit)).split(' ').slice(1);
          if (!parents.length) deny('unrelated_history', 'Candidate history contains an unrelated root commit.');
          for (const parent of parents) for (const change of await changes(temporary, parent, commit)) inspect(change, change.resultBytes, 'change');
        }
        const actual = (await changes(temporary, input.base_commit, input.commit)).map(({ baseBytes, resultBytes, ...file }) => file).sort((a,b) => a.path.localeCompare(b.path));
        const declared = [...input.files].sort((a,b) => a.path.localeCompare(b.path));
        if (canonicalJson(actual) !== canonicalJson(declared)) deny('manifest_mismatch', 'Signed files differ from the actual committed diff.', 409, { actual });
        const ref = `refs/gitpunk/runs/${runId}/${eventId}`;
        const destination = path.join(bundles, `${eventId}.bundle`);
        await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST') throw error; if (hash(await readFile(destination)) !== input.bundle_hash) deny('idempotency_conflict', 'Upload ID already has different bundle bytes.', 409); });
        // No API exposes this ref until the SQLite admission transaction succeeds.
        const existing = await text(directory, 'rev-parse', '--verify', ref).catch(() => null);
        if (existing && existing !== input.commit) deny('idempotency_conflict', 'Immutable upload ref already names different code.', 409);
        await storedGit(directory, 'fetch', '--no-tags', '--no-write-fetch-head', temporary, `${input.commit}:${ref}`);
        if (await text(directory, 'rev-parse', ref) !== input.commit) throw new Error('Uploaded ref read-back failed.');
        return { ref, bundle_path: destination, files: actual, commits: commits.length, commit_ids: commits };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    },
    async readBundle(id) { return (await readFile(path.join(bundles, `${id}.bundle`))).toString('base64'); },
    async readRef(ref) { return text(directory, 'rev-parse', '--verify', ref); },
  };
}
