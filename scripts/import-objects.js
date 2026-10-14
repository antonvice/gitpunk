import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { storedGit } from '../server/git-store.js';

/** Streaming trusted import; never gather a repository's object bodies in memory. */
export async function importObjects(directory, remote) {
  if ((await storedGit(directory, 'rev-parse', '--show-object-format')).toString().trim() !== 'sha1') throw new Error('Object backend currently supports SHA-1 repositories.');
  const base = (await storedGit(directory, 'rev-parse', 'HEAD')).toString().trim();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const command = args => spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-C', directory, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const revisions = command(['rev-list', '--objects', '--no-object-names', base]), child = command(['cat-file', '--batch']);
  revisions.stdin.end(); revisions.stdout.pipe(child.stdin); child.stdin.on('error', () => {});
  const completed = Promise.all([revisions, child].map(process => new Promise((resolve, reject) => { process.on('error', reject); process.on('exit', code => code === 0 ? resolve() : reject(new Error('Trusted import failed.'))); })));
  completed.catch(() => {});
  const iterator = child.stdout[Symbol.asyncIterator](); let buffer = Buffer.alloc(0), objects = 0, bytes = 0;
  async function fill(size) { while (buffer.length < size) { const next = await iterator.next(); if (next.done) return false; buffer = Buffer.concat([buffer, next.value]); } return true; }
  try {
    while (await fill(1)) {
      let end; while ((end = buffer.indexOf(10)) < 0) if (!await fill(buffer.length + 1) || buffer.length > 128) throw new Error('Invalid Git import header.');
      const [id, type, rawSize] = buffer.subarray(0, end).toString('ascii').split(' '), size = Number(rawSize); buffer = buffer.subarray(end + 1);
      if (!/^[a-f0-9]{40}$/.test(id) || !['blob','tree','commit','tag'].includes(type) || !Number.isSafeInteger(size) || size < 0 || size > 4 * 1024 * 1024 - 64) throw new Error('Import object exceeds the bounded 4 MiB limit.');
      if (!await fill(size + 1) || buffer[size] !== 10) throw new Error('Truncated Git import.');
      const raw = Buffer.concat([Buffer.from(`${type} ${size}\0`), buffer.subarray(0, size)]); buffer = buffer.subarray(size + 1);
      if (createHash('sha1').update(raw).digest('hex') !== id) throw new Error('Git import hash mismatch.');
      await remote.put(id, raw); objects++; bytes += raw.length;
    }
    await completed;
    await remote.cas(null, base, 'trusted-import');
    return { base, objects, bytes };
  } finally { child.kill(); revisions.kill(); }
}
