import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { open, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { objectClient, parseObject, readObjectConfig } from './object-client.js';
import { gitInput } from './git-objects.js';

/** Ordinary Git pack, no deltas. A promisor pack permits unfetched tree/blob/parent IDs. */
export async function installObjects(directory, objects) {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const { type, bytes } of objects) {
    let size = bytes.length, first = ({ commit: 1, tree: 2, blob: 3, tag: 4 }[type] << 4) | (size & 15); size = Math.floor(size / 16);
    const encoded = [first | (size ? 128 : 0)];
    while (size) { const next = size & 127; size = Math.floor(size / 128); encoded.push(next | (size ? 128 : 0)); }
    parts.push(Buffer.from(encoded), deflateSync(bytes));
  }
  const pack = Buffer.concat(parts);
  await gitInput(directory, ['index-pack', '--stdin', '--promisor'], Buffer.concat([pack, createHash('sha1').update(pack).digest()]));
}

export async function remoteHelper() {
  const config = await readObjectConfig(process.argv[3]), remote = objectClient(config), directory = path.resolve(process.env.GIT_DIR);
  // Multiple Git queries can fetch concurrently; one durable per-operation counter bounds them.
  async function reserve(bytes = 0, requests = 0) {
    const lock = path.join(directory, 'download.lock'), file = path.join(directory, 'download.json'); let handle;
    const deadline = Date.now() + 5000;
    while (!handle) { try { handle = await open(lock, 'wx', 0o600); } catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)); } }
    try {
      const usage = JSON.parse(await readFile(file, 'utf8').catch(() => '{"bytes":0,"requests":0}'));
      if ((usage.bytes += bytes) > 32 * 1024 * 1024 || (usage.requests += requests) > 4096) throw new Error('Git operation exceeded its bounded object budget.');
      usage.helper_bytes = (usage.helper_bytes ?? 0) + bytes; usage.helper_requests = (usage.helper_requests ?? 0) + requests;
      await writeFile(file, JSON.stringify(usage), { mode: 0o600 });
    } finally { await handle.close(); await rm(lock, { force: true }); }
  }
  let pending = [];
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'capabilities') process.stdout.write('fetch\noption\n\n');
    else if (line.startsWith('option ')) process.stdout.write(/^option (from-promisor|no-dependents) true$/.test(line) ? 'ok\n' : 'unsupported\n');
    else if (line === 'list') process.stdout.write(`${await remote.head()} refs/heads/main\n\n`);
    else if (line.startsWith('fetch ')) { const id = line.split(' ')[1]; if (!/^[a-f0-9]{40}$/.test(id) || pending.length >= 256) throw new Error('Invalid fetch batch.'); pending.push(id); }
    else if (!line && pending.length) {
      const objects = [];
      for (const id of new Set(pending)) { await reserve(0, 1); const raw = await remote.get(id); await reserve(raw.length); objects.push(parseObject(raw, id)); }
      await installObjects(directory, objects); pending = []; process.stdout.write('\n');
    } else if (line) throw new Error('Unsupported remote helper command.');
  }
}
