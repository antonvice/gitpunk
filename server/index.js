import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkRequest, CheckpointInput, RespondInput, GitUpload, CommitUploadEnvelope, SignedEnvelope, ServerCommit, SourceQuery, CheckPolicy, ProtocolError, canonicalJson, generateKeyPair, verifyEnvelope } from '../shared/index.js';
import { createOutboxDispatcher } from './kafka.js';
import { createGitStore } from './git-store.js';
import { createCoordinator } from './coordinator.js';
import { serveBoard } from './board.js';
import { createHumanAuth } from './human-auth.js';
import { checkScope, checkReadScope, matches, intersects, secrets } from './policy.js';
import { createSourceStore } from './source.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const parsed = text => JSON.parse(text);
const sql = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
CREATE TABLE IF NOT EXISTS repos(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), visibility TEXT NOT NULL DEFAULT 'private', branch TEXT NOT NULL DEFAULT 'main');
CREATE TABLE IF NOT EXISTS access(repo_id TEXT REFERENCES repos(id), user_id TEXT REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(repo_id,user_id));
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, public_key TEXT NOT NULL, key_expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), owner_id TEXT NOT NULL REFERENCES users(id), repo_id TEXT NOT NULL REFERENCES repos(id), token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, repo_id TEXT REFERENCES repos(id), branch TEXT NOT NULL, run_id TEXT REFERENCES runs(id), revision INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, base_commit TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claims(intent_id TEXT REFERENCES intents(id), path TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(intent_id,path));
CREATE TABLE IF NOT EXISTS overlaps(intent_id TEXT REFERENCES intents(id), peer_id TEXT REFERENCES intents(id), peer_revision INTEGER NOT NULL, mode TEXT NOT NULL, PRIMARY KEY(intent_id,peer_id));
CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES intents(id), run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id), branch TEXT NOT NULL, intent_id TEXT REFERENCES intents(id), run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL DEFAULT 'proposed', data TEXT NOT NULL, accepted_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id), branch TEXT NOT NULL, from_run_id TEXT NOT NULL REFERENCES runs(id), to_run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL DEFAULT 'offered', data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, repo_id TEXT NOT NULL REFERENCES repos(id), branch TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL, envelope TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, UNIQUE(repo_id,branch,seq));
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id), run_id TEXT NOT NULL REFERENCES runs(id), intent_id TEXT NOT NULL REFERENCES intents(id), commit_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, envelope TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS source_requests(id TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS git_commits(repo_id TEXT NOT NULL REFERENCES repos(id), commit_id TEXT NOT NULL, PRIMARY KEY(repo_id,commit_id));
`;

function fail(code, message, status = 400, details) { throw new ProtocolError(code, message, status, details); }
function validate(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) fail('invalid_input', 'Request does not match the protocol.', 400, result.error.issues.map(({ path, message }) => ({ path, message })));
  return result.data;
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function readOidcConfig(file) {
  let handle;
  try {
    handle = await open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error();
    return JSON.parse(await handle.readFile('utf8'));
  } catch { throw new Error('OIDC config must be a private, owner-controlled JSON file of at most 16 KiB.'); }
  finally { await handle?.close(); }
}

export async function createGitpunkServer({ dataDir = '.local/server', port = 8787, kafkaBrokers = [], bootstrap = false, leaseMs = 30_000, gitSource, checkPolicy, runner, oidcConfig } = {}) {
  dataDir = path.resolve(dataDir);
  if (dataDir.split(path.sep).includes('.git')) throw new Error('Server state must be outside .git.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const db = new DatabaseSync(path.join(dataDir, 'gitpunk.sqlite'));
  db.exec(sql);
  await chmod(path.join(dataDir, 'gitpunk.sqlite'), 0o600);
  const humanAuth = createHumanAuth({ db, config: oidcConfig });
  const dispatcher = createOutboxDispatcher(db, { brokers: kafkaBrokers });
  let fixture;
  if (bootstrap) fixture = await seed(db, dataDir);
  const gitStore = await createGitStore({ dataDir, source: gitSource, db });
  // Backfill accepted history once per old upload; a lost migration resumes by commit ID.
  if (gitStore) for (const row of db.prepare("SELECT u.* FROM uploads u LEFT JOIN git_commits c ON c.repo_id=u.repo_id AND c.commit_id=u.commit_id WHERE u.state='uploaded' AND c.commit_id IS NULL").all()) {
    const commits = await gitStore.history(parsed(row.data).base_commit, row.commit_id);
    transaction(db, () => { for (const commit of commits) db.prepare('INSERT OR IGNORE INTO git_commits VALUES(?,?)').run(row.repo_id, commit); });
  }
  const sourceStore = gitStore && createSourceStore(gitStore, db);
  const uploadTasks = new Map();
  if (fixture && gitStore) fixture.git = { configured: true, base_commit: gitStore.config.base_commit, branch: gitStore.config.branch };
  function authenticate(request, repoId, write = false) {
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) fail('unauthenticated', 'A run bearer token is required.', 401);
    const auth = db.prepare(`SELECT r.*, a.public_key, a.key_expires, a.revoked AS key_revoked, a.owner_id AS agent_owner, u.state AS user_state FROM runs r JOIN agents a ON a.id=r.agent_id JOIN users u ON u.id=r.owner_id WHERE token_hash=?`).get(digest(token));
    return authorize(auth, repoId, write);
  }
  function authorize(auth, repoId, write = false) {
    if (!auth || auth.revoked || auth.key_revoked || auth.expires <= Date.now() || auth.key_expires <= Date.now() || auth.agent_owner !== auth.owner_id || auth.user_state !== 'active') fail('unauthenticated', 'Run credential or signing key is expired/revoked.', 401);
    const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId);
    const access = db.prepare('SELECT role FROM access WHERE repo_id=? AND user_id=?').get(repoId, auth.owner_id);
    // Local development routes expose private collaboration only, even for a public source repo.
    if (!repo || auth.repo_id !== repoId || (!access && repo.owner_id !== auth.owner_id)) fail('forbidden', 'No access to this repository.', 403);
    if (write && access?.role === 'reader' && repo.owner_id !== auth.owner_id) fail('forbidden', 'Repository role is read-only.', 403);
    auth.role = repo.owner_id === auth.owner_id ? 'admin' : access.role;
    return auth;
  }
  function authorizeUpload(record, { approval = false } = {}) {
    const auth = db.prepare(`SELECT r.*,a.public_key,a.key_expires,a.revoked AS key_revoked,a.owner_id AS agent_owner,u.state AS user_state FROM runs r JOIN agents a ON a.id=r.agent_id JOIN users u ON u.id=r.owner_id WHERE r.id=?`).get(record.run_id);
    const allowed = authorize(auth, record.repo_id, true);
    if (!approval) {
      const manifest = parsed(record.data).manifest, intent = ownIntent(allowed, manifest.intent_id);
      if (!gitStore || record.repo_id !== gitStore.config.repo_id || manifest.branch !== gitStore.config.branch) fail('unsupported_target', 'This local integrator only supports its configured repository and target branch.', 409);
      if (intent.revision !== manifest.intent_revision || intent.base_commit !== manifest.base_commit || intent.workspace_id !== manifest.workspace_id || ['cancelled','handed_off'].includes(intent.state)) fail('intent_changed', 'Uploaded intent changed or closed before integration.', 409);
      if (canonicalJson(parsed(auth.public_key)) !== canonicalJson(parsed(record.data).public_key)) fail('signing_key_changed', 'Upload signing key is no longer current.', 401);
    }
    return allowed;
  }
  function inspectCandidate(record, auth, change) {
    checkScope(auth, change.path, change.operation);
    const intent = ownIntent(auth, parsed(record.data).manifest.intent_id);
    if (!parsed(intent.data).files.some(file => matches(file, change.path))) fail('outside_intent', 'Merged candidate exceeds declared intent scope.', 403);
    if (change.resultBytes && secrets(change.resultBytes.toString('utf8'))) fail('secret_detected', 'Merged candidate contains credential material.', 403);
  }
  const coordinator = createCoordinator({ db, gitStore, policy: checkPolicy ? CheckPolicy.parse(checkPolicy) : null, authorize: authorizeUpload, inspect: inspectCandidate, runner, publish: (record, id, type, data) => emit({ id: record.run_id }, { event_id: id, run_id: record.run_id, payload: { source_upload_id: record.id }, signature: null }, record.repo_id, parsed(record.data).branch, type, data) });
  function emit(auth, envelope, repoId, branch, type, payload) {
    const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE repo_id=? AND branch=?').get(repoId, branch).seq);
    const eventId = `${envelope.event_id}:${type}`;
    const createdAt = Date.now();
    db.prepare('INSERT INTO events(event_id,repo_id,branch,seq,type,run_id,payload,envelope,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(eventId, repoId, branch, seq, type, auth.id, JSON.stringify(payload), JSON.stringify(envelope), createdAt);
    return { event_id: eventId, repo_id: repoId, branch, seq, type, origin: envelope.signature ? 'agent' : 'server', run_id: auth.id, actor: actor(auth.id), payload, created_at: createdAt };
  }
  function actor(runId) {
    const run = db.prepare('SELECT id AS run_id,agent_id,owner_id FROM runs WHERE id=?').get(runId);
    return run ? { run_id: run.run_id, agent_id: run.agent_id, owner_id: run.owner_id } : null;
  }
  function intentView(row) {
    if (!row) return null;
    const live = db.prepare('SELECT 1 FROM claims WHERE intent_id=? AND expires>? LIMIT 1').get(row.id, Date.now());
    const state = ['active','blocked'].includes(row.state) && !live ? 'lease_expired' : row.state;
    return { id: row.id, intent_id: row.id, revision: row.revision, branch: row.branch, run_id: row.run_id, actor: actor(row.run_id), state, ...parsed(row.data), base_commit: row.base_commit, workspace_id: row.workspace_id };
  }
  function ownIntent(auth, id) {
    const intent = db.prepare('SELECT * FROM intents WHERE id=? AND repo_id=?').get(id, auth.repo_id);
    if (!intent || intent.run_id !== auth.id) fail('forbidden', 'Intent must belong to this run.', 403);
    return intent;
  }
  function peerOverlaps(intentId, repoId, branch, files) {
    const claims = db.prepare(`SELECT c.path, c.expires, i.rowid AS intent_order, i.* FROM claims c JOIN intents i ON i.id=c.intent_id WHERE i.repo_id=? AND i.branch=? AND i.id<>? AND c.expires>? AND i.state='active'`).all(repoId, branch, intentId, Date.now());
    const overlap = new Map();
    for (const claim of claims) if (files.some(file => intersects(file, claim.path))) {
      const acknowledged = db.prepare('SELECT * FROM overlaps WHERE intent_id=? AND peer_id=? AND peer_revision=?').get(intentId, claim.id, claim.revision);
      const current = db.prepare('SELECT revision,rowid AS intent_order FROM intents WHERE id=?').get(intentId);
      const reciprocal = current && current.intent_order < claim.intent_order && db.prepare('SELECT * FROM overlaps WHERE intent_id=? AND peer_id=? AND peer_revision=?').get(claim.id, intentId, current.revision);
      if (![acknowledged, reciprocal].some(record => record && ['join', 'coedit', 'separate'].includes(record.mode))) overlap.set(claim.id, { intent_id: claim.id, revision: claim.revision, title: parsed(claim.data).title, path: claim.path, run_id: claim.run_id });
    }
    return [...overlap.values()];
  }
  function writableIntent(auth, id, revision) {
    const intent = ownIntent(auth, id);
    if (intent.revision !== revision) fail('stale_revision', 'Intent revision has changed.', 409, { current_revision: intent.revision });
    if (['cancelled','complete'].includes(intent.state)) fail('intent_closed', 'Intent is closed.', 409);
    const claims = db.prepare('SELECT * FROM claims WHERE intent_id=? AND expires>?').all(id, Date.now());
    if (!claims.length) fail('lease_expired', 'Redeclare work before publishing after lease expiry.', 409);
    const conflicts = peerOverlaps(id, auth.repo_id, intent.branch, parsed(intent.data).files);
    if (conflicts.length) fail('overlap', 'Acknowledge the current peer intent revision before publishing.', 409, { overlaps: conflicts });
    return intent;
  }
  async function mutation(request, auth, repoId, route, body) {
    if (!body || typeof body.event_id !== 'string' || body.event_id.length > 200 || body.run_id !== auth.id || typeof body.signature !== 'string') fail('invalid_envelope', 'A signed envelope matching the authenticated run is required.');
    let verified = false;
    try { verified = await verifyEnvelope(body, parsed(auth.public_key)); } catch {}
    if (!verified) fail('invalid_signature', 'Signature verification failed.', 401);
    const verifiedKey = auth.public_key;
    const schema = route === 'work' ? WorkRequest : route === 'checkpoints' ? CheckpointInput : RespondInput;
    const input = validate(schema, body.payload);
    const requestHash = digest(canonicalJson({ repoId, route, run_id: auth.id, payload: body.payload }));
    return transaction(db, () => {
      // Upload/signature verification yields; privileges must still hold at admission.
      auth = authenticate(request, repoId, true);
      if (auth.public_key !== verifiedKey) fail('invalid_signature', 'Signing key changed before admission.', 401);
      const prior = db.prepare('SELECT * FROM requests WHERE id=?').get(body.event_id);
      if (prior) { if (prior.hash !== requestHash) fail('idempotency_conflict', 'Event ID was already used for different content.', 409); return parsed(prior.response); }
      let result;
      if (route === 'work') result = work(auth, body, input, repoId);
      else if (route === 'checkpoints') result = checkpoint(auth, body, input, repoId);
      else result = respond(auth, body, input, repoId);
      db.prepare('INSERT INTO requests(id,hash,response) VALUES(?,?,?)').run(body.event_id, requestHash, JSON.stringify(result));
      return result;
    });
  }
  async function upload(request, auth, repoId, body) {
    if (!gitStore || repoId !== 'demo') fail('git_not_configured', 'An administrator must configure a trusted local Git source first.', 503);
    const wire = validate(CommitUploadEnvelope, body);
    const { bundle_content, ...envelope } = wire;
    if (envelope.run_id !== auth.id || !await verifyEnvelope(envelope, parsed(auth.public_key))) fail('invalid_signature', 'Signature must match the authenticated run.', 401);
    const verifiedKey = auth.public_key;
    const input = validate(GitUpload, envelope.payload);
    const requestHash = digest(canonicalJson({ repoId, route: 'commits', run_id: auth.id, payload: envelope.payload }));
    auth = authenticate(request, repoId, true);
    if (auth.public_key !== verifiedKey) fail('invalid_signature', 'Signing key changed before admission.', 401);
    const verifiedScope = auth.scope;
    const prior = db.prepare('SELECT * FROM requests WHERE id=?').get(envelope.event_id);
    if (prior) { if (prior.hash !== requestHash) fail('idempotency_conflict', 'Event ID already names other content.', 409); return parsed(prior.response); }
    const pending = uploadTasks.get(envelope.event_id);
    if (pending) { if (pending.hash !== requestHash) fail('idempotency_conflict', 'Upload ID already names other content.', 409); return pending.promise; }
    const task = (async () => {
      const intent = writableIntent(auth, input.intent_id, input.intent_revision);
      if (input.branch !== intent.branch || input.workspace_id !== intent.workspace_id || input.base_commit !== intent.base_commit) fail('base_mismatch', 'Upload branch/workspace/base must match the intent.', 409);
      const files = parsed(intent.data).files;
      const inspect = (change, bytes, kind) => {
        if (kind === 'change') {
          checkScope(auth, change.path, change.operation);
          if (!files.some(file => matches(file, change.path))) fail('outside_intent', 'Every committed history change must be within declared intent scope.', 403, { path: change.path });
        }
        if (bytes && secrets(bytes.toString('utf8'))) fail('secret_detected', 'Committed history contains recognized credential material.', 403);
      };
      const stored = await gitStore.prepare(input, bundle_content, { eventId: envelope.event_id, runId: auth.id, inspect });
      // Git work yields to other requests. Recheck delegated access and intent at final admission.
      auth = authenticate(request, repoId, true);
      if (auth.public_key !== verifiedKey) fail('invalid_signature', 'Signing key changed during upload.', 401);
      const current = writableIntent(auth, input.intent_id, input.intent_revision);
      if (current.base_commit !== input.base_commit || current.workspace_id !== input.workspace_id || current.branch !== input.branch) fail('base_mismatch', 'Intent changed during upload.', 409);
      for (const file of input.files) checkScope(auth, file.path, file.operation);
      if (await gitStore.readRef(stored.ref) !== input.commit) fail('upload_readback_failed', 'Uploaded Git ref does not match the signed commit.', 503);
      return transaction(db, () => {
        auth = authenticate(request, repoId, true);
        if (auth.public_key !== verifiedKey) fail('invalid_signature', 'Signing key changed before admission.', 401);
        if (auth.scope !== verifiedScope) fail('scope_changed', 'Run permissions changed during upload.', 403);
        const finalIntent = writableIntent(auth, input.intent_id, input.intent_revision);
        if (finalIntent.base_commit !== input.base_commit || finalIntent.workspace_id !== input.workspace_id || finalIntent.branch !== input.branch || finalIntent.data !== intent.data) fail('base_mismatch', 'Intent changed before final admission.', 409);
        const already = db.prepare('SELECT * FROM requests WHERE id=?').get(envelope.event_id);
        if (already) { if (already.hash !== requestHash) fail('idempotency_conflict', 'Event ID already names other content.', 409); return parsed(already.response); }
        const data = { id: envelope.event_id, state: 'uploaded', intent_id: input.intent_id, intent_revision: input.intent_revision, branch: input.branch, commit: input.commit, base_commit: input.base_commit, workspace_id: input.workspace_id, git_ref: stored.ref, files: stored.files, history_commits: stored.commits, bundle_hash: input.bundle_hash, manifest: input, actor: actor(auth.id), signed: envelope, public_key: parsed(verifiedKey), checked: false, integrated: false };
        db.prepare('INSERT INTO uploads(id,repo_id,run_id,intent_id,commit_id,state,data,envelope,created_at) VALUES(?,?,?,?,?,\'uploaded\',?,?,?)').run(data.id, repoId, auth.id, input.intent_id, input.commit, JSON.stringify(data), JSON.stringify(envelope), Date.now());
        for (const commit of stored.commit_ids) db.prepare('INSERT OR IGNORE INTO git_commits VALUES(?,?)').run(repoId, commit);
        const event = emit(auth, envelope, repoId, input.branch, 'commit.uploaded', data);
        const result = { ...data, blockers: [], next_actions: [], event };
        db.prepare('INSERT INTO requests(id,hash,response) VALUES(?,?,?)').run(envelope.event_id, requestHash, JSON.stringify(result));
        return result;
      });
    })();
    uploadTasks.set(envelope.event_id, { hash: requestHash, promise: task });
    try { return await task; } finally { uploadTasks.delete(envelope.event_id); }
  }
  async function serverCommit(request, auth, repoId, body) {
    if (!gitStore || repoId !== gitStore.config.repo_id) fail('git_not_configured', 'Trusted Git source required.', 503);
    body = validate(SignedEnvelope, body);
    if (!body || body.run_id !== auth.id || !await verifyEnvelope(body, parsed(auth.public_key))) fail('invalid_signature', 'Signed commit request required.', 401);
    const input = validate(ServerCommit, body.payload), key = auth.public_key, scope = auth.scope;
    auth = authenticate(request, repoId, true);
    if (auth.public_key !== key || auth.scope !== scope) fail('scope_changed', 'Authority changed before admission.', 403);
    const requestHash = digest(canonicalJson({ repoId, route: 'changesets', run_id: auth.id, payload: input }));
    const prior = db.prepare('SELECT * FROM requests WHERE id=?').get(body.event_id);
    if (prior) { if (prior.hash !== requestHash) fail('idempotency_conflict', 'Request ID was reused.', 409); return parsed(prior.response); }
    const pending = uploadTasks.get(body.event_id);
    if (pending) { if (pending.hash !== requestHash) fail('idempotency_conflict', 'Request ID was reused.', 409); return pending.promise; }
    const task = (async () => {
      const intent = writableIntent(auth, input.intent_id, input.intent_revision);
      if (intent.base_commit !== input.base_commit || intent.branch !== input.branch || intent.workspace_id !== input.workspace_id) fail('base_mismatch', 'Commit must match the declared intent.', 409);
      if (input.branch !== gitStore.config.branch) fail('unsupported_target', 'Unsupported canonical branch.', 409);
      if (secrets(input.message)) fail('secret_detected', 'Commit message contains credential material.', 403);
      const checkpoints = input.checkpoint_ids.map(id => {
        const row = db.prepare('SELECT data FROM checkpoints WHERE id=? AND intent_id=? AND run_id=?').get(id, intent.id, auth.id);
        if (!row) fail('checkpoint_mismatch', 'Commit pins checkpoints owned by this intent and run.', 409);
        const item = parsed(row.data);
        if (item.intent_revision !== intent.revision || item.base_commit !== intent.base_commit || item.workspace_id !== intent.workspace_id) fail('stale_checkpoint', 'Checkpoint no longer matches the intent.', 409);
        checkScope(auth, item.path, item.operation);
        if (!parsed(intent.data).files.includes(item.path)) fail('outside_intent', 'Checkpoint exceeds current intent.', 403);
        return item;
      });
      if (new Set(checkpoints.map(item => item.path)).size !== checkpoints.length) fail('duplicate_path', 'Pin one checkpoint per path.');
      for (const item of checkpoints) {
        const entry = await sourceStore.metadata(input.base_commit, item.path);
        const bytes = entry ? await sourceStore.bytes(entry) : null;
        if ((bytes === null ? null : digest(bytes)) !== item.base_hash) fail('base_mismatch', 'Checkpoint baseline differs from its real Git parent.', 409);
      }
      const reserved = db.prepare('SELECT hash FROM source_requests WHERE id=?').get(body.event_id);
      if (reserved && reserved.hash !== requestHash) fail('idempotency_conflict', 'Request ID was reused.', 409);
      db.prepare('INSERT OR IGNORE INTO source_requests(id,hash) VALUES(?,?)').run(body.event_id, requestHash);
      const ref = `refs/gitpunk/runs/${auth.id}/${body.event_id}`;
      const commit = await gitStore.readRef(ref).catch(() => null) || await sourceStore.commit(input.base_commit, checkpoints, input.message, body.event_id);
      const actual = await gitStore.changes(input.base_commit, commit);
      if (!actual.length || actual.length !== checkpoints.length || actual.some(file => !checkpoints.some(item => item.path === file.path && item.base_hash === file.base_hash && item.result_hash === file.result_hash))) fail('manifest_mismatch', 'Created commit differs from the pinned drafts.', 409);
      for (const file of actual) inspectCandidate({ data: JSON.stringify({ manifest: input }) }, auth, file);
      const storedRef = await gitStore.recordCreated(commit, { eventId: body.event_id, runId: auth.id });
      return transaction(db, () => {
        auth = authenticate(request, repoId, true);
        if (auth.public_key !== key || auth.scope !== scope) fail('scope_changed', 'Authority changed while creating the commit.', 403);
        const current = writableIntent(auth, input.intent_id, input.intent_revision);
        if (current.data !== intent.data || current.base_commit !== input.base_commit || current.workspace_id !== input.workspace_id) fail('intent_changed', 'Intent changed before admission.', 409);
        const files = actual.map(({ baseBytes, resultBytes, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path));
        const manifest = { ...input, commit, files }; delete manifest.action; delete manifest.message; delete manifest.checkpoint_ids;
        const data = { id: body.event_id, state: 'uploaded', intent_id: intent.id, intent_revision: intent.revision, branch: input.branch, commit, base_commit: input.base_commit, workspace_id: input.workspace_id, git_ref: storedRef, files, manifest, actor: actor(auth.id), signed: body, public_key: parsed(key), provenance: 'server_commit', checked: false, integrated: false };
        db.prepare("INSERT INTO uploads(id,repo_id,run_id,intent_id,commit_id,state,data,envelope,created_at) VALUES(?,?,?,?,?,'uploaded',?,?,?)").run(data.id, repoId, auth.id, intent.id, commit, JSON.stringify(data), JSON.stringify(body), Date.now());
        db.prepare('INSERT OR IGNORE INTO git_commits VALUES(?,?)').run(repoId, commit);
        const event = emit(auth, body, repoId, input.branch, 'commit.uploaded', data);
        const response = { ...data, blockers: [], next_actions: [], event };
        db.prepare('INSERT INTO requests(id,hash,response) VALUES(?,?,?)').run(data.id, requestHash, JSON.stringify(response));
        return response;
      });
    })();
    uploadTasks.set(body.event_id, { hash: requestHash, promise: task });
    try { return await task; } finally { uploadTasks.delete(body.event_id); }
  }
  function work(auth, envelope, input, repoId) {
    const id = input.id ?? randomUUID();
    const previous = db.prepare('SELECT * FROM intents WHERE id=?').get(id);
    if (previous && (previous.run_id !== auth.id || previous.repo_id !== repoId)) fail('forbidden', 'Intent belongs to another run.', 403);
    if (previous && ['cancelled','complete','handed_off'].includes(previous.state)) fail('intent_closed', 'Create a new intent after closing or handing off work.', 409);
    if (previous && previous.revision !== input.expected_revision) fail('stale_revision', 'Expected intent revision is required.', 409, { current_revision: previous.revision });
    if (!previous && input.expected_revision !== undefined && input.expected_revision !== 0) fail('stale_revision', 'New intent must start at revision zero.', 409);
    for (const file of input.intent.files) checkScope(auth, file, 'modify');
    if (secrets(JSON.stringify(input.intent))) fail('secret_detected', 'Remove credential material before publishing.', 403);
    const revision = (previous?.revision ?? 0) + 1;
    const branch = input.branch ?? 'main';
    if (previous && previous.branch !== branch) fail('branch_changed', 'An intent cannot change target branch.');
    db.prepare(`INSERT INTO intents(id,repo_id,branch,run_id,revision,state,data,base_commit,workspace_id,created_at) VALUES(?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,data=excluded.data,base_commit=excluded.base_commit,workspace_id=excluded.workspace_id`).run(id, repoId, branch, auth.id, revision, JSON.stringify(input.intent), input.base_commit, input.workspace_id, Date.now());
    db.prepare('DELETE FROM claims WHERE intent_id=?').run(id);
    db.prepare('DELETE FROM overlaps WHERE intent_id=? OR peer_id=?').run(id, id);
    for (const file of input.intent.files) db.prepare('INSERT INTO claims(intent_id,path,generation,expires) VALUES(?,?,?,?)').run(id, file, revision, Date.now() + leaseMs);
    if (previous) {
      // A changed earlier intent invalidates newer agents' prior acknowledgements.
      // Keep the first reservation active; the newer writer must see the new revision.
      const order = db.prepare('SELECT rowid AS ordinal FROM intents WHERE id=?').get(id).ordinal;
      const later = db.prepare("SELECT * FROM intents WHERE repo_id=? AND branch=? AND rowid>? AND state='active'").all(repoId, branch, order);
      for (const peer of later) if (parsed(peer.data).files.some(a => input.intent.files.some(b => intersects(a, b)))) db.prepare("UPDATE intents SET state='blocked' WHERE id=?").run(peer.id);
    }
    const overlaps = peerOverlaps(id, repoId, branch, input.intent.files);
    const state = overlaps.length ? 'blocked' : 'active';
    db.prepare('UPDATE intents SET state=? WHERE id=?').run(state, id);
    const intent = intentView(db.prepare('SELECT * FROM intents WHERE id=?').get(id));
    const event = emit(auth, envelope, repoId, branch, 'intent.changed', { id, intent, overlaps });
    return { state, intent, intent_id: id, revision, overlaps, blockers: overlaps.map(peer => ({ type: 'overlap', ...peer })), next_actions: overlaps.length ? ['respond:overlap'] : ['edit'], event };
  }
  function checkpoint(auth, envelope, input, repoId) {
    const intent = writableIntent(auth, input.intent_id, input.intent_revision);
    if (input.branch !== intent.branch || input.workspace_id !== intent.workspace_id || input.base_commit !== intent.base_commit) fail('base_mismatch', 'Checkpoint branch/workspace/base must match the intent.', 409);
    checkScope(auth, input.path, input.operation);
    if (!parsed(intent.data).files.some(file => matches(file, input.path))) fail('outside_intent', 'Declare this path in intent scope before publishing.', 403);
    if (input.operation === 'delete') {
      if (input.content != null || input.result_hash != null) fail('hash_mismatch', 'Deleted files have no result content/hash.');
      if (input.base_hash === null) {
        const earlier = db.prepare('SELECT data FROM checkpoints WHERE intent_id=? ORDER BY rowid DESC').all(intent.id).map(row => parsed(row.data)).find(item => item.intent_revision === intent.revision && item.path === input.path);
        if (!earlier || earlier.base_hash !== null || earlier.operation !== 'create' || earlier.content === null) fail('missing_created_draft', 'Deleting an untracked draft requires a prior accepted creation.', 409);
      }
    } else if (typeof input.content !== 'string' || digest(input.content) !== input.result_hash) fail('hash_mismatch', 'Checkpoint hash does not match content.');
    if (input.base_content != null && digest(input.base_content) !== input.base_hash) fail('hash_mismatch', 'Checkpoint base hash does not match content.');
    if (secrets(input.content) || secrets(input.base_content)) fail('secret_detected', 'Remove credential material before publishing.', 403);
    const id = envelope.event_id;
    const data = { ...input, id, run_id: auth.id, actor: actor(auth.id), base_verified: false };
    db.prepare('INSERT INTO checkpoints(id,intent_id,run_id,data,created_at) VALUES(?,?,?,?,?)').run(id, intent.id, auth.id, JSON.stringify(data), Date.now());
    const event = emit(auth, envelope, repoId, intent.branch, 'draft.changed', { id, intent_id: intent.id, intent_revision: intent.revision, path: input.path, operation: input.operation, result_hash: input.result_hash, base_hash: input.base_hash });
    return { state: 'draft', checkpoint: data, checkpoint_id: id, blockers: [], next_actions: [], event };
  }
  function respond(auth, envelope, input, repoId) {
    let branch = 'main', data, type;
    if (input.action === 'approve' || input.action === 'retry_check') {
      data = input.action === 'approve' ? coordinator.approve(auth, envelope, input) : coordinator.retry(auth, input);
      branch = parsed(db.prepare('SELECT data FROM uploads WHERE id=?').get(input.submission_id).data).branch;
      type = input.action === 'approve' ? 'integration.approved' : 'checks.requeued';
    } else if (input.action === 'ack') {
      data = { acknowledged: input.event_seq }; type = 'inbox.acknowledged';
    } else if (input.action === 'overlap') {
      const intent = ownIntent(auth, input.intent_id); branch = intent.branch;
      if (input.expected_revision !== undefined && intent.revision !== input.expected_revision) fail('stale_revision', 'Own intent revision changed.', 409, { current_revision: intent.revision });
      const peer = db.prepare('SELECT * FROM intents WHERE id=? AND repo_id=? AND branch=?').get(input.peer_intent_id, repoId, branch);
      if (!peer || peer.revision !== input.peer_revision) fail('stale_revision', 'Peer intent revision changed.', 409, { current_revision: peer?.revision });
      db.prepare('INSERT INTO overlaps(intent_id,peer_id,peer_revision,mode) VALUES(?,?,?,?) ON CONFLICT(intent_id,peer_id) DO UPDATE SET peer_revision=excluded.peer_revision,mode=excluded.mode').run(intent.id, peer.id, peer.revision, input.mode);
      const conflicts = peerOverlaps(intent.id, repoId, branch, parsed(intent.data).files);
      const state = input.mode === 'wait' || conflicts.length ? 'blocked' : 'active';
      db.prepare('UPDATE intents SET state=? WHERE id=?').run(state, intent.id);
      data = { id: intent.id, ...input, state }; type = 'overlap.responded';
    } else if (input.action === 'decision') {
      const intent = ownIntent(auth, input.intent_id); branch = intent.branch;
      if (secrets(input.title + input.description)) fail('secret_detected', 'Decision contains credential material.', 403);
      data = { ...input, id: envelope.event_id, intent_revision: intent.revision, state: 'proposed', run_id: auth.id };
      db.prepare('INSERT INTO decisions(id,repo_id,branch,intent_id,run_id,data,created_at) VALUES(?,?,?,?,?,?,?)').run(data.id, repoId, branch, intent.id, auth.id, JSON.stringify(data), Date.now()); type = 'decision.proposed';
    } else if (input.action === 'decision_accept') {
      const decision = db.prepare('SELECT * FROM decisions WHERE id=? AND repo_id=?').get(input.decision_id, repoId);
      if (!decision) fail('not_found', 'Decision not found.', 404);
      if (decision.state !== 'proposed') fail('decision_closed', 'Decision is already accepted.', 409);
      const proposed = parsed(decision.data);
      const sourceIntent = db.prepare('SELECT revision FROM intents WHERE id=?').get(decision.intent_id);
      if (!sourceIntent || sourceIntent.revision !== proposed.intent_revision) fail('stale_decision', 'Proposed decision belongs to an earlier intent revision.', 409);
      branch = decision.branch;
      db.prepare("UPDATE decisions SET state='agreed',accepted_by=? WHERE id=?").run(auth.id, decision.id);
      data = { ...parsed(decision.data), state: 'agreed', accepted_by: auth.id }; type = 'decision.agreed';
    } else if (input.action === 'handoff_offer') {
      const intent = ownIntent(auth, input.intent_id); branch = intent.branch;
      const checkpoint = db.prepare('SELECT rowid AS ordinal,* FROM checkpoints WHERE id=? AND intent_id=? AND run_id=?').get(input.checkpoint_id, intent.id, auth.id);
      if (!checkpoint) fail('checkpoint_mismatch', 'Handoff must pin a checkpoint owned by this intent/run.', 409);
      const recipient = db.prepare('SELECT r.*,a.revoked AS key_revoked,a.key_expires,u.state AS user_state FROM runs r JOIN agents a ON a.id=r.agent_id JOIN users u ON u.id=r.owner_id WHERE r.id=? AND r.repo_id=?').get(input.to_run_id, repoId);
      const access = recipient && db.prepare('SELECT role FROM access WHERE repo_id=? AND user_id=?').get(repoId, recipient.owner_id);
      if (!recipient || recipient.id === auth.id || recipient.revoked || recipient.key_revoked || recipient.expires <= Date.now() || recipient.key_expires <= Date.now() || recipient.user_state !== 'active' || !access || access.role === 'reader') fail('recipient_forbidden', 'Recipient must already be an authorized active contributor run.', 403);
      const anchor = parsed(checkpoint.data);
      if (anchor.intent_revision !== intent.revision || anchor.base_commit !== intent.base_commit || anchor.workspace_id !== intent.workspace_id) fail('stale_checkpoint', 'Handoff anchor must match the current intent revision/base.', 409);
      const checkpointRows = db.prepare('SELECT data FROM checkpoints WHERE intent_id=? ORDER BY rowid').all(intent.id);
      const latestByPath = new Map();
      for (const row of checkpointRows) {
        const item = parsed(row.data);
        if (item.intent_revision === intent.revision && item.base_commit === intent.base_commit && item.workspace_id === intent.workspace_id) latestByPath.set(item.path, item.id);
      }
      const decisionIds = db.prepare("SELECT id FROM decisions WHERE repo_id=? AND branch=? AND state='agreed' ORDER BY rowid").all(repoId, branch).map(row => row.id);
      data = { ...input, id: envelope.event_id, intent_revision: intent.revision, checkpoint_ids: [...latestByPath.values()], decision_ids: decisionIds, base_commit: intent.base_commit, state: 'offered', from_run_id: auth.id };
      db.prepare('INSERT INTO handoffs(id,repo_id,branch,from_run_id,to_run_id,data,created_at) VALUES(?,?,?,?,?,?,?)').run(data.id, repoId, branch, auth.id, recipient.id, JSON.stringify(data), Date.now()); type = 'handoff.offered';
    } else if (input.action === 'handoff_accept') {
      const handoff = db.prepare('SELECT * FROM handoffs WHERE id=? AND repo_id=?').get(input.handoff_id, repoId);
      if (!handoff) fail('not_found', 'Handoff not found.', 404);
      if (handoff.to_run_id !== auth.id) fail('forbidden', 'Only the intended recipient can accept this handoff.', 403);
      if (handoff.state !== 'offered') fail('handoff_closed', 'Handoff is already accepted.', 409);
      branch = handoff.branch;
      const offer = parsed(handoff.data);
      const source = db.prepare('SELECT * FROM intents WHERE id=?').get(offer.intent_id);
      if (source.revision !== offer.intent_revision || source.base_commit !== offer.base_commit || source.state !== 'active') fail('stale_handoff', 'Source intent changed after the offer.', 409);
      const inherited = parsed(source.data);
      for (const file of inherited.files) checkScope(auth, file, 'modify');
      db.prepare("UPDATE intents SET state='handed_off' WHERE id=?").run(source.id);
      db.prepare('DELETE FROM claims WHERE intent_id=?').run(source.id);
      const continuationId = envelope.event_id;
      const criteria = offer.remaining_criteria.length ? offer.remaining_criteria : inherited.done_when;
      const continuation = { ...inherited, done_when: criteria, handoff_id: handoff.id, source_intent_id: source.id };
      db.prepare("INSERT INTO intents(id,repo_id,branch,run_id,revision,state,data,base_commit,workspace_id,created_at) VALUES(?,?,?,?,1,'active',?,?,?,?)").run(continuationId, repoId, branch, auth.id, JSON.stringify(continuation), source.base_commit, input.workspace_id ?? `handoff-${handoff.id}`, Date.now());
      for (const file of inherited.files) db.prepare('INSERT INTO claims(intent_id,path,generation,expires) VALUES(?,?,1,?)').run(continuationId, file, Date.now() + leaseMs);
      const conflicts = peerOverlaps(continuationId, repoId, branch, inherited.files);
      if (conflicts.length) db.prepare("UPDATE intents SET state='blocked' WHERE id=?").run(continuationId);
      db.prepare("UPDATE handoffs SET state='accepted' WHERE id=?").run(handoff.id);
      data = { ...offer, state: 'accepted', accepted_by: auth.id, intent: intentView(db.prepare('SELECT * FROM intents WHERE id=?').get(continuationId)), blockers: conflicts }; type = 'handoff.accepted';
    } else if (input.action === 'renew') {
      const intent = ownIntent(auth, input.intent_id); branch = intent.branch;
      if (input.expected_revision !== undefined && input.expected_revision !== intent.revision) fail('stale_revision', 'Intent revision changed.', 409);
      if (!['active','blocked'].includes(intent.state)) fail('intent_closed', 'Intent is no longer active.', 409);
      const renewal = db.prepare('UPDATE claims SET expires=? WHERE intent_id=? AND expires>?').run(Date.now() + leaseMs, intent.id, Date.now());
      if (!Number(renewal.changes)) fail('lease_expired', 'Redeclare work after lease expiry.', 409);
      return { state: intent.state, intent_id: intent.id, expires: Date.now() + leaseMs, blockers: [], next_actions: [] };
    } else if (input.action === 'cancel' || input.action === 'finish') {
      const intent = ownIntent(auth, input.intent_id); branch = intent.branch;
      // Finished local work is ready, not integrated or verified.
      const state = input.action === 'cancel' ? 'cancelled' : 'ready';
      db.prepare('UPDATE intents SET state=? WHERE id=?').run(state, intent.id);
      db.prepare('DELETE FROM claims WHERE intent_id=?').run(intent.id);
      data = { id: intent.id, state }; type = 'intent.changed';
    } else fail('unsupported_action', 'This response is not implemented in the local service.');
    const event = emit(auth, envelope, repoId, branch, type, data);
    return { state: data.state ?? 'accepted', ...data, blockers: data.blockers ?? [], next_actions: [], event };
  }
  function heartbeat(auth) {
    db.prepare(`UPDATE claims SET expires=? WHERE expires>? AND intent_id IN (SELECT id FROM intents WHERE run_id=? AND state IN ('active','blocked'))`).run(Date.now() + leaseMs, Date.now(), auth.id);
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (serveBoard(request, response)) return;
      const url = new URL(request.url, 'http://localhost');
      if (await humanAuth.handle(request, response, url)) return;
      if (request.method === 'GET' && url.pathname === '/health') { response.end(JSON.stringify({ ok: true, data: { service: 'gitpunk', mode: 'local-development', storage: 'sqlite', human_login: { configured: humanAuth.configured }, git: { configured: !!gitStore }, checks: { configured: !!checkPolicy }, kafka: dispatcher.status() }, error: null })); return; }
      const match = url.pathname.match(/^\/v1\/repos\/([^/]+)\/(work|checkpoints(?:\/[^/]+)?|commits(?:\/[^/]+(?:\/bundle)?)?|target(?:\/bundle)?|events|status|respond|git|changesets)$/);
      if (!match) fail('not_found', 'Route not found.', 404);
      const repoId = decodeURIComponent(match[1]), route = match[2];
      const auth = authenticate(request, repoId, request.method === 'POST' && route !== 'git');
      let data;
      if (request.method === 'POST' && ['work','checkpoints','respond','commits','git','changesets'].includes(route)) {
        const chunks = []; let bytes = 0;
        const limit = route === 'commits' ? 6 * 1024 * 1024 : 1_100_000;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) fail('body_too_large', 'Request exceeds the upload limit.', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('invalid_json', 'Request body must be JSON.'); }
        if (route === 'git') {
          if (!sourceStore || repoId !== gitStore.config.repo_id) fail('git_not_configured', 'Trusted Git source required.', 503);
          const input = validate(SourceQuery, body);
          data = await sourceStore.query(input, (file, directory) => checkReadScope(auth, file, directory));
          const current = authenticate(request, repoId);
          if (input.action === 'tree') { if (input.path) checkReadScope(current, input.path, true); for (const entry of data.entries) checkReadScope(current, entry.path, entry.type === 'tree'); }
          else if (input.action !== 'compare') for (const file of input.paths || [input.path]) checkReadScope(current, file);
        } else if (route === 'changesets') data = await serverCommit(request, auth, repoId, body);
        else data = route === 'commits' ? await upload(request, auth, repoId, body) : await mutation(request, auth, repoId, route, body);
      } else if (request.method === 'GET' && route === 'events') {
        const after = Number(url.searchParams.get('after') ?? url.searchParams.get('cursor') ?? 0), branch = url.searchParams.get('branch') ?? 'main';
        if (!Number.isSafeInteger(after) || after < 0) fail('invalid_cursor', 'Cursor must be a non-negative integer.');
        heartbeat(auth);
        const rows = db.prepare('SELECT * FROM events WHERE repo_id=? AND branch=? AND seq>? ORDER BY seq LIMIT 101').all(repoId, branch, after);
        const events = []; let bytes = 0;
        for (const row of rows.slice(0,100)) {
          const event = { event_id: row.event_id, repo_id: row.repo_id, branch: row.branch, seq: row.seq, cursor: row.seq, type: row.type, origin: parsed(row.envelope).signature ? 'agent' : 'server', run_id: row.run_id, actor: actor(row.run_id), payload: parsed(row.payload), signature: parsed(row.envelope).signature, signed: parsed(row.envelope), created_at: row.created_at };
          const size = Buffer.byteLength(JSON.stringify(event));
          if (events.length && bytes + size > 1_500_000) break;
          events.push(event); bytes += size;
        }
        data = { events, next_cursor: events.at(-1)?.seq ?? after, more: rows.length > events.length, poll_after_ms: 1000 };
      } else if (request.method === 'GET' && route.startsWith('checkpoints/')) {
        const checkpoint = db.prepare('SELECT c.data FROM checkpoints c JOIN intents i ON i.id=c.intent_id WHERE c.id=? AND i.repo_id=?').get(decodeURIComponent(route.slice(12)), repoId);
        if (!checkpoint) fail('not_found', 'Checkpoint not found.', 404);
        data = parsed(checkpoint.data);
        data.actor = actor(data.run_id);
      } else if (request.method === 'GET' && route.startsWith('commits/')) {
        const id = route.split('/')[1];
        const upload = db.prepare("SELECT * FROM uploads WHERE id=? AND repo_id=? AND state='uploaded'").get(id, repoId);
        if (!upload) fail('not_found', 'Accepted upload not found.', 404);
        data = { ...parsed(upload.data), actor: actor(upload.run_id) };
        if (route.endsWith('/bundle')) {
          if (data.provenance === 'server_commit') {
            const exported = await gitStore.exportCreated(id, data.base_commit, data.commit);
            const signed = parsed(upload.envelope);
            const proofs = signed.payload.checkpoint_ids.map(id => parsed(db.prepare('SELECT envelope FROM events WHERE event_id=? AND repo_id=?').get(`${id}:draft.changed`, repoId).envelope));
            data = { ...exported, provenance: 'server_commit', manifest: { ...data.manifest, bundle_hash: exported.bundle_hash }, signed, checkpoints: proofs, actor: actor(upload.run_id), public_key: data.public_key };
          } else data = { signed: parsed(upload.envelope), actor: actor(upload.run_id), public_key: parsed(upload.data).public_key, bundle_content: await gitStore.readBundle(id) };
          authenticate(request, repoId);
        }
      } else if (request.method === 'GET' && (route === 'target' || route === 'target/bundle')) {
        if (!gitStore || repoId !== 'demo') fail('git_not_configured', 'A canonical Git repository is not configured.', 503);
        if ((url.searchParams.get('branch') ?? 'main') !== gitStore.config.branch) fail('unsupported_target', 'This local server exposes only its configured canonical branch.', 409);
        data = await gitStore.targetSnapshot(route.endsWith('/bundle'));
        authenticate(request, repoId);
      } else if (request.method === 'GET' && route === 'status') {
        const branch = url.searchParams.get('branch') ?? 'main'; heartbeat(auth);
        const intents = db.prepare('SELECT * FROM intents WHERE repo_id=? AND branch=? ORDER BY created_at,id').all(repoId, branch).map(intentView);
        const claims = db.prepare('SELECT c.*,i.run_id FROM claims c JOIN intents i ON i.id=c.intent_id WHERE i.repo_id=? AND i.branch=? AND c.expires>?').all(repoId, branch, Date.now());
        const checkpoints = db.prepare('SELECT c.data FROM checkpoints c JOIN intents i ON i.id=c.intent_id WHERE i.repo_id=? AND i.branch=? ORDER BY c.created_at').all(repoId, branch).map(row => { const data = parsed(row.data); const { content, base_content, ...metadata } = data; return { ...metadata, actor: actor(data.run_id) }; });
        const decisions = db.prepare('SELECT * FROM decisions WHERE repo_id=? AND branch=? ORDER BY created_at').all(repoId, branch).map(row => ({ ...parsed(row.data), state: row.state, accepted_by: row.accepted_by }));
        const handoffs = db.prepare('SELECT * FROM handoffs WHERE repo_id=? AND branch=? ORDER BY created_at').all(repoId, branch).map(row => ({ ...parsed(row.data), state: row.state }));
        const uploads = db.prepare("SELECT data FROM uploads WHERE repo_id=? AND state='uploaded' ORDER BY rowid").all(repoId).map(row => parsed(row.data)).filter(item => item.branch === branch);
        const blockers = intents.filter(intent => intent.run_id === auth.id && ['active','blocked','lease_expired'].includes(intent.state)).flatMap(intent => intent.state === 'lease_expired' ? [{ type: 'lease_expired', intent_id: intent.id }] : peerOverlaps(intent.id, repoId, branch, intent.files).map(peer => ({ ...peer, type: 'overlap', intent_id: intent.id, peer_intent_id: peer.intent_id, peer_revision: peer.revision })));
        const write_permissions = Object.fromEntries(intents.filter(intent => intent.run_id === auth.id && ['active','blocked','lease_expired'].includes(intent.state)).flatMap(intent => intent.files.map(file => [file, auth.role === 'reader' ? [] : ['create','modify','delete','rename'].filter(operation => { try { checkScope(auth, file, operation); return true; } catch (error) { if (error instanceof ProtocolError) return false; throw error; } })])));
        const gitInfo = { configured: !!gitStore && repoId === 'demo' && branch === gitStore.config.branch };
        if (gitInfo.configured) { const target = gitStore.readRefSync('refs/heads/main'); Object.assign(gitInfo, { target, target_commit: target, target_ref: 'refs/heads/main', base_commit: gitStore.config.base_commit, branch: gitStore.config.branch }); }
        data = { state: blockers.length ? 'blocked' : 'connected', mode: 'local-development', run_id: auth.id, actor: actor(auth.id), branch, intents, claims, checkpoints, decisions, handoffs, uploads, blockers, write_permissions, next_actions: blockers.length ? ['respond:overlap'] : [], events_cursor: Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE repo_id=? AND branch=?').get(repoId, branch).n), git: gitInfo, kafka: dispatcher.status(), integration: coordinator.status({ repoId, branch }) };
      } else fail('method_not_allowed', 'Method is not supported.', 405);
      response.end(JSON.stringify({ ok: true, data, error: null }));
    } catch (error) {
      const status = error instanceof ProtocolError ? error.status : 500;
      response.statusCode = status;
      response.end(JSON.stringify({ ok: false, data: null, error: { code: error.code ?? 'internal_error', message: status === 500 ? 'Internal server error.' : error.message, ...(error.details ? { details: error.details } : {}) } }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    db, dataDir, fixture, dispatcher, gitStore, sourceStore, coordinator, humanAuth,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      const address = server.address(), endpoint = `http://127.0.0.1:${address.port}`;
      if (fixture) { fixture.endpoint = endpoint; await writeFile(path.join(dataDir, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 }); }
      await dispatcher.start();
      coordinator.start();
      return { endpoint, port: address.port, fixture_path: fixture ? path.join(dataDir, 'fixture.json') : undefined };
    },
    address() { const address = server.address(); return address && `http://127.0.0.1:${address.port}`; },
    async stop() { await coordinator.stop(); await dispatcher.stop(); if (server.listening) await new Promise(resolve => server.close(resolve)); db.close(); }
  };
}

