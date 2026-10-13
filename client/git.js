import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, writeFile, readFile, unlink, realpath, open, rename, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, relative, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashBytes, MAX_BUNDLE_BYTES, canonicalJson } from '../shared/index.js';

const exec = promisify(execFile);
export async function git(workspace, ...args) { return (await exec('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })).stdout.trimEnd(); }
const managedGit = (workspace, ...args) => git(workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args);
export async function head(workspace) { return git(workspace, 'rev-parse', 'HEAD'); }
const gitBytes = async (workspace, ...args) => (await exec('git', ['-C', workspace, ...args], { encoding: 'buffer', maxBuffer: MAX_BUNDLE_BYTES })).stdout;
const exactCommit = commit => { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Expected an exact Git commit ID.'); return commit; };
export async function committedFiles(workspace, base, commit) {
  exactCommit(base); exactCommit(commit);
  await git(workspace, 'merge-base', '--is-ancestor', base, commit);
  const fields = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await gitBytes(workspace, 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, commit)).split('\0');
  const files = [];
  for (let i = 0; fields[i]; i += 2) {
    const [baseMode, resultMode, baseObject, resultObject] = fields[i].slice(1).split(' ');
    const allowed = ['000000', '100644', '100755'];
    if (!allowed.includes(baseMode) || !allowed.includes(resultMode)) throw new Error(`Symlinks, submodules and nonregular committed files are unsupported: ${fields[i + 1]}`);
    const baseHash = baseMode === '000000' ? null : await hashBytes(await gitBytes(workspace, 'cat-file', 'blob', baseObject));
    const resultHash = resultMode === '000000' ? null : await hashBytes(await gitBytes(workspace, 'cat-file', 'blob', resultObject));
    files.push({ path: fields[i + 1], operation: baseMode === '000000' ? 'create' : resultMode === '000000' ? 'delete' : 'modify', base_hash: baseHash, result_hash: resultHash, base_mode: baseMode === '000000' ? null : baseMode, result_mode: resultMode === '000000' ? null : resultMode });
  }
  return files;
}
export async function exportCommitBundle(workspace, base, commit) {
  exactCommit(base); exactCommit(commit);
  const directory = await mkdtemp(join(tmpdir(), 'gitpunk-export-'));
  const path = join(directory, 'commit.bundle');
  const ref = `refs/gitpunk/exports/${randomUUID()}`;
  try {
    // A named Git ref advertises the immutable commit; HEAD may change concurrently.
    await managedGit(workspace, 'update-ref', ref, commit);
    await managedGit(workspace, 'bundle', 'create', path, ref, `^${base}`);
    const stat = await lstat(path);
    if (stat.size > MAX_BUNDLE_BYTES) throw new Error(`Commit bundle exceeds ${MAX_BUNDLE_BYTES} bytes; reduce submission size.`);
    const content = await readFile(path);
    return { bundle_content: content.toString('base64'), bundle_hash: await hashBytes(content) };
  } finally { await managedGit(workspace, 'update-ref', '-d', ref, commit).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
export async function fetchCommitBundle(workspace, bundleContent, commit, id, manifest, destination) {
  exactCommit(commit);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid uploaded commit ID.');
  const ref = destination || `refs/gitpunk/peers/${id}`;
  if (!ref.startsWith('refs/gitpunk/')) throw new Error('Fetch destination must be a private Gitpunk ref.');
  await managedGit(workspace, 'check-ref-format', ref);
  const directory = await mkdtemp(join(tmpdir(), 'gitpunk-fetch-'));
  const path = join(directory, 'commit.bundle');
  const staging = `refs/gitpunk/fetching/${randomUUID()}`;
  try {
    await writeFile(path, bundleContent, { mode: 0o600 });
    await git(workspace, 'bundle', 'verify', path);
    const heads = (await git(workspace, 'bundle', 'list-heads', path)).split('\n');
    if (heads.length !== 1 || heads[0].split(' ')[0] !== commit) throw new Error('Bundle does not advertise exactly its signed commit.');
    await managedGit(workspace, 'fetch', '--no-tags', '--no-write-fetch-head', path, `${commit}:${staging}`);
    if (await git(workspace, 'rev-parse', staging) !== commit || await git(workspace, 'cat-file', '-t', commit) !== 'commit') throw new Error('Fetched object did not match its signed commit.');
    const ordered = files => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (manifest && canonicalJson(ordered(await committedFiles(workspace, manifest.base_commit, commit))) !== canonicalJson(ordered(manifest.files))) throw new Error('Fetched commit files differ from their authenticated manifest.');
    await managedGit(workspace, 'update-ref', ref, commit);
    return ref;
  } finally { await managedGit(workspace, 'update-ref', '-d', staging, commit).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
export async function pinTargetCommit(workspace, branch, commit) {
  exactCommit(commit);
  const ref = `refs/gitpunk/targets/${branch}`;
  await managedGit(workspace, 'check-ref-format', ref);
  if (await git(workspace, 'cat-file', '-t', commit) !== 'commit') throw new Error('Canonical target is not an available commit.');
  await managedGit(workspace, 'update-ref', ref, commit);
  return ref;
}
export async function atCommit(workspace, commit, path) {
  try { return (await exec('git', ['-C', workspace, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 })).stdout; }
  catch (error) { if (/does not exist|exists on disk, but not in/.test(error.stderr || '')) return null; throw error; }
}
export async function safePath(workspace, path) {
  const root = await realpath(workspace);
  const full = resolve(root, path);
  if (relative(root, full).startsWith('..') || full === root || path.split(/[\\/]/).includes('.git')) throw new Error(`Unsafe source path: ${path}`);
  let current = root;
  for (const segment of relative(root, full).split('/')) {
    current = resolve(current, segment);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink source path: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}
export async function snapshot(workspace, path, maxBytes = 256 * 1024) {
  const full = await safePath(workspace, path);
  try {
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > maxBytes) throw new Error(`Only text files up to ${maxBytes} bytes can be published: ${path}`);
      const bytes = await file.readFile();
      const after = await file.stat();
      if (bytes.length > maxBytes || before.mtimeMs !== after.mtimeMs || before.size !== after.size) return { unstable: true };
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes('\0')) throw new Error(`Binary drafts are not supported yet: ${path}`);
      return { content };
    } finally { await file.close(); }
  } catch (error) { if (error.code === 'ENOENT') return { content: null }; throw error; }
}
export async function restoreCheckpoints(workspace, checkpoints, branchName) {
  if (!checkpoints.length || new Set(checkpoints.map(item => item.base_commit)).size !== 1) throw new Error('Handoff requires checkpoints with one common base commit.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(checkpoints[0].base_commit)) throw new Error('Handoff base must be an exact Git commit ID.');
  const dirty = await git(workspace, 'status', '--porcelain', '--untracked-files=all');
  if (dirty) throw new Error('Handoff import requires a clean workspace; commit or stash local changes first.');
  await git(workspace, 'cat-file', '-e', `${checkpoints[0].base_commit}^{commit}`);
  for (const checkpoint of checkpoints) await safePath(workspace, checkpoint.path);
  const previous = await git(workspace, 'symbolic-ref', '--short', 'HEAD');
  const staged = [], originals = new Map(), applied = [];
  await managedGit(workspace, 'switch', '-c', branchName, checkpoints[0].base_commit);
  try {
    // Recheck after switching: the base tree may introduce a symlink parent.
    for (const checkpoint of checkpoints) await safePath(workspace, checkpoint.path);
    for (const checkpoint of checkpoints) {
      const full = await safePath(workspace, checkpoint.path);
      let original = null;
      try {
        const stat = await lstat(full);
        if (!stat.isFile()) throw new Error(`Handoff path is not a regular file: ${checkpoint.path}`);
        original = { mode: stat.mode };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      originals.set(checkpoint.path, original);
      if (checkpoint.content !== null) {
        await mkdir(dirname(full), { recursive: true });
        const temporary = `${full}.gitpunk-${randomUUID()}`;
        staged.push({ checkpoint, full, temporary });
        await writeFile(temporary, checkpoint.content, { flag: 'wx', mode: original?.mode || 0o644 });
      } else staged.push({ checkpoint, full, temporary: null });
    }
    // All files are prepared before any source file is replaced.
    for (const item of staged) {
      await safePath(workspace, item.checkpoint.path);
      if (item.temporary) await rename(item.temporary, item.full);
      else await unlink(item.full).catch(error => { if (error.code !== 'ENOENT') throw error; });
      applied.push(item);
    }
  } catch (error) {
    try {
      for (const item of staged) if (item.temporary) await unlink(item.temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
      const tracked = applied.filter(item => originals.get(item.checkpoint.path)).map(item => item.checkpoint.path);
      for (const item of applied) if (!originals.get(item.checkpoint.path)) await unlink(item.full).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
      if (tracked.length) await managedGit(workspace, 'restore', '--source', checkpoints[0].base_commit, '--worktree', '--', ...tracked);
      await managedGit(workspace, 'switch', previous);
    } catch { throw new Error(`Handoff failed and rollback could not finish; inspect ${branchName}. Original error: ${error.message}`); }
    throw error;
  }
  return branchName;
}
