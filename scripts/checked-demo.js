import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitpunkServer } from '../server/index.js';
import { GitpunkClient } from '../client/index.js';
import { git } from '../client/git.js';
import { runCandidate } from '../server/runner.js';
import { createWorkspaces } from './git-fixture.js';

/** Scripted agents, real HTTP/Git/Docker, owner-defined tests. */
export async function runCheckedDemo({ root }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspaces = await createWorkspaces(root, { withTests: true });
  const policy = { ...JSON.parse(await readFile(new URL('../infra/checks.example.json', import.meta.url), 'utf8')), approval: 'automatic' };
  const server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, port: 0, gitSource: workspaces.source, checkPolicy: policy });
  let alice, bob;
  try {
    const started = await server.start();
    const client = name => GitpunkClient.create({ credentials: started.fixture_path, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`), debounceMs: 0, upload: true });
    alice = await client('alice'); bob = await client('bob');
    const intent = (title, file) => ({ title, type: 'feature', summary: title, files: [file], done_when: ['Owner contract passes against the combined branch'], sharing: 'summary' });
    await alice.work(intent('Mark new cars', 'models.py'));
    await bob.work(intent('Handle pending cars', 'services.py'));
    await alice.tick(); await bob.tick();
    const baseline = await git(workspaces.source, 'rev-parse', 'HEAD');
    const before = { alice: await git(workspaces.alice, 'diff', '--cached'), bob: await git(workspaces.bob, 'diff', '--cached') };
    await writeFile(join(workspaces.alice, 'models.py'), (await readFile(join(workspaces.alice, 'models.py'), 'utf8')) + '    is_new: bool = True\n');
    await writeFile(join(workspaces.bob, 'services.py'), 'from models import Car\n\ndef create_car(identifier: int, name: str) -> Car:\n    car = Car(identifier, name)\n    return None if getattr(car, "is_new", False) else car\n');
    for (const name of ['alice', 'bob']) {
      await git(workspaces[name], 'add', name === 'alice' ? 'models.py' : 'services.py');
      await git(workspaces[name], '-c', 'user.name=Gitpunk scripted agent', '-c', 'user.email=agent@example.invalid', 'commit', '-m', `${name}: implement declared intent`);
    }
    // Both submissions pass against their original base, before any integration.
    const isolated = {};
    for (const name of ['alice', 'bob']) {
      isolated[name] = await runCandidate({ directory: workspaces[name], candidate: await git(workspaces[name], 'rev-parse', 'HEAD'), policy });
      assert.equal(isolated[name].state, 'passed', isolated[name].stderr);
    }
    async function settle(id, expected) {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await server.coordinator.flush();
        const status = server.coordinator.status();
        const item = status.submissions.find(item => item.id === id);
        if (item && !['queued', 'checking', 'awaiting_approval'].includes(item.state)) {
          assert.equal(item.state, expected, JSON.stringify(status));
          return status.checks.find(check => check.id === item.check_id);
        }
        await delay(50);
      }
      throw new Error(`Submission ${id} did not reach ${expected}`);
    }
    await alice.tick();
    const aliceUpload = (await alice.status()).commit.upload_id;
    const aliceCheck = await settle(aliceUpload, 'integrated');
    const firstTarget = await server.gitStore.readRef('refs/heads/main');
    assert.equal(firstTarget, aliceCheck.candidate);
    assert.equal(aliceCheck.target, baseline);
    await bob.tick();
    const failedUpload = (await bob.status()).commit.upload_id;
    const failedCheck = await settle(failedUpload, 'failed');
    assert.equal(failedCheck.target, firstTarget);
    assert.equal(failedCheck.state, 'failed');
    assert.match(failedCheck.result.stderr, /NoneType/);
    assert.equal(await server.gitStore.readRef('refs/heads/main'), firstTarget);
    await bob.tick();
    assert.ok((await bob.status()).inbox.some(event => event.type === 'checks.finished' && event.payload.state === 'failed'));

    // The same agent repairs its intent; the previous failure remains recorded.
    await writeFile(join(workspaces.bob, 'services.py'), 'from models import Car\n\ndef create_car(identifier: int, name: str) -> Car:\n    return Car(identifier, name)\n\ndef is_pending(car: Car) -> bool:\n    return getattr(car, "is_new", False)\n');
    await git(workspaces.bob, 'add', 'services.py');
    await git(workspaces.bob, '-c', 'user.name=Gitpunk scripted agent', '-c', 'user.email=agent@example.invalid', 'commit', '-m', 'Repair combined Car contract');
    await bob.tick();
    const repairUpload = (await bob.status()).commit.upload_id;
    const repairCheck = await settle(repairUpload, 'integrated');
    const finalTarget = await server.gitStore.readRef('refs/heads/main');
    assert.equal(finalTarget, repairCheck.candidate);
    assert.match(await git(server.gitStore.directory, 'show', `${finalTarget}:models.py`), /is_new: bool = True/);
    assert.match(await git(server.gitStore.directory, 'show', `${finalTarget}:services.py`), /def is_pending/);
    for (const participant of [alice, bob]) {
      await participant.tick();
      const status = await participant.status();
      assert.equal(status.commit.checked, true);
      assert.equal(status.commit.integrated, true);
      assert.equal(status.commit.verification, 'integrated');
      assert.equal(status.target.state, 'fetched');
      assert.equal(status.target.commit, finalTarget);
      assert.equal(await git(participant.options.workspace, 'rev-parse', status.target.git_ref), finalTarget);
    }
    for (const name of ['alice', 'bob']) assert.equal(await git(workspaces[name], 'diff', '--cached'), before[name]);
    const receipt = {
      mode: 'local-development; scripted agents; explicit automatic demo policy', workspaces,
      individual_checks: { alice: isolated.alice.state, bob: isolated.bob.state },
      checks: [aliceCheck, failedCheck, repairCheck], canonical: finalTarget,
      integrated: [aliceUpload, repairUpload], rejected_combination: failedUpload,
      assertions: ['Both changes pass separately', 'Clean combined merge fails owner contract', 'Failure leaves canonical branch unchanged', 'Repair preserves both agent changes', 'Both clients fetch the exact combined canonical commit into private refs', 'Client staging remains unchanged', 'Each check binds exact candidate, target, pinned image and policy'],
      integration: server.coordinator.status(),
    };
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return { receipt: join(root, 'receipt.json'), canonical: finalTarget, individual_checks: receipt.individual_checks, combined_checks: receipt.checks.map(check => ({ state: check.state, target: check.target, candidate: check.candidate })), integrated: receipt.integrated.length, failed: 1 };
  } finally { alice?.close(); bob?.close(); await server.stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(await runCheckedDemo({ root: resolve('.local', `checked-demo-${Date.now()}`) }), null, 2) + '\n');
