import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson, ProtocolError, CheckPolicy, CheckResult } from '../shared/index.js';
import { runCandidate } from './runner.js';

const json = value => JSON.parse(value);
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code, message, status = 409) => { throw new ProtocolError(code, message, status); };
const tx = (db, action) => { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };

/** One local integrator. Uploaded code is never called checked merely because it arrived. */
export function createCoordinator({ db, gitStore, policy: inputPolicy, authorize, inspect, publish, runner = runCandidate }) {
  const policy = inputPolicy ? CheckPolicy.parse(inputPolicy) : null;
  const policyHash = policy ? hash(policy) : null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY REFERENCES uploads(id), order_seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0, check_id TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), target TEXT NOT NULL, candidate TEXT, policy_hash TEXT NOT NULL, state TEXT NOT NULL, scope TEXT NOT NULL, signing_key TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals(check_id TEXT PRIMARY KEY REFERENCES checks(id), run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL, envelope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_ops(id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), check_id TEXT NOT NULL REFERENCES checks(id), target TEXT NOT NULL, candidate TEXT NOT NULL, policy_hash TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
  `);
  let timer, busy = false, stopped = false, lastError = null;
  const upload = id => db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
  const check = id => db.prepare('SELECT * FROM checks WHERE id=?').get(id);
  function event(record, id, type, data) { return publish(record, id, type, { ...data, source_upload_id: record.id, origin: 'server' }); }
  function enqueue() {
    for (const row of db.prepare("SELECT rowid AS order_seq,* FROM uploads WHERE state='uploaded' ORDER BY rowid").all()) db.prepare('INSERT OR IGNORE INTO submissions(id,order_seq) VALUES(?,?)').run(row.id, row.order_seq);
  }
  function gate(record, result) {
    const actor = authorize(record);
    if (result.policy_hash !== policyHash || actor.scope !== result.scope || actor.public_key !== result.signing_key) fail('stale_authority', 'Permissions, signing key or policy changed since checking.');
    if (result.state !== 'passed') fail('checks_required', 'Exact candidate checks must pass.');
    const evidence = json(result.result);
    if (evidence.target !== result.target || evidence.candidate !== result.candidate || evidence.policy_hash !== result.policy_hash || evidence.image_digest !== policy.image) fail('invalid_check_binding', 'Runner evidence does not match target/candidate/policy/image.');
    if (policy.approval === 'manual') {
      const approval = db.prepare('SELECT * FROM approvals WHERE check_id=?').get(result.id);
      if (!approval) fail('approval_required', 'An authorized administrator must approve this exact check.');
      const approver = authorize({ ...record, run_id: approval.run_id }, { approval: true });
      const agreed = json(approval.data);
      if (!['admin','maintainer'].includes(approver.role) || approver.public_key !== agreed.signing_key) fail('approval_revoked', 'Approver is no longer authorized.');
    }
    return actor;
  }
  function completeOperation(op, record) {
    db.prepare("UPDATE integration_ops SET state='integrated' WHERE id=?").run(op.id);
    db.prepare("UPDATE submissions SET state='integrated',reason=NULL WHERE id=?").run(record.id);
    const provenance = { id: op.id, submission_id: record.id, check_id: op.check_id, target: op.target, candidate: op.candidate, policy_hash: op.policy_hash, state: 'integrated', checked: true, integrated: true };
    event(record, op.id, 'integration.finished', provenance);
    return provenance;
  }
  function stale(record, result, reason) {
    tx(db, () => {
      db.prepare("UPDATE checks SET state='stale' WHERE id=?").run(result.id);
      db.prepare('DELETE FROM approvals WHERE check_id=?').run(result.id);
      db.prepare("UPDATE submissions SET state='queued',reason=? WHERE id=?").run(reason, record.id);
      db.prepare("UPDATE integration_ops SET state='stale' WHERE check_id=? AND state='prepared'").run(result.id);
      event(record, `stale-${result.id}`, 'checks.stale', { id: result.id, submission_id: record.id, target: result.target, candidate: result.candidate, reason });
    });
  }
  function integrate(record, result) {
    const observed = gitStore.readRefSync('refs/heads/main');
    if (observed !== result.target) { stale(record, result, 'target_changed'); return; }
    gate(record, result);
    const operationId = `integrate-${result.id}`;
    const data = { policy, result: json(result.result), approved: policy.approval === 'automatic' ? 'automatic-demo-policy' : json(db.prepare('SELECT data FROM approvals WHERE check_id=?').get(result.id).data) };
    // This record survives a crash between Git's ref update and the SQLite receipt.
    db.prepare("INSERT OR IGNORE INTO integration_ops(id,submission_id,check_id,target,candidate,policy_hash,state,data) VALUES(?,?,?,?,?,?,'prepared',?)").run(operationId, record.id, result.id, result.target, result.candidate, policyHash, JSON.stringify(data));
    return tx(db, () => {
      gate(record, check(result.id));
      if (gitStore.readRefSync('refs/heads/main') !== result.target) fail('stale_target', 'Canonical target changed before integration.');
      gitStore.compareAndSwap(result.target, result.candidate);
      return completeOperation({ ...result, id: operationId, check_id: result.id }, record);
    });
  }
  function recover(resetChecking = false) {
    // Checking processes disappear on restart; their results cannot be guessed.
    if (resetChecking) tx(db, () => {
      for (const result of db.prepare("SELECT * FROM checks WHERE state IN ('building','running')").all()) {
        const diagnostic = { state: 'error', code: 'interrupted_check', message: 'Server restarted before checking completed.', target: result.target, candidate: result.candidate, policy_hash: result.policy_hash };
        db.prepare("UPDATE checks SET state='error',result=? WHERE id=?").run(JSON.stringify(diagnostic), result.id);
        db.prepare('DELETE FROM approvals WHERE check_id=?').run(result.id);
        event(upload(result.submission_id), `interrupted-${result.id}`, 'checks.interrupted', { id: result.id, submission_id: result.submission_id, ...diagnostic });
      }
      db.prepare("UPDATE submissions SET state='queued',reason='interrupted_check' WHERE state='checking'").run();
    });
    for (const op of db.prepare("SELECT * FROM integration_ops WHERE state='prepared' ORDER BY rowid").all()) {
      const record = upload(op.submission_id), result = check(op.check_id);
      const current = gitStore.readRefSync('refs/heads/main');
      if (current === op.candidate) tx(db, () => completeOperation(op, record));
      else if (current !== op.target || op.policy_hash !== policyHash) stale(record, result, 'interrupted_target_or_policy_changed');
      // If the old target remains, flush revalidates authority before retrying CAS.
    }
  }
  async function evaluate(record, submission) {
    const actor = authorize(record);
    const manifest = json(record.data).manifest;
    const target = await gitStore.readRef('refs/heads/main');
    const id = `check-${randomUUID()}`;
    tx(db, () => {
      db.prepare("UPDATE submissions SET state='checking',attempt=attempt+1,check_id=?,reason=NULL WHERE id=?").run(id, record.id);
      db.prepare("INSERT INTO checks(id,submission_id,target,policy_hash,state,scope,signing_key,created_at) VALUES(?,?,?,?,'building',?,?,?)").run(id, record.id, target, policyHash, actor.scope, actor.public_key, Date.now());
    });
    const candidate = await gitStore.buildCandidate({ base: manifest.base_commit, target, commit: record.commit_id, operationId: id, createdAt: record.created_at });
    if (candidate.state === 'conflict') {
      tx(db, () => {
        db.prepare("UPDATE checks SET state='conflict',result=? WHERE id=?").run(JSON.stringify(candidate), id);
        db.prepare("UPDATE submissions SET state='conflict',reason='merge_conflict' WHERE id=?").run(record.id);
        event(record, id, 'integration.conflict', { id, submission_id: record.id, target, base: manifest.base_commit, commit: record.commit_id, details: candidate.details });
      });
      return;
    }
    // Validate Git's merged result, not only the originally uploaded patch.
    for (const change of await gitStore.candidateChanges(target, candidate.candidate)) inspect(record, actor, change);
    db.prepare("UPDATE checks SET candidate=?,state='running' WHERE id=?").run(candidate.candidate, id);
    const returned = await runner({ directory: gitStore.directory, candidate: candidate.candidate, policy });
    if (returned.target !== undefined && returned.target !== target) fail('invalid_check_binding', 'Runner returned a different target.');
    const result = CheckResult.parse({ ...returned, target });
    if (result.candidate !== candidate.candidate || result.policy_hash !== policyHash || result.image_digest !== policy.image) fail('invalid_check_binding', 'Runner returned evidence for different code or environment.');
    const state = result.state === 'passed' ? 'passed' : result.state;
    tx(db, () => {
      db.prepare('UPDATE checks SET state=?,result=? WHERE id=?').run(state, JSON.stringify(result), id);
      db.prepare('UPDATE submissions SET state=?,reason=? WHERE id=?').run(state === 'passed' ? 'awaiting_approval' : 'failed', state === 'passed' ? null : state, record.id);
      event(record, id, 'checks.finished', { id, submission_id: record.id, target, candidate: candidate.candidate, policy_hash: policyHash, state, result });
    });
    if (state === 'passed') {
      const checked = check(id);
      if (gitStore.readRefSync('refs/heads/main') !== target) stale(record, checked, 'target_changed');
      else if (policy.approval === 'automatic') integrate(record, checked);
    }
  }
  async function flush() {
    if (busy || stopped || !gitStore || !policy) return;
    busy = true;
    try {
      recover();
      enqueue();
      // FIFO includes an earlier passing submission waiting for its required approval.
      for (;;) {
        const submission = db.prepare("SELECT * FROM submissions WHERE state IN ('queued','awaiting_approval') ORDER BY order_seq LIMIT 1").get();
        if (!submission) break;
        const record = upload(submission.id);
        try {
          authorize(record);
          if (submission.state === 'queued') await evaluate(record, submission);
          else {
            const result = check(submission.check_id);
            if (gitStore.readRefSync('refs/heads/main') !== result.target || result.policy_hash !== policyHash) { stale(record, result, 'target_or_policy_changed'); continue; }
            if (policy.approval === 'manual' && !db.prepare('SELECT 1 FROM approvals WHERE check_id=?').get(result.id)) break;
            integrate(record, result);
          }
        } catch (error) {
          const op = db.prepare("SELECT * FROM integration_ops WHERE submission_id=? AND state='prepared'").get(record.id);
          if (op && gitStore.readRefSync('refs/heads/main') === op.candidate) { lastError = 'Integration receipt pending recovery'; break; }
          tx(db, () => {
            db.prepare("UPDATE checks SET state='error',result=? WHERE id=(SELECT check_id FROM submissions WHERE id=?) AND state IN ('building','running')").run(JSON.stringify({ state: 'error', code: error.code ?? 'coordinator_error', message: error.message }), record.id);
            db.prepare("UPDATE submissions SET state='failed',reason=? WHERE id=?").run(error.code ?? 'coordinator_error', record.id);
            event(record, `blocked-${randomUUID()}`, 'integration.blocked', { id: record.id, state: 'failed', reason: error.code ?? 'coordinator_error', message: error.message });
          });
        }
      }
      lastError = null;
    } catch (error) { lastError = error.message; }
    finally { busy = false; }
  }
  return {
    policy, policyHash,
    start() { if (!gitStore || !policy) return; try { recover(true); } catch (error) { lastError = error.message; } timer = setInterval(flush, 250); timer.unref(); void flush(); },
    flush,
    approve(auth, envelope, input) {
      if (!policy || policy.approval !== 'manual') fail('approval_not_required', 'Manual approval is not configured.');
      if (!['admin','maintainer'].includes(auth.role)) fail('forbidden', 'Approval requires a repository administrator or maintainer.', 403);
      const result = check(input.check_id), record = upload(input.submission_id);
      if (!result || !record || result.submission_id !== record.id || record.repo_id !== auth.repo_id) fail('not_found', 'Check/submission not found.', 404);
      if (result.state !== 'passed' || input.candidate !== result.candidate || input.target !== result.target || input.policy_hash !== result.policy_hash || result.policy_hash !== policyHash) fail('stale_approval', 'Approval must name this exact passing candidate, target and policy.');
      if (gitStore.readRefSync('refs/heads/main') !== result.target) fail('stale_target', 'Target changed; new checks are required.');
      db.prepare('INSERT OR REPLACE INTO approvals(check_id,run_id,data,envelope) VALUES(?,?,?,?)').run(result.id, auth.id, JSON.stringify({ ...input, signing_key: auth.public_key }), JSON.stringify(envelope));
      return { state: 'approved', submission_id: record.id, check_id: result.id, candidate: result.candidate, target: result.target, policy_hash: result.policy_hash };
    },
    retry(auth, input) {
      const record = upload(input.submission_id);
      if (!record || record.repo_id !== auth.repo_id) fail('not_found', 'Submission not found.', 404);
      if (record.run_id !== auth.id && !['admin','maintainer'].includes(auth.role)) fail('forbidden', 'Retry requires the author or a repository maintainer.', 403);
      const submission = db.prepare('SELECT * FROM submissions WHERE id=?').get(record.id);
      if (!submission || !['failed','conflict','awaiting_approval'].includes(submission.state)) fail('not_retryable', 'Only blocked/check-complete submissions can be rechecked.');
      if (submission.check_id) db.prepare('DELETE FROM approvals WHERE check_id=?').run(submission.check_id);
      db.prepare("UPDATE submissions SET state='queued',reason='explicit_retry' WHERE id=?").run(record.id);
      return { state: 'queued', submission_id: record.id };
    },
    status({ repoId = 'demo', branch } = {}) {
      const allowed = new Set(db.prepare('SELECT id,data FROM uploads WHERE repo_id=?').all(repoId).filter(row => !branch || json(row.data).branch === branch).map(row => row.id));
      return { configured: !!(policy && gitStore), approval: policy?.approval ?? null, policy_hash: policyHash, busy, last_error: lastError ? 'Coordinator needs attention; inspect scoped submission records.' : null, submissions: db.prepare('SELECT * FROM submissions ORDER BY order_seq').all().filter(row => allowed.has(row.id)), checks: db.prepare('SELECT * FROM checks ORDER BY rowid').all().filter(row => allowed.has(row.submission_id)).map(row => ({ id: row.id, submission_id: row.submission_id, target: row.target, candidate: row.candidate, policy_hash: row.policy_hash, state: row.state, result: row.result ? json(row.result) : null })), operations: db.prepare('SELECT id,submission_id,check_id,target,candidate,state FROM integration_ops ORDER BY rowid').all().filter(row => allowed.has(row.submission_id)) };
    },
    async stop() { stopped = true; clearInterval(timer); while (busy) await new Promise(resolve => setTimeout(resolve, 20)); },
  };
}
