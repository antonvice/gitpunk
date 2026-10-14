import { z } from 'zod';

export class ProtocolError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'Use an exact Git commit hash');
const text = z.string().trim().min(1).max(4000);
const pinnedImage = z.string().max(300).regex(/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/, 'Pin the Docker image by repository and sha256 digest');
const branch = z.string().min(1).max(200).refine(value =>
  !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') &&
  !value.includes('//') && !value.includes('@{') && value !== '@' &&
  !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
  value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')),
  'Invalid target branch');

export const SafePath = z.string().min(1).max(500).refine(value =>
  !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') &&
  value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'),
  'Use a repository-relative path without traversal or .git');

const concretePath = SafePath.refine(value => !/[*?\[\]]/.test(value), 'Use a concrete path');
const paths = z.array(concretePath).min(1).max(128).refine(value => new Set(value).size === value.length, 'Duplicate paths');
export const SourceQuery = z.discriminatedUnion('action', [
  z.object({ action: z.literal('file'), commit, path: concretePath }).strict(),
  z.object({ action: z.literal('snapshot'), commit, paths }).strict(),
  z.object({ action: z.literal('tree'), commit, path: concretePath.optional(), after: z.string().max(500).default(''), limit: z.number().int().min(1).max(256).default(128) }).strict(),
  z.object({ action: z.literal('diff'), base: commit, commit, paths }).strict(),
  z.object({ action: z.literal('compare'), base: commit, commit }).strict(),
  z.object({ action: z.literal('history'), commit, path: concretePath, limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ action: z.literal('blame'), commit, path: concretePath, start: z.number().int().min(1).default(1), end: z.number().int().min(1).max(100_000).default(100) }).strict(),
]);

export const ServerCommit = z.object({
  action: z.literal('commit'), intent_id: id, intent_revision: revision,
  base_commit: commit, branch: branch.default('main'), workspace_id: id,
  checkpoint_ids: z.array(id).min(1).max(128).refine(value => new Set(value).size === value.length, 'Duplicate checkpoints'),
  message: z.string().trim().min(1).max(4000),
}).strict();

export const IntentInput = z.object({
  title: z.string().trim().min(1).max(160),
  type: z.enum(['feature', 'change', 'bugfix', 'refactor', 'docs', 'test', 'maintenance']),
  summary: text,
  files: z.array(SafePath.refine(file => !file.includes('*'), 'Declare concrete file paths')).min(1).max(128).refine(files => new Set(files).size === files.length, 'Duplicate file scope'),
  done_when: z.array(text).min(1).max(32),
  sharing: z.enum(['summary', 'prompt', 'context']).default('summary'),
  prompt: z.string().max(100_000).optional(),
  context: z.json().optional(),
}).strict().superRefine((intent, ctx) => {
  if (intent.sharing === 'summary' && intent.prompt !== undefined)
    ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'Summary sharing excludes raw prompts' });
  if (intent.sharing !== 'context' && intent.context !== undefined)
    ctx.addIssue({ code: 'custom', path: ['context'], message: 'Context requires explicit context sharing' });
});

export const WorkRequest = z.object({
  id: id.optional(),
  expected_revision: revision.optional(),
  branch: branch.default('main'),
  intent: IntentInput,
  base_commit: commit,
  workspace_id: id,
}).strict();

