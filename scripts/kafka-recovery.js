import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Kafka, logLevel } from 'kafkajs';
import { createGitpunkServer } from '../server/index.js';
import { GitpunkClient } from '../client/index.js';
import { createWorkspaces } from './git-fixture.js';
import { exampleIntent } from '../shared/index.js';

const exec = promisify(execFile);
const compose = (...args) => exec('docker', ['compose', '-f', fileURLToPath(new URL('../infra/compose.yaml', import.meta.url)), ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 });

/** Explicitly stop/restart only Gitpunk's loopback development broker. */
export async function runKafkaRecovery({ root }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspaces = await createWorkspaces(root);
  const dataDir = join(root, 'server');
  let server, alice, consumer;
  try {
    await compose('stop', 'kafka');
    const start = async () => {
      server = await createGitpunkServer({ dataDir, port: 0, bootstrap: true, kafkaBrokers: ['127.0.0.1:9092'] });
      return server.start();
    };
    const first = await start();
    const options = { credentials: first.fixture_path, identity: 'alice', workspace: workspaces.alice, stateDir: join(root, 'alice-state') };
    alice = await GitpunkClient.create(options);
    await alice.work(exampleIntent);
    const event = server.db.prepare('SELECT event_id FROM events ORDER BY id LIMIT 1').get().event_id;
    const accepted = await alice.status();
    assert.equal(accepted.server.intents.length, 1);
    assert.equal(server.dispatcher.status().pending, 1);
    await alice.tick();
    assert.ok((await alice.status()).inbox.some(item => item.event_id === event));
    alice.close(); alice = null;
    await server.stop(); server = null;
    await start(); // SQLite/outbox survives service restart while the broker is still down.
    assert.equal(server.dispatcher.status().pending, 1);
    await compose('start', 'kafka');
    consumer = new Kafka({ clientId: 'gitpunk-recovery-proof', brokers: ['127.0.0.1:9092'], logLevel: logLevel.NOTHING, retry: { retries: 10 } }).consumer({ groupId: `gitpunk-recovery-${randomUUID()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: 'gitpunk.events.v1', fromBeginning: true });
    const received = [];
    await consumer.run({ eachMessage: async ({ message }) => { const value = JSON.parse(message.value.toString()); if (value.event_id === event) received.push(value); } });
    const deadline = Date.now() + 30_000;
    while ((server.dispatcher.status().pending || !received.length) && Date.now() < deadline) { await server.dispatcher.flush(); await delay(100); }
    assert.equal(server.dispatcher.status().pending, 0);
    assert.ok(received.length >= 1);
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id=?').get(event).n, 1);
    const receipt = { mode: 'local-development; real Kafka', event_id: event, assertions: ['HTTP accepts and replays intent while broker is down', 'Pending outbox survives server restart', 'Recovered broker receives the same durable event', 'Delivery acknowledged without duplicating authoritative event'], kafka_deliveries: received.length, authoritative_events: 1, pending: 0 };
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return { ...receipt, receipt: join(root, 'receipt.json') };
  } finally { alice?.close(); await consumer?.disconnect().catch(() => {}); await server?.stop(); await compose('start', 'kafka'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(await runKafkaRecovery({ root: resolve('.local', `kafka-recovery-${Date.now()}`) }), null, 2) + '\n');
