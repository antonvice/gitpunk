import { readFile, mkdir, open, unlink, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hashContent, hashBytes, canonicalJson, signEnvelope, verifyEnvelope, SafePath, IntentInput, WorkRequest, CheckpointInput, RespondInput, GitUpload, CommitUploadEnvelope, BundleContent, CheckResult, TargetBundle } from '../shared/index.js';
import { ClientStore } from './store.js';
import { withProfile } from './profile.js';
import { git, head, atCommit, snapshot, restoreCheckpoints, committedFiles, exportCommitBundle, fetchCommitBundle, pinTargetCommit } from './git.js';

export class ClientError extends Error {
  constructor(message, { code = 'client_error', status = 0, next_actions = [] } = {}) { super(message); this.code = code; this.status = status; this.next_actions = next_actions; }
}

export async function clientOptions(options = {}) {
  options = await withProfile(options);
  let fixture = {}, identity = {};
  if (options.credentials) {
    fixture = JSON.parse(await readFile(resolve(options.credentials), 'utf8'));
    identity = fixture.identities?.[options.identity || 'alice'];
    if (!identity) throw new ClientError('Unknown fixture identity.', { code: 'identity_missing' });
  }
  const workspace = await realpath(resolve(options.workspace || process.cwd()));
  const workspaceId = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  const resolved = {
    ...options,
    server: options.server || fixture.endpoint || 'http://127.0.0.1:8787',
    repo: options.repo || fixture.repository_id || 'demo',
    run: options.run || identity.run_id,
    token: options.token || identity.token,
    privateKey: options.privateKey || identity.privateKey,
    workspace,
    workspaceId,
    branch: options.branch || 'main',
    stateDir: resolve(options.stateDir || join(homedir(), 'Library', 'Application Support', 'Gitpunk', workspaceId)),
    pollMs: Number(options.pollMs || 1000),
    debounceMs: Number(options.debounceMs ?? 150),
  };
  if (options.tokenFile) resolved.token = (await readFile(resolve(options.tokenFile), 'utf8')).trim();
  if (options.keyFile) resolved.privateKey = JSON.parse(await readFile(resolve(options.keyFile), 'utf8'));
  if (!resolved.run || !resolved.token || !resolved.privateKey) throw new ClientError('Provide a registered run, token file and private key file, or development credentials.', { code: 'credentials_missing' });
  const url = new URL(resolved.server);
  if (url.username || url.password) throw new ClientError('Use a token file; do not place credentials in the server URL.', { code: 'url_credentials' });
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new ClientError('HTTP is only allowed for loopback development servers.', { code: 'insecure_server' });
  resolved.server = resolved.server.replace(/\/$/, '');
  return resolved;
}

