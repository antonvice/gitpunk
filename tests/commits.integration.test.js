import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaces } from '../scripts/git-fixture.js';
import { createGitpunkServer } from '../server/index.js';
import { GitpunkClient } from '../client/index.js';
import { git, head } from '../client/git.js';

test('upload opt-in survives restart and a lost HTTP receipt retries the same commit once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-upload-flow-'));
  const workspaces = await createWorkspaces(root);
  const dataDir = join(root, 'server');
  const server = await createGitpunkServer({ dataDir, bootstrap: true, port: 0, gitSource: workspaces.source });
  const started = await server.start();
  const options = { credentials: started.fixture_path, identity: 'alice', workspace: workspaces.alice, stateDir: join(root, 'alice-state'), debounceMs: 0 };
  let client = await GitpunkClient.create(options);
  t.after(async () => { client.close(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  const intent = JSON.parse(await readFile(new URL('../examples/cars/intent.json', import.meta.url), 'utf8'));
  await client.work(intent);
  await client.tick();
  const staged = (await readFile(join(workspaces.alice, 'models.py'), 'utf8')) + '\n# Exact committed contract.\n';
  await writeFile(join(workspaces.alice, 'models.py'), staged);
  await git(workspaces.alice, 'add', 'models.py');
  await git(workspaces.alice, '-c', 'user.name=Gitpunk test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Record Car contract');
  const commit = await head(workspaces.alice);
  await writeFile(join(workspaces.alice, 'models.py'), staged + '\n# Still private unstaged work.\n');
  await client.tick();
  assert.equal((await client.status()).commit.upload, 'disabled');
  assert.equal((await client.status()).server.uploads.length, 0);

  // Enabling upload after the commit observes the existing exact HEAD.
  client.close();
  client = await GitpunkClient.create({ ...options, upload: true });
  const request = client.request.bind(client);
  let lost = false;
  client.request = async (route, envelope) => {
    const receipt = await request(route, envelope);
    if (route === 'commits' && !lost) { lost = true; throw new Error('Simulated response lost after server acceptance'); }
    return receipt;
  };
  await client.tick();
  assert.equal(lost, true);
  assert.equal((await client.status()).server.uploads.length, 1);
  assert.equal((await client.status()).counts.outbox, 1);

  // The durable outbox stores both signed metadata and detached bundle bytes.
  client.close();
  client = await GitpunkClient.create(options);
  await client.tick();
  const recovered = await client.status();
  assert.equal(recovered.commit.upload, 'uploaded');
  assert.equal(recovered.commit.commit, commit);
  assert.equal(recovered.server.uploads.length, 1);
  assert.equal(recovered.counts.outbox, 0);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='commit.uploaded'").get().n, 1);
  const uploaded = await client.request(`commits/${recovered.server.uploads[0].id}`);
  assert.equal(uploaded.commit, commit);
  assert.equal(uploaded.manifest.files.length, 1);
  assert.equal(await git(workspaces.alice, 'diff', '--cached'), '');
  assert.equal(await readFile(join(workspaces.alice, 'models.py'), 'utf8'), staged + '\n# Still private unstaged work.\n');
});