export const CheckpointInput = z.object({
  intent_id: id,
  intent_revision: revision,
  branch: branch.default('main'),
  path: SafePath,
  operation: z.enum(['create', 'modify', 'delete']),
  base_hash: hash.nullable(),
  result_hash: hash.nullable(),
  content: z.string().max(1_000_000).nullable(),
  base_content: z.string().max(1_000_000).nullable().optional(),
  workspace_id: id,
  base_commit: commit,
}).strict().superRefine((checkpoint, ctx) => {
  const issue = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (checkpoint.operation === 'create' && checkpoint.base_hash !== null)
    issue('base_hash', 'Created files have no base');
  if (checkpoint.operation === 'modify' && checkpoint.base_hash === null)
    issue('base_hash', 'Modified files require a base hash');
  if (checkpoint.operation === 'delete') {
    if (checkpoint.result_hash !== null) issue('result_hash', 'Deleted files have no result hash');
    if (checkpoint.content !== null) issue('content', 'Deleted files have no content');
  } else {
    if (checkpoint.result_hash === null) issue('result_hash', 'Saved files require a result hash');
    if (checkpoint.content === null) issue('content', 'Saved files require content');
  }
  if (checkpoint.base_hash === null && checkpoint.base_content != null)
    issue('base_content', 'Created files have no base content');
});

export const RespondInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ack'), event_seq: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('renew'), intent_id: id }).strict(),
  z.object({ action: z.literal('finish'), intent_id: id }).strict(),
  z.object({ action: z.literal('cancel'), intent_id: id }).strict(),
  z.object({
    action: z.literal('overlap'), intent_id: id, peer_intent_id: id, peer_revision: revision,
    expected_revision: revision.optional(), mode: z.enum(['wait', 'join', 'coedit', 'separate']),
  }).strict(),
  z.object({ action: z.literal('decision'), intent_id: id, title: z.string().trim().min(1).max(160), description: text }).strict(),
  z.object({ action: z.literal('decision_accept'), decision_id: id }).strict(),
  z.object({
    action: z.literal('handoff_offer'), intent_id: id, checkpoint_id: id, to_run_id: id,
    remaining_criteria: z.array(text).max(32),
  }).strict(),
  z.object({ action: z.literal('handoff_accept'), handoff_id: id, workspace_id: id.optional() }).strict(),
  z.object({ action: z.literal('fetch_commit'), commit_id: id }).strict(),
  z.object({ action: z.literal('approve'), submission_id: id, check_id: id, candidate: commit, target: commit, policy_hash: hash }).strict(),
  z.object({ action: z.literal('retry_check'), submission_id: id }).strict(),
]);

// Loaded only by the administrator. Agent requests cannot carry policy changes.
export const CheckPolicy = z.object({
  image: pinnedImage,
  command: z.array(z.string().max(4096).refine(value => !value.includes('\0'), 'Arguments cannot contain NUL'))
    .min(1).max(64).refine(command => !!command[0]?.length, 'A check executable is required'),
  timeout_ms: z.number().int().min(1).max(300_000).default(30_000),
  memory_mb: z.number().int().min(32).max(2048).default(128),
  cpus: z.number().min(0.1).max(8).default(1),
  pids_limit: z.number().int().min(8).max(512).default(64),
  max_output_bytes: z.number().int().min(1).max(1024 * 1024).default(65_536),
  max_source_bytes: z.number().int().min(1).max(64 * 1024 * 1024).default(16 * 1024 * 1024),
  source_paths: z.array(concretePath).min(1).max(128).optional(),
  check_concurrency: z.number().int().min(1).max(8).default(1),
  approval: z.enum(['manual', 'automatic']).default('manual'),
}).strict();

export const CheckResult = z.object({
  id: id.optional(),
  check_id: id.optional(),
  submission_id: id.optional(),
  target: commit,
  candidate: commit,
  policy_hash: hash,
  image_digest: pinnedImage,
  state: z.enum(['passed', 'failed', 'timed_out', 'error']),
  image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),
  exit_code: z.number().int().nullable().optional(),
  stdout: z.string().max(1024 * 1024).optional(),
  stderr: z.string().max(1024 * 1024).optional(),
  truncated: z.boolean().optional(),
  cleanup: z.enum(['complete', 'failed']).optional(),
  source: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict().optional(),
  container_name: z.string().max(128).optional(),
}).strict();

