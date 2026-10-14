import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { git } from '../client/git.js';

/** A visible, repeatable scripted example; uses the same MCP tools as coding agents. */
export async function runMvpExample(root = '.local/mvp') {
  root = resolve(root);
  const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  assert.equal(runtime.mode, 'local-development');
  assert.equal(runtime.workspaces.source, join(root, 'source'), 'Example only runs on its generated starter repository');
  for (const workspace of [runtime.workspaces.alice, runtime.workspaces.bob]) {
    if (runtime.remote) assert.equal((await readdir(workspace)).length, 0, 'Remote example requires fresh empty workspaces');
    else assert.equal(await git(workspace, 'status', '--porcelain'), '', 'Example refuses to overwrite unfinished work');
  }
  const agents = {};
  try {
    for (const name of ['alice', 'bob']) {
      const client = new Client({ name: `gitpunk-scripted-${name}`, version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../client/mcp.js', import.meta.url)), '--profile', runtime.profiles[name]], stderr: 'pipe' }));
      agents[name] = { client, async call(tool, args = {}) { const result = await client.callTool({ name: tool, arguments: args }); const data = JSON.parse(result.content.find(item => item.type === 'text').text); assert.ok(!result.isError, `${data.code}: ${data.message}`); return data; } };
    }
    const { alice, bob } = agents;
    assert.equal((await alice.call('gitpunk_status')).intents.length, 0, 'Use a fresh data directory for a new example');
    const work = await alice.call('gitpunk_work', { intent: { title: 'Car model and CRUD services', type: 'feature', summary: 'Add an in-memory CRUD service and tests. Scripted starter example.', files: ['services.py', 'tests/test_crud.py'], done_when: ['CRUD tests pass', 'Existing Car contract still passes'], sharing: 'summary' } });
    const blocked = await bob.call('gitpunk_work', { intent: { title: 'Review the car service contract', type: 'test', summary: 'Review the same service. Must acknowledge the existing work first.', files: ['services.py'], done_when: ['Read the saved draft and its agreed contract'], sharing: 'summary' } });
    assert.equal(blocked.state, 'blocked');
    await alice.call('gitpunk_respond', { response: { action: 'prepare_write', files: ['services.py', 'tests/test_crud.py'] } });
    const decision = await alice.call('gitpunk_respond', { response: { action: 'decision', intent_id: work.intent_id, title: 'Missing cars raise KeyError', description: 'Read, update, and delete consistently reject missing IDs. Duplicate create raises ValueError.' } });
    await bob.call('gitpunk_respond', { response: { action: 'decision_accept', decision_id: decision.id } });
    const service = `from models import Car\n\ndef create_car(identifier: int, name: str) -> Car:\n    return Car(identifier, name)\n\nclass CarService:\n    def __init__(self):\n        self.cars = {}\n\n    def create(self, identifier, name):\n        if identifier in self.cars:\n            raise ValueError("Car already exists")\n        self.cars[identifier] = create_car(identifier, name)\n        return self.cars[identifier]\n\n    def read(self, identifier):\n        return self.cars[identifier]\n\n    def update(self, identifier, name):\n        car = self.read(identifier)\n        car.name = name\n        return car\n\n    def delete(self, identifier):\n        return self.cars.pop(identifier)\n\n    def list(self):\n        return list(self.cars.values())\n`;
    const tests = `import unittest\nfrom services import CarService\n\nclass CrudContract(unittest.TestCase):\n    def test_create_read_update_delete(self):\n        service = CarService()\n        car = service.create(42, "Roadster")\n        self.assertEqual(service.read(42), car)\n        self.assertEqual(service.update(42, "Coupe").name, "Coupe")\n        self.assertEqual(service.list(), [car])\n        self.assertEqual(service.delete(42), car)\n        self.assertEqual(service.list(), [])\n\n    def test_missing_and_duplicate(self):\n        service = CarService()\n        for action in (lambda: service.read(1), lambda: service.update(1, "Car"), lambda: service.delete(1)):\n            with self.assertRaises(KeyError):\n                action()\n        service.create(1, "Car")\n        with self.assertRaises(ValueError):\n            service.create(1, "Duplicate")\n`;
    await mkdir(join(runtime.workspaces.alice, 'tests'), { recursive: true });
    const saveStarted = Date.now();
    await writeFile(join(runtime.workspaces.alice, 'services.py'), service);
    await writeFile(join(runtime.workspaces.alice, 'tests/test_crud.py'), tests);
    let status;
    async function wait(predicate) {
      const deadline = Date.now() + 45_000;
      do { status = await bob.call('gitpunk_status'); if (predicate(status)) return status; await delay(100); } while (Date.now() < deadline);
      throw new Error('Example did not reach the expected server state');
    }
    await wait(value => value.checkpoints.filter(item => item.intent_id === work.intent_id).length === 2);
    const saveToPeerMs = Date.now() - saveStarted;
    const drafts = status.checkpoints.filter(item => item.intent_id === work.intent_id);
    assert.equal((await bob.call('gitpunk_status', { checkpoint_id: drafts.find(item => item.path === 'services.py').id })).content, service);
    await bob.call('gitpunk_respond', { response: { action: 'cancel', intent_id: blocked.intent_id } });
    const offer = await alice.call('gitpunk_respond', { response: { action: 'handoff_offer', intent_id: work.intent_id, checkpoint_id: drafts.at(-1).id, to_run_id: 'run-b', remaining_criteria: ['Commit the two pinned files', 'Pass the combined owner contract'] } });
    const accepted = await bob.call('gitpunk_respond', { response: { action: 'handoff_accept', handoff_id: offer.id } });
    assert.equal(await readFile(join(runtime.workspaces.bob, 'services.py'), 'utf8'), service);
    assert.equal(await readFile(join(runtime.workspaces.bob, 'tests/test_crud.py'), 'utf8'), tests);
    await bob.call('gitpunk_respond', { response: { action: 'prepare_write', files: ['services.py', 'tests/test_crud.py'] } });
    if (runtime.remote) {
      await wait(value => value.checkpoints.filter(item => item.intent_id === accepted.intent.id).length === 2);
      await bob.call('gitpunk_respond', { response: { action: 'commit', message: 'Implement handed-off Car CRUD contract' } });
    } else {
      await git(runtime.workspaces.bob, 'add', 'services.py', 'tests/test_crud.py');
      await git(runtime.workspaces.bob, '-c', 'user.name=Gitpunk scripted example', '-c', 'user.email=example@example.invalid', 'commit', '-m', 'Implement handed-off Car CRUD contract');
    }
    await wait(value => value.integration?.submissions.some(item => item.state === 'awaiting_approval'));
    const submission = status.integration.submissions.find(item => item.state === 'awaiting_approval');
    const check = status.integration.checks.find(item => item.id === submission.check_id);
    const evidence = await bob.call('gitpunk_status', { check_id: check.id });
    assert.equal(evidence.result.state, 'passed');
    // Explicitly scripted owner approval for this generated fixture, never a human-review claim.
    await alice.call('gitpunk_respond', { response: { action: 'approve', submission_id: submission.id, check_id: check.id, target: check.target, candidate: check.candidate, policy_hash: check.policy_hash } });
    await wait(value => value.integration.submissions.some(item => item.id === submission.id && item.state === 'integrated'));
    await bob.call('gitpunk_respond', { response: { action: 'finish', intent_id: accepted.intent.id } });
    const receipt = { mode: 'scripted MCP example; real HTTP/Git/Kafka/Docker; scripted owner approval', remote: runtime.remote || false, board: runtime.board, save_to_peer_ms: saveToPeerMs, intent: work.intent_id, overlap_blocked: true, decision: decision.id, handoff: offer.id, continuation: accepted.intent.id, pinned_files: offer.checkpoint_ids.length, submission: submission.id, check: check.id, canonical: check.candidate, integration: 'integrated', cloud_writes: false, llm_calls: 0 };
    await writeFile(join(root, 'example-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return receipt;
  } finally { await Promise.allSettled(Object.values(agents).map(agent => agent.client.close())); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
  process.stdout.write(JSON.stringify(await runMvpExample(values['data-dir']), null, 2) + '\n');
}
