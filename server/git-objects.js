import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

export const blobHash = (bytes, format = 'sha1') => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export function gitInput(directory, args, input, maxBuffer = 20 * 1024 * 1024) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { env, encoding: 'buffer', timeout: 30_000, maxBuffer }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
export async function readTree(directory, tree) {
  const bytes = await gitInput(directory, ['ls-tree', '-z', '-l', tree], '');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, type, oid, size] = line.slice(0, tab).trim().split(/\s+/);
    if (tab < 0 || !/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid Git tree entry.');
    return { mode, type, oid, size: size === '-' ? null : Number(size), path: line.slice(tab + 1) };
  });
}

/** One Git process per group of blobs, with exact byte framing and a total bound. */
export async function readBlobs(directory, objects, limit = 16 * 1024 * 1024) {
  const wanted = [...new Set(objects)];
  if (!wanted.length) return new Map();
  if (wanted.some(oid => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw new Error('Exact blob IDs required.');
  const output = await gitInput(directory, ['cat-file', '--batch'], wanted.join('\n') + '\n', limit + wanted.length * 128);
  const blobs = new Map(); let offset = 0, total = 0;
  for (const oid of wanted) {
    const end = output.indexOf(10, offset);
    if (end < 0) throw new Error('Missing Git blob header.');
    const [actual, type, rawSize] = output.subarray(offset, end).toString('ascii').split(' '), size = Number(rawSize);
    if (actual !== oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || (total += size) > limit || end + size + 1 >= output.length || output[end + size + 1] !== 10) throw new Error('Invalid or oversized Git blob.');
    const bytes = output.subarray(end + 1, end + size + 1);
    if (blobHash(bytes, oid.length === 40 ? 'sha1' : 'sha256') !== oid) throw new Error('Git blob content mismatch.');
    blobs.set(oid, bytes); offset = end + size + 2;
  }
  if (offset !== output.length) throw new Error('Unexpected trailing Git object data.');
  return blobs;
}