async function seed(db, dataDir) {
  const fixturePath = path.join(dataDir, 'fixture.json');
  if (db.prepare('SELECT id FROM repos WHERE id=?').get('demo')) {
    try { return parsed(await readFile(fixturePath, 'utf8')); } catch { throw new Error('Existing local fixture has no credentials file; choose a fresh data directory.'); }
  }
  const identities = {};
  for (const [name, suffix] of [['alice','a'],['bob','b']]) {
    const keys = await generateKeyPair();
    identities[name] = { human_id: name, agent_id: `agent-${suffix}`, run_id: `run-${suffix}`, token: randomBytes(32).toString('base64url'), ...keys };
  }
  transaction(db, () => {
    for (const [name, identity] of Object.entries(identities)) db.prepare('INSERT INTO users(id,name) VALUES(?,?)').run(name, name);
    db.prepare("INSERT INTO repos(id,owner_id,visibility,branch) VALUES('demo','alice','private','main')").run();
    for (const identity of Object.values(identities)) {
      db.prepare('INSERT INTO access(repo_id,user_id,role) VALUES(?,?,?)').run('demo', identity.human_id, identity.human_id === 'alice' ? 'admin' : 'contributor');
      db.prepare('INSERT INTO agents(id,owner_id,label,public_key,key_expires) VALUES(?,?,?,?,?)').run(identity.agent_id, identity.human_id, identity.agent_id, JSON.stringify(identity.publicKey), Date.now() + 7 * 86400_000);
      db.prepare('INSERT INTO runs(id,agent_id,owner_id,repo_id,token_hash,scope,expires) VALUES(?,?,?,?,?,?,?)').run(identity.run_id, identity.agent_id, identity.human_id, 'demo', digest(identity.token), JSON.stringify({ files: ['**'], operations: ['create','modify','delete','rename'] }), Date.now() + 7 * 86400_000);
    }
  });
  const fixture = { mode: 'local-development', repository_id: 'demo', branch: 'main', identities };
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
  return fixture;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
  const checkConfig = option('check-config');
  const oidcFile = option('oidc-config');
  const app = await createGitpunkServer({ dataDir: option('data-dir', '.local/server'), port: Number(option('port', 8787)), bootstrap: args.includes('--bootstrap'), gitSource: option('git-source'), checkPolicy: checkConfig ? parsed(await readFile(checkConfig, 'utf8')) : undefined, oidcConfig: oidcFile ? await readOidcConfig(oidcFile) : undefined, kafkaBrokers: (option('kafka-brokers', '')).split(',').filter(Boolean) });
  const started = await app.start();
  process.stdout.write(JSON.stringify({ ...started, mode: 'local-development' }) + '\n');
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, async () => { await app.stop(); process.exit(0); });
}
