import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** Real workerd, SQLite Durable Objects and R2; no cloud calls or credentials. */
export async function localObjects(directory, { requests = 1_000_000, bytes = 1024 * 1024 * 1024 } = {}) {
  const { outputFiles } = await build({ entryPoints: ['server/cloudflare/objects.js'], bundle: true, format: 'esm', write: false, external: ['cloudflare:*'] });
  const token = randomBytes(32).toString('hex');
  const options = convertV4MiniflareOptions({ name: 'gitpunk-objects-local', script: outputFiles[0].text, modules: true, compatibilityDate: '2026-10-13',
    r2Buckets: { OBJECTS: 'gitpunk-objects' }, r2Persist: join(directory, 'r2'), durableObjects: { BRANCHES: { className: 'Branch', useSQLite: true } }, durableObjectsPersist: join(directory, 'do'),
    bindings: { TEST_MODE: true, GITPUNK_INTERNAL_TOKEN: token, GITPUNK_REPO: 'demo', GITPUNK_ENABLED_UNTIL: new Date(Date.now() + 7 * 86400_000).toISOString(), GITPUNK_MAX_REQUESTS: requests, GITPUNK_MAX_WRITE_BYTES: bytes } });
  // Miniflare 5 uses one persistence root; its legacy converter drops old per-service paths.
  options.resourcePersistencePath = directory;
  const runtime = new Miniflare(options);
  try { return { runtime, endpoint: (await runtime.ready).origin, token, repo: 'demo', stop: () => runtime.dispose() }; }
  catch (error) { await runtime.dispose(); throw error; }
}
