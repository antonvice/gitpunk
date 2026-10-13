import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitpunkServer } from '../server/index.js';
import { git, head, committedFiles, exportCommitBundle } from '../client/git.js';
import { exampleIntent, hashBytes, generateKeyPair, signEnvelope, verifyEnvelope } from '../shared/index.js';

function rawGit(directory, args, input) {
  return new Promise((resolve, reject) => {
    const command = execFile('git', ['-C', directory, ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    command.stdin.end(input);
  });
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gitpunk-upload-security-'));
  const source = join(directory, 'source');
  await mkdir(source);
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.name', 'Local test');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'models.py'), 'model = "base"\n');
  await writeFile(join(source, 'services.py'), 'service = "base"\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'Trusted base');
  const base = await head(source);
  const app = await createGitpunkServer({ dataDir: join(directory, 'server'), port: 0, bootstrap: true, gitSource: source });
  const { endpoint } = await app.start();
  t.after(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const identity = app.fixture.identities.alice;
  async function request(route, body, name = 'alice') {
    const response = await fetch(`${endpoint}/v1/repos/demo/${route}`, {
      method: body ? 'POST' : 'GET', headers: {
        Authorization: `Bearer ${app.fixture.identities[name].token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...(await response.json()) };
  }
  const sign = (payload, eventId) => signEnvelope(payload, { eventId, runId: identity.run_id, privateKey: identity.privateKey });
  const work = await request('work', await sign({ intent: { ...exampleIntent, files: ['models.py'] },
    base_commit: base, workspace_id: 'workspace-alice', branch: 'main' }));
  assert.equal(work.status, 200);
  const intent = work.data.intent;
  async function commit(content = 'model = "updated"\n', message = 'Update model') {
    await writeFile(join(source, 'models.py'), content);
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', message);
    return head(source);
  }
  async function uploadWire(overrides = {}, eventId = 'upload-1', attachment) {
    const commit = await head(source);
    const bundle = attachment ?? await exportCommitBundle(source, base, commit);
    const payload = {
      intent_id: intent.id, intent_revision: intent.revision, branch: 'main', workspace_id: 'workspace-alice',
      base_commit: base, commit, bundle_hash: bundle.bundle_hash,
      files: await committedFiles(source, base, commit), ...overrides,
    };
    return { ...(await sign(payload, eventId)), bundle_content: bundle.bundle_content };
  }
  async function canonicalUnchanged() { assert.equal(await app.gitStore.readRef('refs/heads/main'), base); }
  return { app, source, base, intent, identity, request, sign, commit, uploadWire, canonicalUnchanged };
}

test('accepted working upload has signed exact provenance and leaves canonical Git unchanged', async t => {
  const s = await setup(t);
  const commit = await s.commit();
  const wire = await s.uploadWire();
  const result = await s.request('commits', wire);
  assert.equal(result.status, 200);
  assert.equal(result.data.state, 'uploaded');
  assert.equal(result.data.commit, commit);
  assert.equal(result.data.checked, false);
  assert.equal(result.data.integrated, false);
  await s.canonicalUnchanged();
  const replacement = await generateKeyPair();
  s.app.db.prepare("UPDATE agents SET public_key=? WHERE id='agent-a'").run(JSON.stringify(replacement.publicKey));
  const fetched = await s.request('commits/upload-1/bundle', null, 'bob');
  assert.equal(fetched.status, 200);
  assert.equal(await verifyEnvelope(fetched.data.signed, fetched.data.public_key), true);
  assert.equal(await verifyEnvelope(fetched.data.signed, replacement.publicKey), false, 'admission pins the historical signing key');
  assert.equal(await hashBytes(Buffer.from(fetched.data.bundle_content, 'base64')), wire.payload.bundle_hash);
  s.app.db.prepare("DELETE FROM access WHERE repo_id='demo' AND user_id='bob'").run();
  assert.equal((await s.request('commits/upload-1/bundle', null, 'bob')).status, 403);
});

test('attachment tampering and hidden committed files cannot bypass signed scope', async t => {
  const s = await setup(t);
  await s.commit();
  const valid = await s.uploadWire({}, 'tamper-1');
  const tampered = { ...valid, bundle_content: Buffer.from('invalid bundle').toString('base64') };
  assert.equal((await s.request('commits', tampered)).error.code, 'bundle_hash_mismatch');
  await writeFile(join(s.source, 'services.py'), 'service = "outside declared scope"\n');
  await git(s.source, 'add', 'services.py');
  await git(s.source, 'commit', '-m', 'Undeclared service change');
  const actual = await committedFiles(s.source, s.base, await head(s.source));
  const omitted = await s.uploadWire({ files: actual.filter(file => file.path === 'models.py') }, 'hidden-path-1');
  assert.equal((await s.request('commits', omitted)).status, 403);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM uploads').get().n, 0);
  await s.canonicalUnchanged();
});

test('credentials removed from the tip remain rejected in uploaded history', async t => {
  const s = await setup(t);
  await s.commit(`credential = "ghp_${'A'.repeat(40)}"\n`, 'Temporary credential');
  await s.commit('model = "clean final result"\n', 'Remove credential');
  const rejected = await s.request('commits', await s.uploadWire());
  assert.equal(rejected.error.code, 'secret_detected');
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM uploads').get().n, 0);
  await s.canonicalUnchanged();
});

test('protected paths added and removed before the final commit remain rejected', async t => {
  const s = await setup(t);
  await writeFile(join(s.source, '.env'), 'temporary = true\n');
  await s.commit('model = "first change"\n', 'Temporary protected file');
  await unlink(join(s.source, '.env'));
  await s.commit('model = "clean final result"\n', 'Remove protected file');
  const rejected = await s.request('commits', await s.uploadWire());
  assert.equal(rejected.error.code, 'protected_path');
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM uploads').get().n, 0);
  await s.canonicalUnchanged();
});

test('forged regular-file manifests cannot hide a committed symlink', async t => {
  const s = await setup(t);
  await unlink(join(s.source, 'models.py'));
  await symlink('/tmp/private-target', join(s.source, 'models.py'));
  await git(s.source, 'add', 'models.py');
  await git(s.source, 'commit', '-m', 'Replace model with symlink');
  const commit = await head(s.source);
  const bundle = await exportCommitBundle(s.source, s.base, commit);
  const payload = {
    intent_id: s.intent.id, intent_revision: 1, branch: 'main', workspace_id: 'workspace-alice',
    base_commit: s.base, commit, bundle_hash: bundle.bundle_hash,
    files: [{ path: 'models.py', operation: 'modify', base_hash: await hashBytes(Buffer.from('model = "base"\n')),
      result_hash: await hashBytes(Buffer.from('/tmp/private-target')), base_mode: '100644', result_mode: '100644' }],
  };
  const response = await s.request('commits', { ...(await s.sign(payload, 'symlink-1')), bundle_content: bundle.bundle_content });
  assert.equal(response.error.code, 'unsupported_git_mode');
  await s.canonicalUnchanged();
});

test('unadvertised packed objects cannot ride inside a validated bundle', async t => {
  const s = await setup(t);
  const commit = await s.commit();
  const original = await exportCommitBundle(s.source, s.base, commit);
  const hidden = (await rawGit(s.source, ['hash-object', '-w', '--stdin'], Buffer.from(`ghp_${'A'.repeat(40)}`))).toString().trim();
  const reachable = (await git(s.source, 'rev-list', '--objects', commit, `^${s.base}`)).split('\n').map(line => line.split(' ')[0]);
  const pack = await rawGit(s.source, ['pack-objects', '--stdout'], [...reachable, hidden].join('\n') + '\n');
  const bytes = Buffer.from(original.bundle_content, 'base64');
  const header = bytes.subarray(0, bytes.indexOf(Buffer.from('\n\n')) + 2);
  const injected = Buffer.concat([header, pack]);
  const attachment = { bundle_content: injected.toString('base64'), bundle_hash: await hashBytes(injected) };
  const wire = await s.uploadWire({}, 'extra-object-1', attachment);
  const response = await s.request('commits', wire);
  assert.equal(response.error.code, 'extraneous_git_objects', 'the valid bundle carries an unadvertised extra object');
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM uploads').get().n, 0);
  await s.canonicalUnchanged();
});

test('upload admission failure remains invisible and the exact retry recovers once', async t => {
  const s = await setup(t);
  await s.commit();
  const wire = await s.uploadWire();
  s.app.db.exec("CREATE TRIGGER reject_upload_event BEFORE INSERT ON events WHEN NEW.type='commit.uploaded' BEGIN SELECT RAISE(ABORT, 'simulated upload admission failure'); END;");
  assert.equal((await s.request('commits', wire)).status, 500);
  assert.equal((await s.request('commits/upload-1')).status, 404);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM uploads').get().n, 0);
  await s.canonicalUnchanged();
  s.app.db.exec('DROP TRIGGER reject_upload_event');
  const accepted = await s.request('commits', wire);
  assert.equal(accepted.status, 200);
  const repeated = await s.request('commits', wire);
  assert.deepEqual(repeated.data, accepted.data);
  assert.equal(s.app.db.prepare("SELECT count(*) n FROM events WHERE type='commit.uploaded'").get().n, 1);
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM uploads').get().n, 1);
  await s.canonicalUnchanged();
});