export const SignedEnvelope = z.object({
  event_id: id,
  run_id: id,
  payload: z.json(),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

/** The agent signs exact draft IDs; Gitpunk creates the Git commit and manifest. */
export async function verifyServerCommit(proof) {
  const request = SignedEnvelope.parse(proof.signed), input = ServerCommit.parse(request.payload);
  if (!await verifyEnvelope(request, proof.public_key) || request.run_id !== proof.actor?.run_id) throw new Error('Invalid server-commit request signature.');
  const manifest = GitUpload.parse(proof.manifest);
  for (const key of ['intent_id', 'intent_revision', 'base_commit', 'branch', 'workspace_id']) if (input[key] !== manifest[key]) throw new Error('Server commit differs from the signed request.');
  if (!Array.isArray(proof.checkpoints) || proof.checkpoints.length !== input.checkpoint_ids.length || manifest.files.length !== input.checkpoint_ids.length) throw new Error('Missing signed draft proofs.');
  for (const draft of proof.checkpoints) {
    const envelope = SignedEnvelope.parse(draft), item = CheckpointInput.parse(envelope.payload);
    if (!input.checkpoint_ids.includes(envelope.event_id) || envelope.run_id !== request.run_id || !await verifyEnvelope(envelope, proof.public_key)) throw new Error('Invalid signed draft proof.');
    for (const key of ['intent_id', 'intent_revision', 'base_commit', 'branch', 'workspace_id']) if (input[key] !== item[key]) throw new Error('Draft belongs to another intent.');
    const file = manifest.files.find(file => file.path === item.path);
    if (!file || file.operation !== item.operation || file.base_hash !== item.base_hash || file.result_hash !== item.result_hash || file.result_mode !== (item.content === null ? null : file.base_mode || '100644')) throw new Error('Created file differs from its signed draft.');
  }
  if (new Set(proof.checkpoints.map(item => item.event_id)).size !== input.checkpoint_ids.length || new Set(proof.checkpoints.map(item => item.payload.path)).size !== manifest.files.length) throw new Error('Duplicate draft proof.');
  return manifest;
}

export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
export const MAX_BUNDLE_BASE64_LENGTH = Math.ceil(MAX_BUNDLE_BYTES / 3) * 4;
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const BundleContent = z.string().min(4).max(MAX_BUNDLE_BASE64_LENGTH).refine(value => {
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length / 4 * 3 - padding > MAX_BUNDLE_BYTES) return false;
  // Reject nonzero padding bits so one byte sequence has one wire encoding.
  const finalValue = base64Alphabet.indexOf(value[value.length - padding - 1]);
  return padding === 2 ? !(finalValue & 15) : padding === 1 ? !(finalValue & 3) : true;
}, 'Use canonical base64 encoding for a bundle up to 4 MiB');

const fileMode = z.enum(['100644', '100755']).nullable();
export const CommitFile = z.object({
  path: SafePath,
  operation: z.enum(['create', 'modify', 'delete']),
  base_hash: hash.nullable(),
  result_hash: hash.nullable(),
  base_mode: fileMode,
  result_mode: fileMode,
}).strict().superRefine((file, ctx) => {
  const basePresent = file.base_hash !== null && file.base_mode !== null;
  const baseAbsent = file.base_hash === null && file.base_mode === null;
  const resultPresent = file.result_hash !== null && file.result_mode !== null;
  const resultAbsent = file.result_hash === null && file.result_mode === null;
  if (!(file.operation === 'create' ? baseAbsent && resultPresent
    : file.operation === 'delete' ? basePresent && resultAbsent : basePresent && resultPresent))
    ctx.addIssue({ code: 'custom', message: 'File operation must match its base/result hashes and modes' });
});

export const GitUpload = z.object({
  intent_id: id,
  intent_revision: revision,
  branch: branch.default('main'),
  workspace_id: id,
  base_commit: commit,
  commit,
  bundle_hash: hash,
  files: z.array(CommitFile).min(1).max(128).refine(files => new Set(files.map(file => file.path)).size === files.length, 'Duplicate committed path'),
}).strict();

// Bytes travel separately; their hash is inside the signed payload.
export const CommitUploadEnvelope = SignedEnvelope.extend({ bundle_content: BundleContent }).strict();

export const TargetSnapshot = z.object({
  origin: z.literal('server'),
  branch,
  base_commit: commit,
  commit,
  bundle_hash: hash.nullable(),
  files: z.array(CommitFile).max(4096).refine(files => new Set(files.map(file => file.path)).size === files.length, 'Duplicate target path'),
}).strict().superRefine((snapshot, ctx) => {
  if ((snapshot.commit === snapshot.base_commit) !== (snapshot.bundle_hash === null) ||
    snapshot.commit === snapshot.base_commit && snapshot.files.length)
    ctx.addIssue({ code: 'custom', message: 'Only the original target has no bundle or changed files' });
});
export const TargetBundle = TargetSnapshot.extend({ bundle_content: BundleContent.nullable() }).strict()
  .superRefine((snapshot, ctx) => {
    if ((snapshot.bundle_hash === null) !== (snapshot.bundle_content === null))
      ctx.addIssue({ code: 'custom', message: 'Target bundle bytes must match presence of its hash' });
  });

export function parseInput(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ProtocolError('invalid_input', 'Invalid protocol input', 400, parsed.error.issues);
  return parsed.data;
}

// Sign only deterministic JSON. Reject values JSON.stringify would silently lose.
export function canonicalJson(value) {
  const visiting = new Set();
  function encode(input) {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object' || !input) throw new ProtocolError('invalid_json', 'Only finite JSON values can be signed');
    if (visiting.has(input)) throw new ProtocolError('invalid_json', 'Cyclic JSON cannot be signed');
    visiting.add(input);
    let result;
    if (Array.isArray(input)) result = `[${Array.from(input, encode).join(',')}]`;
    else {
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
        throw new ProtocolError('invalid_json', 'Only plain JSON objects can be signed');
      result = `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${encode(input[key])}`).join(',')}}`;
    }
    visiting.delete(input);
    return result;
  }
  return encode(value);
}

const bytes = value => new TextEncoder().encode(value);
const toBase64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));
const fromBase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const importKey = (key, usage) => key?.type && key?.algorithm
  ? key
  : crypto.subtle.importKey('jwk', key, { name: 'Ed25519' }, false, [usage]);

export async function generateKeyPair() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
  };
}

export async function hashBytes(content) {
  const input = content instanceof ArrayBuffer ? new Uint8Array(content)
    : ArrayBuffer.isView(content) ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength) : null;
  if (!input) throw new ProtocolError('invalid_content', 'Content must be bytes');
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashContent(content) {
  if (typeof content !== 'string') throw new ProtocolError('invalid_content', 'Content must be a string');
  return hashBytes(bytes(content));
}

export async function signEnvelope(payload, { eventId = crypto.randomUUID(), runId, privateKey }) {
  const unsigned = { event_id: parseInput(id, eventId), run_id: parseInput(id, runId), payload };
  const signature = await crypto.subtle.sign('Ed25519', await importKey(privateKey, 'sign'), bytes(canonicalJson(unsigned)));
  return { ...unsigned, signature: toBase64(signature) };
}

export async function verifyEnvelope(envelope, publicKey) {
  const parsed = SignedEnvelope.safeParse(envelope);
  if (!parsed.success) return false;
  const { event_id, run_id, payload, signature } = parsed.data;
  try {
    return await crypto.subtle.verify('Ed25519', await importKey(publicKey, 'verify'), fromBase64(signature),
      bytes(canonicalJson({ event_id, run_id, payload })));
  } catch { return false; }
}

export const exampleIntent = {
  title: 'Add car model and CRUD',
  type: 'feature',
  summary: 'Add Car persistence and CRUD services.',
  files: ['models.py', 'services.py'],
  done_when: ['CRUD tests pass', 'Existing models still work'],
  sharing: 'summary',
};
