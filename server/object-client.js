import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ProtocolError } from '../shared/index.js';

export async function readObjectConfig(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('Object configuration must be owner-only.');
    const value = JSON.parse(await handle.readFile('utf8')), url = new URL(value.endpoint);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !/^[a-z0-9_-]{1,64}$/.test(value.repo) || !/^[a-f0-9]{40}$/.test(value.base) || typeof value.token !== 'string' || !/^[^\s]{32,512}$/.test(value.token)) throw new Error('Invalid object configuration.');
    return value;
  } finally { await handle.close(); }
}

export function parseObject(raw, oid) {
  if (createHash('sha1').update(raw).digest('hex') !== oid) throw new Error('Git object hash mismatch.');
  const end = raw.indexOf(0), match = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(raw.subarray(0, end).toString('ascii'));
  if (!match || end < 0 || Number(match[2]) !== raw.length - end - 1) throw new Error('Invalid Git object.');
  return { oid, type: match[1], bytes: raw.subarray(end + 1) };
}

export function objectClient(config) {
  async function request(route, method = 'GET', body) {
    const response = await fetch(`${config.endpoint.replace(/\/$/, '')}/v1/repos/${config.repo}/${route}`, { method, body, headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new ProtocolError(response.status === 409 ? 'stale_target' : 'object_service_unavailable', 'Object service rejected the request; no credentials are included in this error.', response.status); }
    return response;
  }
  return {
    request,
    head: async () => (await (await request('head')).json()).head,
    receipt: async id => (await request(`receipts/${id}`)).json(),
    cas: async (expected, candidate, id) => (await request('head', 'POST', JSON.stringify({ expected, candidate, id }))).json(),
    put: async (id, raw) => { parseObject(raw, id); return (await request(`objects/${id}`, 'PUT', deflateSync(raw))).json(); },
    async get(id, reserveBytes = () => {}) {
      if (!/^[a-f0-9]{40}$/.test(id)) throw new Error('Exact Git object ID required.');
      const response = await request(`objects/${id}`), length = Number(response.headers.get('content-length'));
      try {
        if (!Number.isSafeInteger(length) || length < 7 || length > 4 * 1024 * 1024 + 4096) throw new Error('Invalid object size.');
        await reserveBytes(length);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { if ((size += chunk.length) > length) throw new Error('Oversized object response.'); chunks.push(chunk); }
        const compressed = Buffer.concat(chunks);
        if (compressed.length !== length) throw new Error('Truncated object response.');
        const raw = inflateSync(compressed, { maxOutputLength: 4 * 1024 * 1024 });
        parseObject(raw, id); return raw;
      } finally { await response.body?.cancel().catch(() => {}); }
    },
    async size(id) { const response = await request(`objects/${id}`, 'HEAD'); return Number(response.headers.get('x-gitpunk-size')); },
  };
}