export class GitpunkClient {
  static async create(options) { return new GitpunkClient(await clientOptions(options)); }
  constructor(options) {
    this.options = options;
    this.store = new ClientStore(join(options.stateDir, 'client.sqlite'));
    this.observations = new Map();
    this.baselines = new Map();
    this.closed = false;
    const owner = this.store.get('owner');
    if (owner && (owner.run !== options.run || owner.repo !== options.repo || owner.workspace !== options.workspace || owner.server !== options.server || owner.branch !== options.branch)) { this.store.close(); throw new ClientError('State directory belongs to another workspace, branch or run.', { code: 'state_owner_mismatch' }); }
    this.store.set('owner', { run: options.run, repo: options.repo, workspace: options.workspace, server: options.server, branch: options.branch });
    if (options.upload !== undefined) this.store.set('auto_upload', Boolean(options.upload));
    if (options.noUpload) this.store.set('auto_upload', false);
  }
  async request(route, envelope = null) {
    const url = `${this.options.server}/v1/repos/${encodeURIComponent(this.options.repo)}/${route}`;
    let response;
    try {
      response = await fetch(url, { method: envelope ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.options.token}`, ...(envelope ? { 'Content-Type': 'application/json' } : {}) }, body: envelope && JSON.stringify(envelope), signal: AbortSignal.timeout(10_000) });
    } catch { throw new ClientError('Server unavailable; publications remain queued.', { code: 'offline' }); }
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new ClientError('Server response exceeded client limit.', { code: 'response_too_large' });
    let body;
    try { body = JSON.parse(text); } catch { throw new ClientError('Server returned invalid JSON.', { code: 'invalid_response', status: response.status }); }
    if (!response.ok) throw new ClientError(body.error?.message || body.message || 'Request rejected.', { code: body.error?.code || body.code || 'rejected', status: response.status, next_actions: body.next_actions || body.error?.next_actions || [] });
    return body.data ?? body;
  }
  async enqueue(route, payload, attachment = null) {
    let envelope = await signEnvelope(payload, { eventId: randomUUID(), runId: this.options.run, privateKey: this.options.privateKey });
    if (attachment) {
      if (route !== 'commits') throw new ClientError('Attachments are only supported for commit bundles.');
      envelope = CommitUploadEnvelope.parse({ ...envelope, ...attachment });
    }
    this.store.queue(route, envelope);
    return envelope.event_id;
  }
  async flush() {
    for (const item of this.store.pending()) {
      if (item.route === 'commits' && !this.store.get('auto_upload', false)) continue;
      try {
        const response = await this.request(item.route, item.envelope);
        this.store.sent(item.id, response);
        if (item.route === 'work') this.acceptWork(response, item.envelope.payload);
        if (item.route === 'checkpoints') this.store.set(`published:${item.envelope.payload.path}`, { hash: item.envelope.payload.result_hash, intent_id: item.envelope.payload.intent_id, revision: item.envelope.payload.intent_revision });
        if (item.route === 'respond' && item.envelope.payload.action === 'handoff_accept') this.acceptHandoff(response);
        if (item.route === 'respond' && item.envelope.payload.action === 'ack') this.store.consume(item.envelope.payload.event_seq);
        if (item.route === 'commits') this.acceptCommit(response, item.envelope);
        this.store.set('connection', { state: 'connected', at: new Date().toISOString(), error: null });
      } catch (error) {
        const permanent = error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        this.store.failed(item.id, { code: error.code || 'client_error', message: error.message, next_actions: error.next_actions || [] }, permanent);
        if (item.route === 'commits' && permanent) this.recordUpload(item.envelope.payload, { upload: 'rejected', upload_id: item.id, error: { code: error.code, message: error.message } });
        this.store.set('connection', { state: error.code === 'offline' ? 'disconnected' : 'blocked', at: new Date().toISOString(), error: { code: error.code, message: error.message } });
        if (!permanent) break;
      }
    }
  }
  acceptWork(response, request) {
    const accepted = response.intent || response.result?.intent || response;
    const id = accepted.id || accepted.intent_id;
    if (!id) return;
    this.store.set('work', { ...request, id, revision: accepted.revision || response.revision || 1, state: accepted.state || response.state || 'active', accepted });
  }
  acceptHandoff(response) {
    const continuation = response.intent;
    if (continuation) this.acceptWork(response, { intent: Object.fromEntries(['title', 'type', 'summary', 'files', 'done_when', 'sharing', 'prompt', 'context'].filter(key => continuation[key] !== undefined).map(key => [key, continuation[key]])), base_commit: continuation.base_commit, workspace_id: this.options.workspaceId, branch: this.options.branch });
    this.store.set('import', { ...this.store.get('import'), state: 'accepted', decision_ids: response.decision_ids || [], remaining_criteria: response.remaining_criteria || [], continuation_intent_id: continuation?.id });
  }
  uploadKey(payload) { return `upload:${payload.intent_id}:${payload.intent_revision}:${payload.commit}`; }
  recordUpload(payload, result) {
    this.store.set(this.uploadKey(payload), result);
    const current = this.store.get('commit');
    if (current?.commit === payload.commit && current?.intent_id === payload.intent_id) this.store.set('commit', { ...current, ...result, verification: 'unverified' });
  }
  acceptCommit(response, envelope) {
    this.recordUpload(envelope.payload, { upload: 'uploaded', upload_id: response.id || envelope.event_id, git_ref: response.git_ref, bundle_hash: envelope.payload.bundle_hash });
  }
  async work(intent) {
    if (this.store.get('work')) await this.remoteStatus().catch(error => { if (error.code !== 'offline') throw error; });
    const stored = this.store.get('work');
    const existing = stored && !['cancelled', 'handed_off', 'ready', 'complete', 'completed'].includes(stored.state) ? stored : null;
    const payload = WorkRequest.parse({ intent, base_commit: existing?.base_commit || await head(this.options.workspace), workspace_id: this.options.workspaceId, branch: this.options.branch, ...(existing ? { id: existing.id, expected_revision: existing.revision } : {}) });
    const id = await this.enqueue('work', payload);
    await this.flush();
    const result = this.store.result(id);
    if (result.status === 'rejected') throw new ClientError(result.error.message, result.error);
    return result.status === 'sent' ? result.response : { state: 'pending', event_id: id, blockers: ['offline'], next_actions: ['start sync when the server is available'] };
  }
  async remoteStatus() {
    const remote = await this.request(`status?branch=${encodeURIComponent(this.options.branch)}`);
    this.store.set('remote', remote);
    const own = remote.intents?.find(intent => (intent.run_id === this.options.run || intent.runId === this.options.run) && intent.id === this.store.get('work')?.id);
    if (own) this.store.set('work', { ...this.store.get('work'), state: own.state, accepted: own });
    for (const upload of remote.uploads || []) {
      const pending = this.peerFetchRecord(upload, upload.actor?.run_id || upload.signed?.run_id);
      if (pending) this.store.set(pending.key, pending.value);
    }
    const target = remote.git?.target_commit;
    if (target && this.store.get('target')?.commit !== target) this.store.set('target', { commit: target, base_commit: remote.git.base_commit, state: 'pending', attempts: 0, retry_after: 0, git_ref: null });
    this.updateCommitEvidence(remote);
    return remote;
  }
  peerFetchRecord(upload, run) {
    const work = this.store.get('work');
    if (!work || !['active', 'blocked', 'ready', 'lease_expired'].includes(work.state) || run === this.options.run) return null;
    const id = upload.id;
    const files = upload.manifest?.files || upload.files || [];
    if (!id || !files.some(file => work.intent.files.includes(typeof file === 'string' ? file : file.path))) return null;
    const key = `peer_fetch:${id}`;
    return this.store.get(key) ? null : { key, value: { commit_id: id, state: 'pending', attempts: 0, retry_after: 0, relevant_intent_id: work.id } };
  }
  updateCommitEvidence(remote) {
    const commit = this.store.get('commit');
    if (!commit?.upload_id) return;
    const upload = remote.uploads?.find(item => item.id === commit.upload_id && item.commit === commit.commit && item.actor?.run_id === this.options.run);
    if (!upload) return;
    const submission = remote.integration?.submissions?.find(item => item.id === upload.id);
    const check = remote.integration?.checks?.find(item => item.id === submission?.check_id && item.submission_id === upload.id);
    const parsed = check?.result && CheckResult.safeParse(check.result);
    const evidence = parsed?.success ? parsed.data : null;
    const checked = check?.state === 'passed' && evidence?.state === 'passed' && evidence.candidate === check.candidate && evidence.target === check.target && evidence.policy_hash === check.policy_hash;
    const operation = remote.integration?.operations?.find(item => item.submission_id === upload.id && item.check_id === check?.id && item.state === 'integrated' && item.candidate === check?.candidate && item.target === check?.target);
    const integrated = Boolean(checked && submission?.state === 'integrated' && operation);
    this.store.set('commit', { ...commit, upload: 'uploaded', checked: Boolean(checked), integrated, verification: integrated ? 'integrated' : checked ? 'checked' : 'unverified', check: check ? { id: check.id, state: check.state, candidate: check.candidate, target: check.target, policy_hash: check.policy_hash, image_digest: evidence?.image_digest } : null, integration: operation || null, submission: submission ? { id: submission.id, state: submission.state, reason: submission.reason } : null });
  }
  async poll() {
    const cursor = this.store.get('cursor', 0);
    const response = await this.request(`events?after=${cursor}&branch=${encodeURIComponent(this.options.branch)}`);
    const pending = (response.events || []).filter(event => event.type === 'commit.uploaded').map(event => this.peerFetchRecord(event.payload, event.run_id)).filter(Boolean);
    this.store.receive(response.events || [], Math.max(cursor, response.next_cursor ?? cursor), pending);
    this.store.set('connection', { state: 'connected', at: new Date().toISOString(), error: null });
    return response;
  }
  async fetchPeerUpdates() {
    for (const item of this.store.entries('peer_fetch:').filter(item => item.value.state === 'pending' && item.value.retry_after <= Date.now()).slice(0, 4)) {
      try { await this.fetchUploadedCommit(item.value.commit_id); }
      catch (error) {
        const attempts = item.value.attempts + 1;
        this.store.set(item.key, { ...item.value, attempts, retry_after: Date.now() + Math.min(this.options.pollMs * 2 ** Math.min(attempts, 5), 30_000), error: { code: error.code || 'peer_fetch_failed', message: error.message } });
      }
    }
  }
  async fetchTargetUpdate() {
    const pending = this.store.get('target');
    if (!pending || pending.state !== 'pending' || pending.retry_after > Date.now()) return;
    try {
      const { bundle_content, ...metadata } = TargetBundle.parse(await this.request(`target/bundle?branch=${encodeURIComponent(this.options.branch)}`));
      if (metadata.branch !== this.options.branch) throw new ClientError('Canonical target belongs to another branch.', { code: 'target_branch_mismatch' });
      if (metadata.base_commit !== pending.base_commit) throw new ClientError('Canonical repository baseline changed; reconnect to its trusted source.', { code: 'target_base_changed' });
      const ref = `refs/gitpunk/targets/${metadata.branch}`;
      if (metadata.commit === metadata.base_commit) {
        await pinTargetCommit(this.options.workspace, metadata.branch, metadata.commit);
      } else {
        const bytes = Buffer.from(bundle_content, 'base64');
        if (await hashBytes(bytes) !== metadata.bundle_hash) throw new ClientError('Canonical bundle differs from its authenticated hash.', { code: 'target_hash_mismatch' });
        await fetchCommitBundle(this.options.workspace, bytes, metadata.commit, `target-${metadata.commit}`, metadata, ref);
      }
      this.store.set('target', { ...metadata, state: 'fetched', git_ref: ref, applied: false });
    } catch (error) {
      const attempts = pending.attempts + 1;
      this.store.set('target', { ...pending, attempts, retry_after: Date.now() + Math.min(this.options.pollMs * 2 ** Math.min(attempts, 5), 30_000), error: { code: error.code || 'target_fetch_failed', message: error.message } });
    }
  }
  async observeFiles() {
    const work = this.store.get('work');
    if (!work || work.state !== 'active') return;
    for (const path of work.intent.files) {
      try {
        const captured = await snapshot(this.options.workspace, path);
        if (captured.unstable) continue;
        this.store.remove(`file_error:${path}`);
        const hash = captured.content === null ? null : await hashContent(captured.content);
        const baseKey = `${work.base_commit}:${path}`;
        if (!this.baselines.has(baseKey)) this.baselines.set(baseKey, await atCommit(this.options.workspace, work.base_commit, path));
        const baseContent = this.baselines.get(baseKey);
        const baseHash = baseContent === null ? null : await hashContent(baseContent);
        const previous = this.store.get(`published:${path}`);
        if ((previous?.intent_id === work.id && previous.revision === work.revision && previous.hash === hash) || (!previous && hash === baseHash)) continue;
        const observed = this.observations.get(path);
        if (!observed || observed.hash !== hash) { this.observations.set(path, { hash, since: Date.now() }); continue; }
        if (Date.now() - observed.since < this.options.debounceMs) continue;
        const payload = CheckpointInput.parse({ intent_id: work.id, intent_revision: work.revision, path, operation: captured.content === null ? 'delete' : baseContent === null ? 'create' : 'modify', base_hash: baseHash, result_hash: hash, content: captured.content, base_content: baseContent, workspace_id: this.options.workspaceId, base_commit: work.base_commit, branch: this.options.branch });
        const pending = this.store.pending().find(item => item.route === 'checkpoints' && item.envelope.payload.intent_id === work.id && item.envelope.payload.path === path && item.envelope.payload.result_hash === hash);
        if (!pending) await this.enqueue('checkpoints', payload);
      } catch (error) { this.store.set(`file_error:${path}`, { path, message: error.message }); }
    }
  }
  async observeCommit() {
    const commit = await head(this.options.workspace);
    const previous = this.store.get('head');
    const work = this.store.get('work');
    const enabled = this.store.get('auto_upload', false);
    if (previous && previous !== commit) {
      const files = (await git(this.options.workspace, 'diff', '--name-only', previous, commit)).split('\n').filter(Boolean);
      this.store.set('commit', { commit, previous, intent_id: work?.id || null, files, state: 'committed', observed_at: new Date().toISOString(), upload: enabled ? 'pending' : 'disabled', verification: 'unverified' });
    }
    this.store.set('head', commit);
    if (!enabled && this.store.get('commit')?.upload === 'pending') this.store.set('commit', { ...this.store.get('commit'), upload: 'disabled', queued: true });
    if (!enabled || !work || work.state !== 'active' || commit === work.base_commit) return;
    const key = this.uploadKey({ intent_id: work.id, intent_revision: work.revision, commit });
    const recorded = this.store.get(key);
    if (recorded) {
      if (this.store.get('commit')?.commit === commit) this.store.set('commit', { ...this.store.get('commit'), ...recorded });
      return;
    }
    try {
      const files = await committedFiles(this.options.workspace, work.base_commit, commit);
      if (!files.length) return;
      const exported = await exportCommitBundle(this.options.workspace, work.base_commit, commit);
      const payload = GitUpload.parse({ intent_id: work.id, intent_revision: work.revision, branch: this.options.branch, workspace_id: this.options.workspaceId, base_commit: work.base_commit, commit, bundle_hash: exported.bundle_hash, files });
      this.store.set('commit', { commit, previous: previous || work.base_commit, intent_id: work.id, files: files.map(file => file.path), manifest: payload, state: 'committed', observed_at: new Date().toISOString(), upload: 'pending', verification: 'unverified' });
      const id = await this.enqueue('commits', payload, { bundle_content: exported.bundle_content });
      this.recordUpload(payload, { upload: 'pending', upload_id: id });
    } catch (error) {
      this.store.set('commit', { ...(this.store.get('commit') || { commit, intent_id: work.id, state: 'committed' }), upload: 'rejected', verification: 'unverified', error: { code: error.code || 'upload_prepare_failed', message: error.message } });
      this.store.set(key, { upload: 'rejected', error: { code: error.code || 'upload_prepare_failed', message: error.message } });
    }
  }
  async tick() {
    await this.flush();
    try {
      await this.remoteStatus();
      const work = this.store.get('work');
      if (work?.state === 'active' && Date.now() - this.store.get('renewed_at', 0) > 30_000) {
        await this.enqueue('respond', { action: 'renew', intent_id: work.id });
        this.store.set('renewed_at', Date.now());
      }
      await this.observeFiles();
      await this.observeCommit();
      await this.flush();
      const response = await this.poll();
      await this.fetchTargetUpdate();
      await this.fetchPeerUpdates();
      return response;
    } catch (error) { this.store.set('connection', { state: 'disconnected', at: new Date().toISOString(), error: { code: error.code || 'client_error', message: error.message } }); return { state: 'disconnected', next_actions: ['retry sync'] }; }
  }
  async status({ refresh = true } = {}) {
    if (refresh) await this.remoteStatus().catch(error => this.store.set('connection', { state: 'disconnected', error: { code: error.code, message: error.message } }));
    return { connection: this.store.get('connection', { state: 'unknown' }), work: this.store.get('work'), auto_upload: this.store.get('auto_upload', false), counts: this.store.counts(), cursor: this.store.get('cursor', 0), inbox: this.store.inbox(), errors: [...this.store.errors(), ...this.store.fileErrors()], commit: this.store.get('commit'), target: this.store.get('target'), fetched: this.store.get('fetched'), peer_updates: this.store.entries('peer_fetch:').map(item => item.value), imported: this.store.get('import'), server: this.store.get('remote'), next_actions: this.store.get('connection')?.state === 'disconnected' ? ['start sync when the server is available'] : [] };
  }
  async respond(payload) {
    if (payload?.action === 'prepare_write') return this.prepareWrite(payload);
    payload = RespondInput.parse(payload);
    if (payload.action === 'handoff_accept') return this.importHandoff({ ...payload, workspace_id: this.options.workspaceId });
    if (payload.action === 'fetch_commit') return this.fetchUploadedCommit(payload.commit_id);
    const id = await this.enqueue('respond', payload);
    await this.flush();
    const result = this.store.result(id);
    if (result.status === 'rejected') throw new ClientError(result.error.message, result.error);
    if (payload.action === 'ack' && result.status === 'sent') this.store.consume(payload.event_seq);
    if (result.status === 'sent') await this.remoteStatus();
    return result.response || { state: 'pending', event_id: id };
  }
  async prepareWrite(payload) {
    const files = payload.files;
    if (Object.keys(payload).some(key => !['action', 'files'].includes(key)) || !Array.isArray(files) || !files.length || files.length > 128 || new Set(files).size !== files.length || files.some(file => !SafePath.safeParse(file).success || file.includes('*'))) throw new ClientError('Provide 1–128 unique concrete repository paths.', { code: 'invalid_write_scope' });
    const local = this.store.get('work');
    if (!local?.id) throw new ClientError('Declare work before preparing a write.', { code: 'intent_missing', next_actions: ['work'] });
    const checkPending = () => { if (this.store.db.prepare("SELECT 1 FROM outbox WHERE route='work' AND status='pending' LIMIT 1").get()) throw new ClientError('Intent changes are still queued; sync them before preparing a write.', { code: 'intent_pending', next_actions: ['start'] }); };
    checkPending();
    let events, remote;
    try { events = await this.poll(); remote = await this.remoteStatus(); }
    catch (error) {
      this.store.set('connection', { state: error.code === 'offline' ? 'disconnected' : 'blocked', at: new Date().toISOString(), error: { code: error.code || 'client_error', message: error.message } });
      throw error;
    }
    checkPending();
    if (remote.run_id !== this.options.run || remote.branch !== this.options.branch || !Number.isSafeInteger(remote.events_cursor) || remote.events_cursor < 0) throw new ClientError('Server did not provide a current snapshot for this run and branch.', { code: 'readiness_unknown' });
    const own = remote.intents?.find(intent => intent.id === local.id && intent.run_id === this.options.run);
    if (!own) throw new ClientError('Declared intent is missing from the current server snapshot.', { code: 'intent_missing', next_actions: ['work'] });
    const definition = IntentInput.safeParse(Object.fromEntries(Object.keys(IntentInput.shape).filter(key => own[key] !== undefined).map(key => [key, own[key]])));
    const current = this.store.get('work');
    if (!definition.success || own.revision !== local.revision || own.base_commit !== local.base_commit || own.workspace_id !== this.options.workspaceId || own.branch !== this.options.branch || canonicalJson(definition.data) !== canonicalJson(local.intent) || current.id !== local.id || current.revision !== local.revision || canonicalJson(current.intent) !== canonicalJson(local.intent)) throw new ClientError('Own intent changed; redeclare work from its current revision before writing.', { code: 'stale_intent', next_actions: ['work'] });
    if (files.some(file => !own.files.includes(file))) throw new ClientError('Requested files must be explicitly declared in the intent.', { code: 'outside_intent', next_actions: ['work'] });
    if (!remote.write_permissions || files.some(file => !Array.isArray(remote.write_permissions[file]))) throw new ClientError('Server did not provide current file permissions.', { code: 'readiness_unknown' });
    if (files.some(file => !remote.write_permissions[file].includes('modify'))) throw new ClientError('Current run or repository permissions deny this file.', { code: 'scope_denied' });
    const live = new Set((remote.claims || []).filter(claim => claim.expires > Date.now()).map(claim => claim.intent_id));
    const relevantPath = path => path.includes('*') || files.includes(path);
    const relevant = (remote.intents || []).filter(intent => intent.id !== own.id && intent.files?.some(relevantPath)).sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)));
    const relevantIds = new Set([own.id, ...relevant.map(intent => intent.id)]);
    const blockers = remote.blockers;
    if (!Array.isArray(blockers)) throw new ClientError('Server did not provide current overlap readiness.', { code: 'readiness_unknown' });
    if (blockers.some(blocker => blocker.type === 'overlap' && (!blocker.path || relevantPath(blocker.path) || relevantIds.has(blocker.peer_intent_id)))) throw new ClientError('Acknowledge the current overlapping intent before writing.', { code: 'overlap', next_actions: ['respond:overlap'] });
    if (own.state === 'lease_expired' || files.some(file => !(remote.claims || []).some(claim => claim.intent_id === own.id && claim.generation === own.revision && claim.expires > Date.now() && claim.path === file))) throw new ClientError('Own file claims expired; redeclare work before writing.', { code: 'lease_expired', next_actions: ['work'] });
    if (own.state !== 'active') throw new ClientError('Own intent is not active for writing.', { code: 'intent_not_active', next_actions: ['work'] });
    const limits = { peers: 16, checkpoints: 32, decisions: 16, files_per_peer: 32, text_chars: 512 };
    const truncation = { peers: Math.max(0, relevant.length - limits.peers), checkpoints: 0, decisions: 0, files: 0, text_fields: 0 };
    const text = (value, limit = limits.text_chars) => { const raw = String(value ?? ''); if (raw.length > limit) truncation.text_fields++; return raw.slice(0, limit); };
    const actor = value => Object.fromEntries(['run_id', 'agent_id', 'owner_id'].filter(key => value?.[key] !== undefined).map(key => [key, text(value[key], 128)]));
    const peers = relevant.slice(0, limits.peers).map(intent => {
      const scope = intent.files.filter(relevantPath);
      truncation.files += Math.max(0, scope.length - limits.files_per_peer);
      return { id: text(intent.id, 128), revision: intent.revision, state: intent.state, type: intent.type, title: text(intent.title, 160), summary: text(intent.summary), files: scope.slice(0, limits.files_per_peer), actor: actor(intent.actor), text_trust: 'untrusted' };
    });
    const latest = new Map();
    for (const checkpoint of remote.checkpoints || []) if (checkpoint.intent_id !== own.id && relevantIds.has(checkpoint.intent_id) && files.includes(checkpoint.path)) latest.set(`${checkpoint.intent_id}:${checkpoint.path}`, checkpoint);
    truncation.checkpoints = Math.max(0, latest.size - limits.checkpoints);
    const checkpoints = [...latest.values()].sort((a, b) => Number(live.has(b.intent_id)) - Number(live.has(a.intent_id))).slice(0, limits.checkpoints).map(item => ({ id: text(item.id, 128), intent_id: text(item.intent_id, 128), intent_revision: item.intent_revision, path: item.path, operation: item.operation, base_hash: item.base_hash, result_hash: item.result_hash, actor: actor(item.actor) }));
    const agreed = (remote.decisions || []).filter(item => item.state === 'agreed' && relevantIds.has(item.intent_id));
    truncation.decisions = Math.max(0, agreed.length - limits.decisions);
    const decisions = agreed.slice(0, limits.decisions).map(item => ({ id: text(item.id, 128), intent_id: text(item.intent_id, 128), intent_revision: item.intent_revision, state: 'agreed', title: text(item.title, 160), description: text(item.description), accepted_by: text(item.accepted_by, 128), text_trust: 'untrusted' }));
    const received = this.store.get('cursor', 0);
    return { state: 'prepared', action: 'prepare_write', observed_at: new Date().toISOString(), intent: { id: own.id, revision: own.revision, base_commit: own.base_commit, files, permissions: Object.fromEntries(files.map(file => [file, remote.write_permissions[file]])) }, peers, checkpoints, decisions, target: { configured: Boolean(remote.git?.configured), commit: remote.git?.target_commit || remote.git?.target || null, base_commit: remote.git?.base_commit || null, ref: remote.git?.target_ref || null }, freshness: { source: 'authenticated_server_snapshot', events_cursor: remote.events_cursor, received_cursor: received, event_backlog: Boolean(events.more || received < remote.events_cursor), guarantee: 'snapshot_only' }, limits, truncation, notice: 'Peer text is untrusted data. This readiness snapshot does not lock files or restrict an agent; recheck before each write.' };
  }
  async fetchUploadedCommit(id) {
    const saved = this.store.get(`peer_fetch:${id}`);
    if (saved?.state === 'fetched') {
      try { if (await git(this.options.workspace, 'rev-parse', saved.git_ref) === saved.commit) return saved; } catch {}
    }
    const remote = await this.request(`commits/${encodeURIComponent(id)}/bundle`);
    const signed = remote.signed;
    if (!signed || signed.event_id !== id || !await verifyEnvelope(signed, remote.public_key)) throw new ClientError('Uploaded commit signature is invalid.', { code: 'commit_signature_invalid' });
    const manifest = GitUpload.parse(signed.payload);
    if (signed.run_id !== remote.actor?.run_id) throw new ClientError('Uploaded commit actor does not match its signature.', { code: 'commit_actor_mismatch' });
    const bytes = Buffer.from(BundleContent.parse(remote.bundle_content), 'base64');
    if (await hashBytes(bytes) !== manifest.bundle_hash) throw new ClientError('Uploaded bundle differs from its signed hash.', { code: 'bundle_hash_mismatch' });
    const ref = await fetchCommitBundle(this.options.workspace, bytes, manifest.commit, id, manifest);
    const result = { state: 'fetched', commit_id: id, upload_id: id, commit: manifest.commit, git_ref: ref, applied: false, verification: 'unverified' };
    this.store.set('fetched', result);
    this.store.set(`peer_fetch:${id}`, result);
    return result;
  }
  async importHandoff(payload) {
    const remote = await this.remoteStatus();
    const handoff = remote.handoffs?.find(item => item.id === payload.handoff_id);
    if (!handoff) throw new ClientError('Handoff is unavailable.', { code: 'handoff_missing' });
    if (handoff.to_run_id !== this.options.run || !['offered', 'pending'].includes(handoff.state)) throw new ClientError('Handoff is not offered to this run.', { code: 'handoff_not_available' });
    const raw = handoff.checkpoints || (handoff.checkpoint_ids
      ? await Promise.all(handoff.checkpoint_ids.map(id => this.request(`checkpoints/${encodeURIComponent(id)}`).then(value => value.checkpoint || value)))
      : [remote.checkpoints?.find(item => (item.id || item.checkpoint_id) === handoff.checkpoint_id)].filter(Boolean));
    if (!raw.length) throw new ClientError('Exact handoff checkpoints are unavailable.', { code: 'checkpoint_missing' });
    const checkpoints = raw.map(item => CheckpointInput.parse(Object.fromEntries(Object.entries(item).filter(([key]) => Object.hasOwn(CheckpointInput.shape, key)))));
    if (new Set(checkpoints.map(item => item.path)).size !== checkpoints.length) throw new ClientError('Handoff contains duplicate paths.', { code: 'checkpoint_invalid' });
    for (const checkpoint of checkpoints) {
      const hash = checkpoint.content === null ? null : await hashContent(checkpoint.content);
      if (hash !== checkpoint.result_hash) throw new ClientError('Handoff content hash does not match.', { code: 'checkpoint_hash_mismatch' });
      const base = await atCommit(this.options.workspace, checkpoint.base_commit, checkpoint.path);
      const baseHash = base === null ? null : await hashContent(base);
      if (baseHash !== checkpoint.base_hash) throw new ClientError('Handoff baseline differs from its exact Git commit.', { code: 'checkpoint_base_mismatch' });
    }
    const branch = `gitpunk/handoff-${payload.handoff_id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`;
    await restoreCheckpoints(this.options.workspace, checkpoints, branch);
    const id = await this.enqueue('respond', payload);
    this.store.set('import', { handoff_id: payload.handoff_id, checkpoint_ids: raw.map(item => item.id || item.checkpoint_id), branch, state: 'restored_pending_ack' });
    await this.flush();
    const result = this.store.result(id);
    if (result.status === 'rejected') throw new ClientError('Checkpoint restored locally, but server did not accept the handoff. Inspect status before continuing.', result.error);
    this.store.set('import', { ...this.store.get('import'), state: result.status === 'sent' ? 'accepted' : 'restored_pending_ack' });
    if (result.status === 'sent') {
      this.acceptHandoff(result.response);
      await this.remoteStatus();
    }
    return { ...(result.response || { state: 'pending' }), imported_branch: branch };
  }
  async acquireLock() {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.options.stateDir, 'sync.pid');
    try { const lock = await open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close(); this.lockPath = path; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      try { process.kill(pid, 0); } catch (cause) { if (cause.code === 'ESRCH') { await unlink(path); return this.acquireLock(); } throw cause; }
      throw new ClientError('A sync service already owns this workspace.', { code: 'sync_already_running' });
    }
  }
  async start({ signal, onTick } = {}) {
    await this.acquireLock();
    try {
      while (!this.closed && !signal?.aborted) {
        await this.tick();
        if (onTick) await onTick(await this.status({ refresh: false }));
        const wait = this.store.get('connection')?.state === 'disconnected' ? Math.min(this.options.pollMs * 5, 30_000) : this.options.pollMs;
        try { await delay(wait, undefined, { signal }); } catch (error) { if (error.name !== 'AbortError') throw error; }
      }
    } finally { if (this.lockPath) { await unlink(this.lockPath).catch(() => {}); this.lockPath = null; } }
  }
  close() { this.closed = true; this.store.close(); }
}
