import { DurableObject } from 'cloudflare:workers';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = (status, code) => { throw Object.assign(new Error(code), { status }); };
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const MAX_OBJECT = 4 * 1024 * 1024;

/** One serialized head and bounded test budget per repository. Objects live in R2. */
export class Branch extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS head(id INTEGER PRIMARY KEY CHECK(id=1), commit_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, expected TEXT, candidate TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget(window TEXT PRIMARY KEY, requests INTEGER NOT NULL, bytes INTEGER NOT NULL);`);
  }
  reserve(window, maxRequests, maxBytes, bytes) {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT OR IGNORE INTO budget VALUES(?,0,0)', window);
      const row = this.sql.exec('SELECT * FROM budget WHERE window=?', window).one();
      if (row.requests >= maxRequests || row.bytes + bytes > maxBytes) return false;
      this.sql.exec('UPDATE budget SET requests=requests+1,bytes=bytes+? WHERE window=?', bytes, window);
      return true;
    });
  }
  head() { return this.sql.exec('SELECT commit_id FROM head WHERE id=1').toArray()[0]?.commit_id ?? null; }
  receipt(id) { return this.sql.exec('SELECT * FROM receipts WHERE id=?', id).toArray()[0] ?? null; }
  compareAndSwap(input) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.receipt(input.id);
      if (previous) return { state: previous.expected === input.expected && previous.candidate === input.candidate ? 'applied' : 'id_conflict', head: this.head(), receipt: previous };
      if (this.head() !== input.expected) return { state: 'stale', head: this.head() };
      this.sql.exec('INSERT OR REPLACE INTO head VALUES(1,?)', input.candidate);
      this.sql.exec('INSERT INTO receipts VALUES(?,?,?)', input.id, input.expected, input.candidate);
      return { state: 'applied', head: input.candidate, receipt: this.receipt(input.id) };
    });
  }
  usage(window) { return this.sql.exec('SELECT requests,bytes FROM budget WHERE window=?', window).toArray()[0] ?? { requests: 0, bytes: 0 }; }
}

async function body(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) fail(413, 'too_large');
  const chunks = []; let size = 0;
  for await (const chunk of request.body ?? []) { if ((size += chunk.length) > limit) fail(413, 'too_large'); chunks.push(chunk); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function auth(request, env) {
  if (!env.GITPUNK_INTERNAL_TOKEN || env.GITPUNK_INTERNAL_TOKEN.length < 32) fail(503, 'not_configured');
  const hashes = await Promise.all([env.GITPUNK_INTERNAL_TOKEN, request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? ''].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
  const a = new Uint8Array(hashes[0]), b = new Uint8Array(hashes[1]); let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  if (mismatch) fail(401, 'unauthorized');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const local = env.TEST_MODE === true && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !local) fail(400, 'https_required');
      await auth(request, env);
      const match = /^\/v1\/repos\/([a-z0-9_-]{1,64})\/(objects\/([a-f0-9]{40})|head|receipts\/([a-zA-Z0-9_-]{1,160})|usage)$/.exec(url.pathname);
      if (!match || url.search || match[1] !== env.GITPUNK_REPO) fail(404, 'not_found');
      const until = Date.parse(env.GITPUNK_ENABLED_UNTIL ?? '');
      if (!Number.isFinite(until) || until <= Date.now() || !local && until > Date.now() + 3600_000) fail(503, 'cloud_disabled');
      const branch = env.BRANCHES.getByName(match[1]), route = match[2], id = match[3];
      if (!['GET','HEAD','POST','PUT'].includes(request.method)) fail(405, 'method_not_allowed');
      const input = request.method === 'PUT' || request.method === 'POST' ? await body(request, request.method === 'PUT' ? MAX_OBJECT + 4096 : 1024) : null;
      if (!await branch.reserve(env.GITPUNK_ENABLED_UNTIL, Number(env.GITPUNK_MAX_REQUESTS) || 0, Number(env.GITPUNK_MAX_WRITE_BYTES) || 0, input?.length ?? 0)) fail(429, 'test_budget_exhausted');
      if (route === 'usage' && request.method === 'GET') return json(await branch.usage(env.GITPUNK_ENABLED_UNTIL));
      if (route.startsWith('receipts/') && request.method === 'GET') return json(await branch.receipt(match[4]));
      if (route === 'head' && request.method === 'GET') return json({ head: await branch.head() });
      if (route === 'head' && request.method === 'POST') {
        let value; try { value = JSON.parse(new TextDecoder().decode(input)); } catch { fail(400, 'invalid_cas'); }
        if (!value || Object.keys(value).sort().join(',') !== 'candidate,expected,id' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.id) || !oid(value.candidate) || value.expected !== null && !oid(value.expected)) fail(400, 'invalid_cas');
        if ((await env.OBJECTS.head(`${match[1]}/${value.candidate}`))?.customMetadata?.type !== 'commit') fail(409, 'commit_missing');
        const result = await branch.compareAndSwap(value);
        return json(result, result.state === 'applied' ? 200 : 409);
      }
      if (id) {
        const key = `${match[1]}/${id}`;
        if (request.method === 'PUT') {
          let raw;
          try { raw = await body({ headers: new Headers(), body: new Response(input).body.pipeThrough(new DecompressionStream('deflate')) }, MAX_OBJECT); }
          catch (error) { if (error.status) throw error; fail(400, 'invalid_compression'); }
          const end = raw.indexOf(0), header = new TextDecoder().decode(raw.subarray(0, end));
          const parsed = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(header);
          if (!parsed || end < 0 || Number(parsed[2]) !== raw.length - end - 1) fail(400, 'invalid_git_object');
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', raw)), byte => byte.toString(16).padStart(2, '0')).join('');
          if (digest !== id) fail(409, 'object_hash_mismatch');
          const object = await env.OBJECTS.put(key, input, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { type: parsed[1], size: parsed[2] } });
          return json({ oid: id, created: object !== null });
        }
        if (request.method === 'GET' || request.method === 'HEAD') {
          const object = await env.OBJECTS[request.method === 'HEAD' ? 'head' : 'get'](key);
          if (!object) fail(404, 'object_missing');
          return new Response(request.method === 'HEAD' ? null : object.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(object.size), 'x-gitpunk-type': object.customMetadata.type, 'x-gitpunk-size': object.customMetadata.size, 'cache-control': 'private, max-age=31536000, immutable' } });
        }
      }
      fail(405, 'method_not_allowed');
    } catch (error) { return json({ error: error.status ? error.message : 'storage_unavailable' }, error.status ?? 503); }
  },
};
