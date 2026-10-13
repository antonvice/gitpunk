import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitpunkServer } from '../server/index.js';
import { GitpunkClient } from '../client/index.js';
import { git } from '../client/git.js';
import { createWorkspaces } from './git-fixture.js';

/** Real Git clones and HTTP clients; no model or cloud credentials are needed. */
export async function runDemo({ root, kafkaBrokers = [] }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspaces = await createWorkspaces(root);
  const dataDir = join(root, 'server');
  let server = await createGitpunkServer({ dataDir, bootstrap: true, port: 0, kafkaBrokers, gitSource: workspaces.source });
  let alice, bob, consumer;
  const received = new Set();
  try {
    const started = await server.start();
    if (kafkaBrokers.length) {
      const { Kafka, logLevel } = await import('kafkajs');
      consumer = new Kafka({ clientId: 'gitpunk-demo', brokers: kafkaBrokers, logLevel: logLevel.NOTHING }).consumer({ groupId: `gitpunk-demo-${randomUUID()}` });
      await consumer.connect();
      await consumer.subscribe({ topic: 'gitpunk.events.v1', fromBeginning: true });
      await consumer.run({ eachMessage: async ({ message }) => { received.add(JSON.parse(message.value.toString()).event_id); } });
    }
    const options = name => ({ credentials: started.fixture_path, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`), debounceMs: 0, ...(name === 'bob' ? { upload: true } : {}) });
    alice = await GitpunkClient.create(options('alice'));
    bob = await GitpunkClient.create(options('bob'));
    const intent = JSON.parse(await readFile(new URL('../examples/cars/intent.json', import.meta.url), 'utf8'));
    const work = await alice.work(intent);
    assert.equal(work.state, 'active');
    await alice.tick();
    await bob.tick();
    assert.ok((await bob.status()).inbox.some(event => event.type === 'intent.changed'));

    // A second intent on the same file is blocked until the agent acknowledges it.
    const overlap = await bob.work({ ...intent, title: 'Review car services', files: ['services.py'] });
    assert.equal(overlap.state, 'blocked');
    await bob.respond({ action: 'overlap', intent_id: overlap.intent_id, peer_intent_id: work.intent_id, peer_revision: work.revision, expected_revision: overlap.revision, mode: 'wait' });
    await bob.respond({ action: 'cancel', intent_id: overlap.intent_id });

    const proposed = await alice.respond({ action: 'decision', intent_id: work.intent_id, title: 'Car IDs are strings', description: 'The model and CRUD API use stable string IDs; callers supply the ID.' });
    await bob.respond({ action: 'decision_accept', decision_id: proposed.id });
    const drafts = {
      'models.py': (await readFile(join(workspaces.alice, 'models.py'), 'utf8')) + '\n# Shared choice: stable string IDs.\n',
      'services.py': (await readFile(join(workspaces.alice, 'services.py'), 'utf8')) + '\n\ndef read_car(cars, car_id):\n    return cars[car_id]\n',
    };
    for (const [file, content] of Object.entries(drafts)) await writeFile(join(workspaces.alice, file), content);
    await alice.tick();
    await alice.tick();
    await bob.tick();
    const status = await bob.status();
    const checkpoints = status.server.checkpoints.filter(item => item.intent_id === work.intent_id);
    assert.equal(checkpoints.length, 2);
    assert.equal(status.server.decisions[0].state, 'agreed');
    assert.equal(await git(workspaces.alice, 'diff', '--cached', '--name-only'), '');
    assert.ok(status.inbox.some(event => event.type === 'draft.changed'));
    assert.equal(await readFile(join(workspaces.bob, 'services.py'), 'utf8'), await readFile(join(workspaces.source, 'services.py'), 'utf8'));

    const offer = await alice.respond({ action: 'handoff_offer', intent_id: work.intent_id, checkpoint_id: checkpoints.at(-1).id, to_run_id: server.fixture.identities.bob.run_id, remaining_criteria: ['Implement update/delete and run CRUD tests'] });
    assert.equal(offer.checkpoint_ids.length, 2);
    assert.ok(offer.decision_ids.includes(proposed.id));
    const accepted = await bob.respond({ action: 'handoff_accept', handoff_id: offer.id });
    assert.equal(accepted.state, 'accepted');
    assert.ok((await git(workspaces.bob, 'branch', '--show-current')).startsWith('gitpunk/handoff-'));
    for (const [file, content] of Object.entries(drafts)) assert.equal(await readFile(join(workspaces.bob, file), 'utf8'), content);
    assert.deepEqual((await bob.status()).work.intent.done_when, offer.remaining_criteria);
    assert.equal((await alice.status()).work.state, 'handed_off');

    // The recipient can keep publishing against the inherited base and branch topic.
    await bob.tick();
    await bob.tick();
    await writeFile(join(workspaces.bob, 'services.py'), drafts['services.py'] + '\n# Continuation: add remaining CRUD operations.\n');
    await bob.tick();
    await bob.tick();
    assert.ok((await alice.status()).server.checkpoints.some(item => item.run_id === 'run-b'));

    // Ordinary partial staging is untouched; a commit alone proves no verification.
    await git(workspaces.bob, 'add', 'models.py');
    await git(workspaces.bob, '-c', 'user.name=Gitpunk demo', '-c', 'user.email=demo@example.invalid', 'commit', '-m', 'Document Car ID contract');
    await bob.tick();
    assert.equal((await bob.status()).commit.state, 'committed');
    assert.deepEqual((await bob.status()).commit.files, ['models.py']);
    assert.equal(await git(workspaces.bob, 'diff', '--name-only'), 'services.py');
    const uploadStatus = await bob.status();
    assert.equal(uploadStatus.commit.upload, 'uploaded');
    const upload = uploadStatus.server.uploads.find(item => item.commit === uploadStatus.commit.commit);
    assert.equal(upload.state, 'uploaded');
    assert.equal(upload.manifest.intent_id, accepted.intent.id);
    assert.deepEqual(upload.manifest.files.map(item => item.path), ['models.py']);
    assert.ok((await alice.tick()).events.some(event => event.type === 'commit.uploaded'));

    // Fetch into a private ref; Alice's dirty code and index remain untouched.
    const beforeFetch = { head: await git(workspaces.alice, 'rev-parse', 'HEAD'), diff: await git(workspaces.alice, 'diff'), index: await git(workspaces.alice, 'diff', '--cached') };
    const fetched = await alice.respond({ action: 'fetch_commit', commit_id: upload.id });
    assert.equal(fetched.state, 'fetched');
    assert.equal(await git(workspaces.alice, 'rev-parse', fetched.git_ref), upload.commit);
    assert.equal(await git(workspaces.alice, 'show', `${fetched.git_ref}:models.py`), drafts['models.py'].trimEnd());
    assert.deepEqual({ head: await git(workspaces.alice, 'rev-parse', 'HEAD'), diff: await git(workspaces.alice, 'diff'), index: await git(workspaces.alice, 'diff', '--cached') }, beforeFetch);

    const cursor = (await bob.status()).cursor;
    const eventIds = server.db.prepare('SELECT event_id FROM events ORDER BY id').all().map(row => row.event_id);
    if (consumer) {
      await server.dispatcher.flush();
      const deadline = Date.now() + 20_000;
      while (eventIds.some(id => !received.has(id)) && Date.now() < deadline) await delay(100);
      assert.ok(eventIds.every(id => received.has(id)), 'Independent Kafka consumer must receive every accepted demo event');
      assert.equal(server.dispatcher.status().pending, 0);
    }

    // Restart both service and subscriber: event cursor and domain state survive.
    bob.close(); bob = null;
    await server.stop();
    server = await createGitpunkServer({ dataDir, bootstrap: true, port: started.port, kafkaBrokers });
    await server.start();
    bob = await GitpunkClient.create(options('bob'));
    await bob.tick();
    const resumed = await bob.status();
    assert.ok(resumed.cursor >= cursor);
    assert.equal(resumed.server.decisions[0].state, 'agreed');
    assert.equal(resumed.server.handoffs[0].state, 'accepted');
    assert.equal(resumed.server.uploads[0].commit, upload.commit);
    assert.equal(resumed.commit.upload, 'uploaded');
    assert.equal(new Set(resumed.inbox.map(event => event.seq)).size, resumed.inbox.length);
    const receipt = { mode: 'local-development', workspaces, accepted_events: eventIds.length, signed_checkpoints: resumed.server.checkpoints.length, decisions: 'agreed and persisted', handoff: 'two pinned files restored; recipient continues', git_index: 'unchanged by sync; partial commit preserved', upload: 'exact staged commit and signed provenance stored on an isolated working ref', peer_fetch: 'authenticated commit fetched; dirty work preserved', restart: 'server state, upload receipt and subscriber cursor persisted', kafka: consumer ? 'independent consumer verified all accepted events' : 'not configured', verification: 'checks not configured in this demo; uploads remain unverified' };
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally {
    alice?.close(); bob?.close();
    if (consumer) await consumer.disconnect();
    await server.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve('.local', `demo-${Date.now()}`);
  const receipt = await runDemo({ root, kafkaBrokers: process.argv.includes('--kafka') ? ['127.0.0.1:9092'] : [] });
  process.stdout.write(JSON.stringify({ ...receipt, receipt: join(root, 'receipt.json') }, null, 2) + '\n');
}
