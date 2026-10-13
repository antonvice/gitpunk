import { z } from 'zod';
import { SafePath, ProtocolError, hashBytes } from '../../shared/index.js';

const MAX_REQUEST_BYTES = 16_384;
const MAX_FILE_BYTES = 1024 * 1024;
const repoName = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
const commitHash = z.string().regex(/^[a-f0-9]{40}$/, 'Use an exact Git SHA-1 commit');
const description = z.string().max(500).optional();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceBranch = z.string().min(1).max(200).refine(value => !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.startsWith('-'));
const Actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name: repoName, description }).strict(),
  z.object({ action: z.literal('import'), name: repoName, source_url: z.string().max(2048), source_branch: sourceBranch.optional(), depth: z.number().int().min(1).max(1000).optional(), description }).strict(),
  z.object({ action: z.literal('fork'), repo: repoName, name: repoName, description }).strict(),
  z.object({ action: z.literal('info'), repo: repoName }).strict(),
  z.object({ action: z.literal('read_commit'), repo: repoName, commit: commitHash }).strict(),
  z.object({ action: z.literal('read_file'), repo: repoName, commit: commitHash, path: SafePath, expected_sha256: digest.optional() }).strict(),
  z.object({ action: z.literal('mint_token'), repo: repoName, scope: z.enum(['read', 'write']), ttl: z.number().int().min(60).max(3600) }).strict(),
  z.object({ action: z.literal('revoke_token'), repo: repoName, token_or_id: z.string().min(1).max(512).refine(value => !/[\s\x00-\x1f\x7f]/.test(value)) }).strict(),
]);

const fail = (code, message, status = 400) => { throw new ProtocolError(code, message, status); };
const response = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const encodeBase64 = bytes => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};

async function authorized(request, env) {
  const secret = env.GITPUNK_INTERNAL_TOKEN;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || /[\s\x00-\x1f\x7f]/.test(secret))
    fail('not_configured', 'Internal server authentication is not configured.', 503);
  const header = request.headers.get('authorization') ?? '';
  const candidate = /^Bearer ([^\s]{1,512})$/.exec(header)?.[1] ?? '';
  const [expected, actual] = await Promise.all([secret, candidate].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
  const a = new Uint8Array(expected), b = new Uint8Array(actual);
  let different = 0;
  for (let index = 0; index < a.length; index++) different |= a[index] ^ b[index];
  if (different) fail('unauthorized', 'Internal server authentication required.', 401);
}

