import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CheckPolicy, SafePath, canonicalJson, hashContent } from '../shared/index.js';

const exec = promisify(execFile);
const docker = (...args) => exec('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000 });
const git = (directory, ...args) => exec('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { encoding: 'buffer', maxBuffer: 65 * 1024 * 1024, timeout: 10_000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });

function boundedLogs(result, limit) {
  let remaining = limit;
  for (const field of ['stdout', 'stderr']) {
    const bytes = Buffer.from(result[field]);
    if (bytes.length > remaining) result.truncated = true;
    // Decode a valid UTF-8 prefix without expanding a cut multibyte character.
    result[field] = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
    remaining -= Buffer.byteLength(result[field]);
  }
  return result;
}

async function exportTree(directory, candidate, destination, limit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate)) throw new Error('Runner requires an exact Git commit ID.');
  if ((await git(directory, 'cat-file', '-t', candidate)).stdout.toString().trim() !== 'commit') throw new Error('Runner candidate is not a commit.');
  const listing = new TextDecoder('utf-8', { fatal: true }).decode((await git(directory, 'ls-tree', '-r', '-z', '--full-tree', candidate)).stdout).split('\0').filter(Boolean);
  if (listing.length > 4096) throw new Error('Runner source exceeds 4096 files.');
  let bytes = 0;
  for (const entry of listing) {
    const [metadata, path] = entry.split('\t');
    const [mode, type, object] = metadata.split(' ');
    SafePath.parse(path);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Runner refuses symlinks/submodules: ${path}`);
    const size = Number((await git(directory, 'cat-file', '-s', object)).stdout.toString().trim());
    if (!Number.isSafeInteger(size) || size < 0 || (bytes += size) > limit) throw new Error('Runner source exceeds configured byte limit.');
    const content = (await git(directory, 'cat-file', 'blob', object)).stdout;
    if (content.length !== size) throw new Error('Runner source blob size changed.');
    const full = join(destination, path);
    await mkdir(dirname(full), { recursive: true, mode: 0o755 });
    await writeFile(full, content, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
  }
  return { files: listing.length, bytes };
}

async function executeContainer(name, image, directory, policy, signal) {
  const args = ['run', '--rm', '--name', name, '--pull=never', '--init', '--user=10001:10001', '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus', String(policy.cpus), '--memory', `${policy.memory_mb}m`, '--memory-swap', `${policy.memory_mb}m`, '--pids-limit', String(policy.pids_limit), '--ulimit', 'nofile=256:256', '--mount', `type=bind,src=${directory},dst=/workspace,readonly`, '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777', '--tmpfs', '/db:rw,noexec,nosuid,nodev,size=64m,mode=1777', '--workdir=/workspace', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PYTHONUNBUFFERED=1', '--env', 'GITPUNK_TEST_DATABASE=/db/test.sqlite', image, ...policy.command];
  return new Promise(resolve => {
    const process = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    let length = 0, truncated = false, timedOut = false, spawnError;
    const collect = stream => chunk => {
      const remaining = Math.max(0, policy.max_output_bytes - length);
      if (chunk.length > remaining) truncated = true;
      if (remaining) { output[stream].push(chunk.subarray(0, remaining)); length += Math.min(chunk.length, remaining); }
    };
    process.stdout.on('data', collect('stdout'));
    process.stderr.on('data', collect('stderr'));
    const stop = async () => { timedOut = true; await docker('rm', '-f', name).catch(() => {}); process.kill('SIGKILL'); };
    const timer = setTimeout(stop, policy.timeout_ms);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) void stop();
    process.once('error', error => { spawnError = error; });
    process.once('close', exit => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ state: timedOut ? 'timed_out' : spawnError || [125, 126, 127].includes(exit) ? 'error' : exit === 0 ? 'passed' : 'failed', exit_code: exit, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: spawnError?.message || Buffer.concat(output.stderr).toString('utf8'), truncated });
    });
  });
}

/** Trusted administrator policy only. No client event can choose commands or mounts. */
export async function runCandidate({ directory, candidate, policy: input, signal }) {
  const policy = CheckPolicy.parse(input);
  const policyHash = await hashContent(canonicalJson(policy));
  const name = `gitpunk-check-${randomUUID()}`;
  const temporary = await mkdtemp(join(tmpdir(), 'gitpunk-check-'));
  const workspace = join(temporary, 'workspace');
  let result = { state: 'error', exit_code: null, stdout: '', stderr: '', truncated: false }, imageId = null, source;
  try {
    const inspected = JSON.parse((await docker('image', 'inspect', policy.image)).stdout)[0];
    if (!inspected?.RepoDigests?.includes(policy.image) || !/^sha256:[a-f0-9]{64}$/.test(inspected.Id)) throw new Error('Pinned image digest is not available locally; pull the exact configured image.');
    imageId = inspected.Id;
    await mkdir(workspace, { mode: 0o755 });
    source = await exportTree(directory, candidate, workspace, policy.max_source_bytes);
    result = await executeContainer(name, policy.image, workspace, policy, signal);
  } catch (error) { result = { ...result, state: 'error', stderr: error.message.slice(0, policy.max_output_bytes) }; }
  finally {
    const failures = [];
    try {
      await docker('rm', '-f', name).catch(async error => {
        if (!/No such container/.test(error.stderr || '')) throw error;
      });
    } catch (error) { failures.push(error.message); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error.message); }
    result.cleanup = failures.length ? 'failed' : 'complete';
    if (failures.length) result = { ...result, state: 'error', stderr: `${result.stderr}\nCleanup failed for ${name}: ${failures.join('; ')}`.slice(0, policy.max_output_bytes) };
  }
  return { ...boundedLogs(result, policy.max_output_bytes), candidate, image_digest: policy.image, image_id: imageId, policy_hash: policyHash, source, container_name: name };
}
