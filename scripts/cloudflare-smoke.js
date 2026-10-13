import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, mkdir, mkdtemp, rm, open, rename, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile), project = fileURLToPath(new URL('..', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const validName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const binary = Buffer.from([0, 255, 254, 10, 128, 1, 2, 3, 13, 0, 195, 40]);
const TTL = 600, TIMEOUT = 45_000;
const LIMITS = { bridge_requests: 40, git_remote_commands: 20, fixture_bytes: 64 * 1024 };
const EVIDENCE = ['missing_and_invalid_bridge_credentials_denied', 'write_token_git_push', 'fresh_read_clone_and_exact_binding_commit_binary', 'read_token_real_new_push_denied', 'fork_change_isolated_and_fork_token_canonical_push_denied', 'all_issued_tokens_revoked_and_fresh_git_requests_denied'];
class SmokeError extends Error { constructor(code) { super(code); this.code = code; } }
const ensure = (condition, code) => { if (!condition) throw new SmokeError(code); };
const gitEnv = (remote, token) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].includes(key)));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GIT_ALLOW_PROTOCOL: 'https', GIT_NO_REPLACE_OBJECTS: '1' });
  const config = [['credential.helper', ''], ['credential.interactive', 'false'], ['core.hooksPath', '/dev/null'], ['http.followRedirects', 'false'], ['http.sslVerify', 'true'], ['http.extraHeader', '']];
  if (token) config.push([`http.${remote}.extraHeader`, `Authorization: Bearer ${token}`]);
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return env;
};
async function git(directory, args, { remote, token, denial = false, date } = {}) {
  const env = gitEnv(remote, token);
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  try {
    const result = await exec('git', ['-C', directory, ...args], { env, timeout: TIMEOUT, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
    ensure(!denial, 'remote_unexpectedly_allowed');
    return result.stdout;
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    if (denial && Number.isInteger(error.code) && /requested URL returned error: (401|403)|authentication failed|HTTP (401|403)|403 Forbidden|Unauthorized|not authorized/i.test(error.stderr?.toString() ?? '')) return null;
    throw new SmokeError(denial ? 'remote_denial_unproven' : 'git_operation_failed');
  }
}
async function protectedFile(file, mustExist = true) {
  const absolute = resolve(file);
  await git(project, ['check-ignore', '--quiet', '--', absolute]).catch(() => { throw new SmokeError('path_must_be_git_ignored'); });
  const stat = await lstat(absolute).catch(error => { if (!mustExist && error.code === 'ENOENT') return null; throw new SmokeError('protected_file_unavailable'); });
  if (stat) ensure(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && (process.getuid?.() === undefined || stat.uid === process.getuid()) && await realpath(absolute) === absolute, 'file_must_be_private_and_regular');
  return absolute;
}
async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const parent = await open(dirname(file), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
async function configFrom(file) {
  file = await protectedFile(file);
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); } catch { throw new SmokeError('invalid_config_json'); }
  ensure(config && /^[a-f0-9]{32}$/.test(config.account_id) && validName(config.namespace) && typeof config.internal_token === 'string' && /^[^\s\x00-\x1f\x7f]{32,512}$/.test(config.internal_token), 'invalid_config');
  let url;
  try { url = new URL(config.worker_url); } catch { throw new SmokeError('invalid_worker_url'); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.port && ['/', '/artifacts'].includes(url.pathname), 'invalid_worker_url');
  return { ...config, worker_url: new URL('/artifacts', url).href, file };
}
function remoteFrom(info, name, config) {
  ensure(info?.name === name && typeof info.remote === 'string' && info.defaultBranch === 'main', 'repository_metadata_mismatch');
  let remote;
  try { remote = new URL(info.remote); } catch { throw new SmokeError('invalid_artifacts_remote'); }
  ensure(remote.protocol === 'https:' && !remote.username && !remote.password && !remote.search && !remote.hash && !remote.port && remote.hostname === `${config.account_id}.artifacts.cloudflare.net` && remote.pathname === `/git/${config.namespace}/${name}.git` && remote.href === info.remote, 'invalid_artifacts_remote');
  return remote.href;
}
async function boundedJson(response) {
  const reader = response.body?.getReader();
  ensure(reader, 'bridge_response_invalid');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new SmokeError('bridge_response_too_large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof SmokeError) throw error; throw new SmokeError('bridge_response_invalid'); }
  finally { reader.releaseLock(); }
}

/** Explicit live smoke test. Importing this module never reads credentials or calls Cloudflare. */
export async function runCloudflareSmoke({ configPath, journalPath }) {
  const config = await configFrom(configPath);
  const journalFile = await protectedFile(journalPath ?? join(dirname(config.file), 'smoke-journal.json'), false);
  const lockFile = await protectedFile(`${journalFile}.lock`, false);
  const lock = await open(lockFile, 'wx', 0o600).catch(() => { throw new SmokeError('journal_busy_or_interrupted'); });
  try {
    await lock.writeFile(String(process.pid)); await lock.sync();
    const receiptFile = await protectedFile(join(dirname(journalFile), 'smoke-receipt.json'), false);
    const fingerprint = sha256(JSON.stringify([config.worker_url, config.account_id, config.namespace]));
    let journal;
    try { journal = JSON.parse(await readFile(journalFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new SmokeError('invalid_journal_json'); }
    if (!journal) {
      const id = randomUUID();
      journal = { version: 1, run_id: id, fingerprint, phase: 'planned', names: { canonical: `gitpunk-smoke-${id}`, fork: `gitpunk-fork-${id}` }, resources: { canonical: 'planned', fork: 'planned' }, tokens: [], evidence: [], counts: { bridge_requests: 0, git_remote_commands: 0, fixture_bytes: 0 } };
      await atomicJson(journalFile, journal); // Stable names exist before the first cloud mutation.
    }
    ensure(journal.version === 1 && journal.fingerprint === fingerprint && /^[a-f0-9-]{36}$/.test(journal.run_id) && validName(journal.names?.canonical) && validName(journal.names?.fork) && journal.names.canonical !== journal.names.fork && Array.isArray(journal.tokens) && Array.isArray(journal.evidence) && journal.evidence.every(item => EVIDENCE.includes(item)) && Object.entries(LIMITS).every(([key, max]) => Number.isInteger(journal.counts?.[key]) && journal.counts[key] >= 0 && journal.counts[key] <= max), 'journal_config_mismatch');
    if (journal.phase === 'passed') {
      let receipt;
      try { receipt = JSON.parse(await readFile(await protectedFile(receiptFile), 'utf8')); }
      catch (error) { if (error instanceof SmokeError) throw error; throw new SmokeError('completed_receipt_unavailable'); }
      const repositories = Object.entries(journal.names).map(([kind, name]) => ({ name, state: journal.resources?.[kind] }));
      const matching = { mode: 'live Cloudflare Artifacts bridge', state: 'passed', run_id: journal.run_id, namespace: config.namespace, repositories, commit: journal.commit, fork_commit: journal.fork_commit, binary_sha256: journal.binary_sha256, evidence: journal.evidence, attempt_counts: journal.counts, hard_limits: LIMITS, error: null };
      ensure(journal.error === null && repositories.length === 2 && repositories.every(repo => repo.state === 'ready') && /^[a-f0-9]{40}$/.test(journal.commit) && /^[a-f0-9]{40}$/.test(journal.fork_commit) && journal.commit !== journal.fork_commit && journal.binary_sha256 === sha256(binary) && journal.evidence.length === EVIDENCE.length && EVIDENCE.every(item => journal.evidence.includes(item)), 'completed_journal_mismatch');
      ensure(journal.tokens.length >= 3 && new Set(journal.tokens.map(token => token?.id)).size === journal.tokens.length && journal.tokens.every(token => token && /^[^\s\x00-\x1f\x7f]{1,512}$/.test(token.id ?? '') && token.state === 'revoked' && token.fresh_denial === true && repositories.some(repo => repo.name === token.repo) && ['read', 'write'].includes(token.scope)) && [[journal.names.canonical, 'write'], [journal.names.canonical, 'read'], [journal.names.fork, 'write']].every(([repo, scope]) => journal.tokens.some(token => token.repo === repo && token.scope === scope)), 'completed_tokens_not_clean');
      ensure(Object.entries(matching).every(([key, value]) => isDeepStrictEqual(receipt[key], value)) && receipt.issued_tokens_this_attempt === 3 && receipt.tokens_revoked === 3 && receipt.revocation_denials === 3 && journal.counts.bridge_requests >= 17 && journal.counts.git_remote_commands >= 12 && journal.counts.fixture_bytes > 0 && (receipt.fingerprint === undefined || receipt.fingerprint === fingerprint), 'completed_receipt_mismatch');
      if (receipt.fingerprint === undefined) { receipt.fingerprint = fingerprint; await atomicJson(receiptFile, receipt); }
      return receipt; // Completed verification never spends another request or creates another fixture.
    }
    const save = async phase => { if (phase) journal.phase = phase; await atomicJson(journalFile, journal); };
    const evidence = async item => { if (!journal.evidence.includes(item)) journal.evidence.push(item); await save(); };
    async function budget(key, amount = 1, reserved = 0) {
      ensure(journal.counts[key] + amount <= LIMITS[key] - reserved, `${key}_limit_reached`);
      journal.counts[key] += amount; await save(); // Attempt counts persist even if the response is lost.
    }
    async function bridge(input, { token = config.internal_token, expectedStatus } = {}) {
      const reserved = input.action === 'revoke_token' ? 0 : journal.tokens.filter(record => !['revoked', 'expired'].includes(record.state)).length;
      await budget('bridge_requests', 1, reserved);
      let response, body;
      try {
        response = await fetch(config.worker_url, { method: 'POST', redirect: 'error', headers: { 'user-agent': 'gitpunk-cloudflare-smoke/0.1', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(TIMEOUT) });
        journal.last_bridge_http = { status: response.status, json: response.headers.get('content-type')?.split(';')[0] === 'application/json' };
        await save();
        if (expectedStatus === 401 && token === null && response.status === 404 && !journal.last_bridge_http.json) { await response.body?.cancel(); throw new SmokeError('bridge_not_ready'); }
        body = await boundedJson(response);
      }
      catch (error) { if (error instanceof SmokeError) throw error; throw new SmokeError('bridge_transport_failed'); }
      if (expectedStatus !== undefined) { ensure(response.status === expectedStatus && body.error?.code === 'unauthorized', 'bridge_auth_denial_unproven'); return body; }
      if (!response.ok || body.error) {
        const code = ['not_found', 'already_exists', 'repository_pending', 'created_needs_reconciliation', 'unauthorized', 'not_configured'].includes(body.error?.code) ? body.error.code : 'bridge_operation_failed';
        throw new SmokeError(code);
      }
      return body;
    }
    const info = name => bridge({ action: 'info', repo: name });
    async function provision(kind, action) {
      const name = journal.names[kind];
      ensure(!['requested', 'needs_reconciliation'].includes(journal.resources[kind]), 'provisioning_needs_same_name_reconciliation');
      if (journal.resources[kind] !== 'ready') {
        try { await info(name); throw new SmokeError('unverified_repository_already_exists'); }
        catch (error) { if (error.code !== 'not_found') throw error; }
        journal.resources[kind] = 'requested'; await save(`provisioning_${kind}`);
        try { remoteFrom(await bridge({ ...action, name }), name, config); journal.resources[kind] = 'ready'; await save(); }
        catch (error) { journal.resources[kind] = 'needs_reconciliation'; await save(); throw error; }
      }
      return remoteFrom(await info(name), name, config);
    }
    const liveTokens = [];
    async function remoteGit(directory, args, options) {
      const { cleanup = false, ...authOptions } = options;
      await budget('git_remote_commands', 1, cleanup ? 0 : liveTokens.filter(token => !token.record.fresh_denial).length);
      return git(directory, args, authOptions);
    }
    async function fixtureFile(directory, name, content) { await budget('fixture_bytes', Buffer.byteLength(content)); await writeFile(join(directory, name), content); }
    async function mint(repo, scope, remote) {
      ensure(journal.counts.git_remote_commands + liveTokens.length + 1 < LIMITS.git_remote_commands, 'git_remote_commands_limit_reached');
      ensure(journal.counts.bridge_requests + 1 <= LIMITS.bridge_requests - journal.tokens.filter(record => !['revoked', 'expired'].includes(record.state)).length - 1, 'bridge_requests_limit_reached');
      const record = { repo, scope, state: 'requested', requested_at: Date.now(), expires_no_later_than: Date.now() + (TTL + 120) * 1000 };
      journal.tokens.push(record); await save(`minting_${scope}`);
      const token = await bridge({ action: 'mint_token', repo, scope, ttl: TTL });
      ensure(typeof token.id === 'string' && /^[^\s\x00-\x1f\x7f]{1,512}$/.test(token.id), 'invalid_minted_token');
      Object.assign(record, { id: token.id, state: 'active' }); await save();
      ensure(typeof token.plaintext === 'string' && /^[^\s\x00-\x1f\x7f]{1,512}$/.test(token.plaintext) && token.scope === scope && Number.isFinite(Date.parse(token.expiresAt)), 'invalid_minted_token');
      Object.assign(record, { id: token.id, expires_at: token.expiresAt, state: 'active' });
      const live = { record, plaintext: token.plaintext, remote }; liveTokens.push(live);
      await save(); return live;
    }
    const auth = token => ({ remote: token.remote, token: token.plaintext });
    async function revoke(record) {
      if (record.state === 'revoked' || record.state === 'expired') return;
      if (!record.id) { ensure(Date.now() > record.expires_no_later_than, 'unknown_token_requires_expiry_or_reconciliation'); record.state = 'expired'; await save(); return; }
      record.state = 'revoking'; await save();
      const result = await bridge({ action: 'revoke_token', repo: record.repo, token_or_id: record.id });
      ensure(result.revoked === true, 'token_revocation_unproven');
      record.state = 'revoked'; await save();
    }
    let workspace, error;
    try {
      // Resume known token cleanup first. Unknown mint outcomes cannot leak another active token.
      for (const record of journal.tokens) await revoke(record);
      for (let attempt = 0; ; attempt++) {
        try { await bridge({ action: 'info', repo: journal.names.canonical }, { token: null, expectedStatus: 401 }); break; }
        catch (error) { if (error.code !== 'bridge_not_ready' || attempt === 3) throw error; ensure(journal.counts.bridge_requests < LIMITS.bridge_requests, 'bridge_requests_limit_reached'); await delay(5000); }
      }
      await bridge({ action: 'info', repo: journal.names.canonical }, { token: 'gitpunk-invalid-smoke-token', expectedStatus: 401 });
      await evidence('missing_and_invalid_bridge_credentials_denied');
      const canonicalRemote = await provision('canonical', { action: 'create', description: 'Gitpunk disposable live smoke fixture' });
      workspace = await mkdtemp(join(dirname(journalFile), 'smoke-work-'));
      const source = join(workspace, 'source'); await mkdir(source);
      await git(source, ['init', '--initial-branch=main', '--object-format=sha1', '--template=']);
      await fixtureFile(source, 'fixture.bin', binary);
      await fixtureFile(source, 'README.md', 'Gitpunk Artifacts live smoke fixture.\n');
      await git(source, ['add', 'fixture.bin', 'README.md']);
      const commit = async (directory, message) => { await git(directory, ['-c', 'user.name=Gitpunk smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', message], { date: '2026-10-04T00:00:00+0000' }); return (await git(directory, ['rev-parse', 'HEAD'])).toString().trim(); };
      const original = await commit(source, 'Exact binary fixture'), binaryHash = sha256(binary);
      ensure(!journal.commit || journal.commit === original, 'fixture_commit_changed');
      journal.commit = original; journal.binary_sha256 = binaryHash; await save('fixture_committed');
      const write = await mint(journal.names.canonical, 'write', canonicalRemote);
      await save('pushing_canonical'); await remoteGit(source, ['push', canonicalRemote, 'HEAD:refs/heads/main'], auth(write));
      await evidence('write_token_git_push');
      const read = await mint(journal.names.canonical, 'read', canonicalRemote), clone = join(workspace, 'read-clone');
      await remoteGit(workspace, ['clone', '--template=', '--branch=main', '--single-branch', canonicalRemote, clone], auth(read));
      ensure((await git(clone, ['rev-parse', 'HEAD'])).toString().trim() === original && sha256(await readFile(join(clone, 'fixture.bin'))) === binaryHash, 'clone_readback_mismatch');
      const readCommit = await bridge({ action: 'read_commit', repo: journal.names.canonical, commit: original });
      ensure(readCommit.commit === original && readCommit.metadata?.hash === original, 'binding_commit_mismatch');
      const file = await bridge({ action: 'read_file', repo: journal.names.canonical, commit: original, path: 'fixture.bin', expected_sha256: binaryHash });
      ensure(file.commit === original && file.sha256 === binaryHash && typeof file.content_base64 === 'string' && Buffer.from(file.content_base64, 'base64').equals(binary), 'binding_binary_readback_mismatch');
      await evidence('fresh_read_clone_and_exact_binding_commit_binary');
      await fixtureFile(clone, 'read-must-not-push.txt', 'This new commit must be denied.\n'); await git(clone, ['add', 'read-must-not-push.txt']);
      const rejectedCommit = await commit(clone, 'Reject real new read-token push'); ensure(rejectedCommit !== original, 'denial_commit_not_new');
      await remoteGit(clone, ['push', canonicalRemote, 'HEAD:refs/heads/main'], { ...auth(read), denial: true });
      ensure((await remoteGit(source, ['ls-remote', canonicalRemote, 'refs/heads/main'], auth(read))).toString().split(/\s/)[0] === original, 'read_token_changed_canonical');
      await evidence('read_token_real_new_push_denied');
      const forkRemote = await provision('fork', { action: 'fork', repo: journal.names.canonical, description: 'Gitpunk isolated agent smoke fork' });
      const forkWrite = await mint(journal.names.fork, 'write', forkRemote), fork = join(workspace, 'fork-clone');
      await remoteGit(workspace, ['clone', '--template=', '--branch=main', '--single-branch', forkRemote, fork], auth(forkWrite));
      ensure((await git(fork, ['show', `${original}:fixture.bin`])).equals(binary), 'fork_baseline_mismatch');
      const forkHead = (await git(fork, ['rev-parse', 'HEAD'])).toString().trim();
      ensure(forkHead === original || forkHead === journal.fork_commit, 'fork_head_changed');
      await git(fork, ['reset', '--hard', original]);
      const forkBytes = Buffer.concat([binary, Buffer.from([42, 0, 255])]);
      await fixtureFile(fork, 'fixture.bin', forkBytes); await git(fork, ['add', 'fixture.bin']);
      const forkCommit = await commit(fork, 'Modify isolated agent fork');
      journal.fork_commit = forkCommit;
      await save('pushing_fork'); await remoteGit(fork, ['push', forkRemote, 'HEAD:refs/heads/main'], auth(forkWrite));
      ensure((await remoteGit(fork, ['ls-remote', forkRemote, 'refs/heads/main'], auth(forkWrite))).toString().split(/\s/)[0] === forkCommit, 'fork_push_readback_mismatch');
      const forkFile = await bridge({ action: 'read_file', repo: journal.names.fork, commit: forkCommit, path: 'fixture.bin', expected_sha256: sha256(forkBytes) });
      ensure(Buffer.from(forkFile.content_base64 ?? '', 'base64').equals(forkBytes), 'fork_binary_readback_mismatch');
      await remoteGit(fork, ['push', canonicalRemote, 'HEAD:refs/heads/main'], { remote: canonicalRemote, token: forkWrite.plaintext, denial: true });
      ensure((await remoteGit(source, ['ls-remote', canonicalRemote, 'refs/heads/main'], auth(read))).toString().split(/\s/)[0] === original, 'fork_changed_canonical');
      journal.fork_commit = forkCommit; await evidence('fork_change_isolated_and_fork_token_canonical_push_denied');
    } catch (caught) { error = caught instanceof SmokeError ? caught : new SmokeError('smoke_operation_failed'); }
    finally {
      for (const record of journal.tokens.filter(record => record.id && !liveTokens.some(token => token.record === record))) {
        try { await revoke(record); } catch { error ??= new SmokeError('token_cleanup_or_fresh_denial_failed'); }
      }
      for (const token of liveTokens) {
        try { await revoke(token.record); await remoteGit(workspace, ['ls-remote', token.remote, 'refs/heads/main'], { ...auth(token), denial: true, cleanup: true }); token.record.fresh_denial = true; await save(); }
        catch { error ??= new SmokeError('token_cleanup_or_fresh_denial_failed'); }
      }
      if (workspace) await rm(workspace, { recursive: true, force: true });
    }
    if (liveTokens.length && liveTokens.every(token => token.record.fresh_denial)) await evidence('all_issued_tokens_revoked_and_fresh_git_requests_denied');
    journal.phase = error ? 'failed' : 'passed'; journal.error = error?.code ?? null; await save();
    const receipt = { mode: 'live Cloudflare Artifacts bridge', state: journal.phase, run_id: journal.run_id, fingerprint, namespace: config.namespace, repositories: Object.entries(journal.names).map(([kind, name]) => ({ name, state: journal.resources[kind] })), commit: journal.commit ?? null, fork_commit: journal.fork_commit ?? null, binary_sha256: journal.binary_sha256 ?? null, evidence: journal.evidence, attempt_counts: journal.counts, hard_limits: LIMITS, issued_tokens_this_attempt: liveTokens.length, tokens_revoked: liveTokens.filter(token => token.record.state === 'revoked').length, revocation_denials: liveTokens.filter(token => token.record.fresh_denial).length, error: error?.code ?? null };
    await atomicJson(receiptFile, receipt);
    if (error) throw error;
    return receipt;
  } finally { await lock.close(); await rm(lockFile); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write('Usage: npm run demo:cloudflare -- --config <private ignored JSON> [--journal <ignored JSON>]\n');
  else {
    try {
      const options = {};
      for (let index = 0; index < args.length; index += 2) { ensure(['--config', '--journal'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--'), 'invalid_arguments'); options[args[index] === '--config' ? 'configPath' : 'journalPath'] = args[index + 1]; }
      ensure(options.configPath, 'config_required');
      const receipt = await runCloudflareSmoke(options);
      process.stdout.write(`Artifacts smoke passed: push/clone/binary/fork permissions verified; ${receipt.tokens_revoked} tokens revoked with fresh denials.\n`);
    } catch (error) { process.stderr.write(`Artifacts smoke stopped: ${error instanceof SmokeError ? error.code : 'smoke_operation_failed'}. Inspect the private journal; retain its repository names.\n`); process.exitCode = 1; }
  }
}