async function readInput(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    fail('invalid_input', 'Use application/json.', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES))
    fail('request_too_large', 'Request exceeds 16 KiB.', 413);
  if (!request.body) fail('invalid_input', 'A JSON action is required.');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) { await reader.cancel(); fail('request_too_large', 'Request exceeds 16 KiB.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { fail('invalid_input', 'A valid UTF-8 JSON action is required.'); }
  const parsed = Actions.safeParse(value);
  if (!parsed.success) fail('invalid_input', 'Invalid Artifacts action.');
  return parsed.data;
}

async function withRepo(artifacts, name, action) {
  const repo = await artifacts.get(name);
  try { return await action(repo); }
  finally { repo[Symbol.dispose](); }
}

function importSource(input, env) {
  let url;
  try { url = new URL(input.source_url); } catch { fail('invalid_source', 'Use an allowed HTTPS Git source.'); }
  const hosts = typeof env.GITPUNK_IMPORT_HOSTS === 'string' ? env.GITPUNK_IMPORT_HOSTS.split(',').map(value => value.trim().toLowerCase()).filter(Boolean) : [];
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443' || !hosts.includes(url.hostname.toLowerCase()) || url.pathname === '/')
    fail('invalid_source', 'Use an allowed HTTPS Git source without credentials or query parameters.');
  return { url: url.href, ...(input.source_branch ? { branch: input.source_branch } : {}), ...(input.depth ? { depth: input.depth } : {}) };
}

function metadata(repo) {
  // Initial provider tokens never reach callers, responses or logs.
  return { id: repo.id, name: repo.name, remote: repo.remote, defaultBranch: repo.defaultBranch };
}

async function finishCreation(artifacts, created) {
  if (typeof created?.token !== 'string' || !created.token) fail('provider_error', 'Provider returned incomplete creation credentials.', 502);
  try {
    if (!await withRepo(artifacts, created.name, repo => repo.revokeToken(created.token))) throw new Error('Not revoked');
  } catch { fail('created_needs_reconciliation', 'Repository created; initial credential cleanup requires reconciliation.', 502); }
  return metadata(created);
}

async function perform(input, env) {
  const artifacts = env.ARTIFACTS;
  if (!artifacts) fail('not_configured', 'Artifacts binding is not configured.', 503);
  if (input.action === 'create') return finishCreation(artifacts, await artifacts.create(input.name, { description: input.description, readOnly: false, setDefaultBranch: 'main' }));
  if (input.action === 'import') return finishCreation(artifacts, await artifacts.import({ source: importSource(input, env), target: { name: input.name, opts: { description: input.description, readOnly: false } } }));
  return withRepo(artifacts, input.repo, async repo => {
    if (input.action === 'info') return metadata(await repo.info());
    if (input.action === 'fork') return finishCreation(artifacts, await repo.fork(input.name, { description: input.description, readOnly: false, defaultBranchOnly: false }));
    if (input.action === 'revoke_token') return { revoked: await repo.revokeToken(input.token_or_id) };
    if (input.action === 'mint_token') {
      const token = await repo.createToken(input.scope, input.ttl);
      return { id: token.id, plaintext: token.plaintext, expiresAt: token.expiresAt, scope: input.scope, ttl: input.ttl };
    }
    if (input.action === 'read_commit') {
      const commit = await repo.readCommit(input.commit);
      if (commit === null) fail('not_found', 'Commit not found.', 404);
      if (commit.hash !== input.commit) fail('provider_error', 'Provider returned a different commit.', 502);
      if (new TextEncoder().encode(JSON.stringify(commit)).byteLength > 262_144) fail('result_too_large', 'Commit metadata exceeds 256 KiB.', 413);
      return { commit: input.commit, metadata: commit };
    }
    const file = await repo.readFile({ ref: input.commit, path: input.path });
    if (file === null) fail('not_found', 'File not found.', 404);
    if (file.size > MAX_FILE_BYTES) fail('result_too_large', 'File exceeds 1 MiB.', 413);
    const bytes = new Uint8Array(await file.arrayBuffer()), sha256 = await hashBytes(bytes);
    if (input.expected_sha256 && input.expected_sha256 !== sha256) fail('content_hash_mismatch', 'File bytes differ from the expected digest.', 409);
    return { commit: input.commit, path: input.path, sha256, content_base64: encodeBase64(bytes), content_type: file.type || 'application/octet-stream' };
  });
}

function publicError(error) {
  if (error instanceof ProtocolError) return response({ error: { code: error.code, message: error.message } }, error.status);
  // Provider exception text may contain credentials or source URLs.
  const codes = {
    NOT_FOUND: ['not_found', 404], ALREADY_EXISTS: ['already_exists', 409],
    CREATE_IN_PROGRESS: ['repository_pending', 409], IMPORT_IN_PROGRESS: ['repository_pending', 409], FORK_IN_PROGRESS: ['repository_pending', 409],
    INVALID_INPUT: ['provider_invalid_input', 422], INVALID_REPO_NAME: ['provider_invalid_input', 422], INVALID_TTL: ['provider_invalid_input', 422], INVALID_URL: ['provider_invalid_input', 422],
  };
  const [code, status] = codes[error?.code] ?? ['provider_error', 502];
  return response({ error: { code, message: 'Artifacts operation could not complete.' } }, status);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'https:' && !(env.TEST_MODE === true && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        fail('https_required', 'HTTPS is required.', 400);
      await authorized(request, env);
      if (request.method !== 'POST' || url.pathname !== '/artifacts' || url.search || url.hash)
        fail('not_found', 'Use POST /artifacts.', 404);
      const input = await readInput(request), enabledUntil = Date.parse(env.GITPUNK_ENABLED_UNTIL ?? '');
      if (input.action !== 'revoke_token' && (!Number.isFinite(enabledUntil) || enabledUntil <= Date.now()))
        fail('cloud_disabled', 'Cloud operations require an unexpired test window.', 503);
      return response(await perform(input, env));
    } catch (error) { return publicError(error); }
  },
};
