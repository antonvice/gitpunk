import { mkdir, open, writeFile, rename, unlink, readdir, lstat, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SafePath } from '../shared/index.js';
import { setTimeout as delay } from 'node:timers/promises';

const hash = (bytes, format) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** A private per-node cache of immutable blobs; every reuse first gets an authorized manifest. */
export class SourceCache {
  constructor(query, directory, maxBytes = 32 * 1024 * 1024) { this.query = query; this.directory = resolve(directory); this.maxBytes = maxBytes; this.hits = 0; this.downloaded = 0; }
  async lock() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('Source cache must be a private owned directory.');
    const file = join(this.directory, 'writer.pid'), deadline = Date.now() + 5000;
    for (;;) {
      try { const handle = await open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); return () => unlink(file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!stat) continue;
      if (!stat.isFile() || stat.size > 16 || stat.mode & 0o077) throw new Error('Invalid cache writer lock.');
      const pid = Number(await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }));
      if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); continue; }
      if (Date.now() > deadline) throw new Error('Source cache is busy; retry.');
      await delay(10);
    }
  }
  async blob(commit, entry, format) {
    const file = join(this.directory, entry.oid);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('Invalid cached blob.');
      if (stat.size !== entry.size) throw new Error('Corrupt cached blob.');
      const bytes = await handle.readFile();
      if (hash(bytes, format) !== entry.oid) throw new Error('Corrupt cached blob.');
      this.hits++; return bytes;
    } catch (error) { if (!['ENOENT'].includes(error.code) && error.message !== 'Corrupt cached blob.') throw error; }
    finally { await handle?.close(); }
    const result = await this.query({ action: 'file', commit, path: entry.path });
    const bytes = Buffer.from(result.content_base64 || '', 'base64');
    if (result.oid !== entry.oid || bytes.length !== entry.size || hash(bytes, format) !== entry.oid) throw new Error('Source response differs from its pinned manifest.');
    if (bytes.length > this.maxBytes) throw new Error('File exceeds source cache budget.');
    const unlock = await this.lock();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const entries = await Promise.all((await readdir(this.directory)).filter(name => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(name)).map(async name => ({ name, stat: await lstat(join(this.directory, name)) })));
      let total = entries.filter(item => item.stat.isFile() && item.name !== entry.oid).reduce((sum, item) => sum + item.stat.size, 0);
      for (const item of entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
        if (total + bytes.length <= this.maxBytes) break;
        if (item.stat.isFile() && item.name !== entry.oid) { await unlink(join(this.directory, item.name)); total -= item.stat.size; }
      }
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file);
    } finally { try { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); } finally { await unlock(); } }
    this.downloaded += bytes.length; return bytes;
  }
  async files(commit, paths) {
    const manifest = await this.query({ action: 'snapshot', commit, paths });
    if (manifest.commit !== commit || !['sha1', 'sha256'].includes(manifest.object_format) || manifest.files.length !== paths.length || manifest.files.some((file, index) => file.path !== paths[index])) throw new Error('Invalid source snapshot manifest.');
    const files = new Map();
    const stat = await lstat(this.directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && (!stat.isDirectory() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())) throw new Error('Source cache must be a private owned directory.');
    // Authorized manifests precede every reuse; the writer lock bounds shared disk use.
    for (const entry of manifest.files) {
      if (!['100644', '100755', null].includes(entry.mode) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 1024 * 1024 || entry.oid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid)) throw new Error('Invalid source file metadata.');
      files.set(entry.path, entry.oid === null ? null : await this.blob(commit, entry, manifest.object_format));
    }
    return files;
  }
  async materialize(commit, paths, directory) {
    const files = await this.files(commit, paths);
    const destination = resolve(directory);
    await mkdir(destination, { recursive: false, mode: 0o700 }); // Never overwrite a checkout or unfinished snapshot.
    try { for (const [path, bytes] of files) {
      SafePath.parse(path);
      if (bytes === null) continue;
      const file = join(destination, path);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    } } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
    return { commit, directory: destination, files: [...files.keys()], bytes: [...files.values()].reduce((sum, bytes) => sum + (bytes?.length || 0), 0), cache_hits: this.hits, downloaded_bytes: this.downloaded, git_checkout: false };
  }
}
