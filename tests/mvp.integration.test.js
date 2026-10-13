import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startMvp } from '../scripts/mvp.js';
import { head, git } from '../client/git.js';
import { agentStatus } from '../client/mcp.js';

const entrypoint = fileURLToPath(new URL('../client/mcp.js', import.meta.url));
const intent = { title: 'Add Car CRUD', type: 'feature', summary: 'Implement the car service contract.', files: ['services.py'], done_when: ['CRUD contract passes'], sharing: 'summary' };
async function agent(t, profile, mode) {
  const client = new Client({ name: 'gitpunk-mvp-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint, '--profile', profile], stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, call: async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { error: Boolean(response.isError), data: JSON.parse(response.content.find(item => item.type === 'text').text) };
  } };
}

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`MVP: two MCP agents share saved WIP and block overlap (${JSON.stringify(mode)})`, { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-mvp-'));
  const app = await startMvp({ root, port: 0, checks: false });
  t.after(async () => { await app.stop(); await rm(root, { recursive: true, force: true }); });
  const alice = await agent(t, app.receipt.profiles.alice, mode), bob = await agent(t, app.receipt.profiles.bob, mode);
  assert.deepEqual((await alice.client.listTools()).tools.map(tool => tool.name).sort(), ['gitpunk_respond', 'gitpunk_status', 'gitpunk_work']);
  const credentials = JSON.parse(await readFile(join(root, 'alice.credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(credentials.identities), ['alice']);
  assert.equal((await stat(join(root, 'board.profile.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(join(root, 'board.profile.json'), 'utf8'))).includes('privateKey'));
  const work = await alice.call('gitpunk_work', { intent });
  assert.equal(work.data.state, 'active');
  assert.equal((await alice.call('gitpunk_respond', { response: { action: 'prepare_write', files: intent.files } })).data.state, 'prepared');
  const file = join(app.receipt.workspaces.alice, 'services.py');
  const draft = (await readFile(file, 'utf8')) + '\n# Saved before committing: MCP collaboration.\n';
  await writeFile(file, draft);
  const deadline = Date.now() + 8000;
  let status;
  while (Date.now() < deadline) { status = (await bob.call('gitpunk_status')).data; if (status.checkpoints.length) break; await delay(100); }
  assert.ok(status.checkpoints.length, 'Background sync must publish the save to the peer');
  const checkpoint = await bob.call('gitpunk_status', { checkpoint_id: status.checkpoints[0].id });
  assert.equal(checkpoint.data.content, draft);
  assert.equal(checkpoint.data.text_trust, 'untrusted');
  assert.equal(await git(app.receipt.workspaces.alice, 'diff', '--cached', '--name-only'), '');
  const overlap = await bob.call('gitpunk_work', { intent: { ...intent, title: 'Review car services' } });
  assert.equal(overlap.data.state, 'blocked');
  const denied = await bob.call('gitpunk_respond', { response: { action: 'prepare_write', files: intent.files } });
  assert.equal(denied.error, true); assert.equal(denied.data.code, 'overlap');
  const protectedWork = await alice.call('gitpunk_work', { intent: { ...intent, files: ['data/database.sqlite'] } });
  assert.equal(protectedWork.error, true); assert.equal(protectedWork.data.code, 'protected_path');
  const markup = await (await fetch(app.receipt.board)).text();
  assert.match(markup, /Work in progress/);
  assert.ok(!markup.includes(credentials.identities.alice.token));
});

test('MVP restart keeps credentials, dirty work, canonical history and accepted intent', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitpunk-restart-'));
  let app;
  try {
    app = await startMvp({ root, port: 0, checks: false });
    const baseline = await head(app.receipt.workspaces.alice);
    const work = await app.clients.alice.work(intent);
    const file = join(app.receipt.workspaces.alice, 'services.py');
    await writeFile(file, 'preserve my unfinished work\n');
    const key = JSON.parse(await readFile(join(root, 'alice.credentials.json'), 'utf8')).identities.alice.privateKey;
    const port = Number(new URL(app.receipt.endpoint).port);
    await app.stop();
    app = await startMvp({ root, port, checks: false });
    assert.equal(await head(app.receipt.workspaces.alice), baseline);
    assert.equal(await readFile(file, 'utf8'), 'preserve my unfinished work\n');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'alice.credentials.json'), 'utf8')).identities.alice.privateKey, key);
    assert.equal((await app.clients.alice.status()).work.id, work.intent_id);
  } finally { await app?.stop(); await rm(root, { recursive: true, force: true }); }
});

test('agent summaries exclude opt-in raw prompts/context from other intents', () => {
  const summary = agentStatus({ connection: { state: 'connected' }, inbox: [], counts: {}, errors: [], server: { intents: [{ id: 'peer', title: 'Peer', summary: 'Public summary', prompt: 'private transcript', context: { secret: 'private context' }, files: ['services.py'] }], decisions: [], checkpoints: [], handoffs: [] } });
  assert.ok(!JSON.stringify(summary).includes('private transcript'));
  assert.ok(!JSON.stringify(summary).includes('private context'));
});

test('frequent saves and check logs do not crowd out agent status', () => {
  const checkpoints = Array.from({ length: 100 }, (_, index) => ({ id: `draft-${index}`, intent_id: 'peer', path: 'services.py' }));
  checkpoints.unshift({ id: 'model-draft', intent_id: 'peer', path: 'models.py' });
  const summary = agentStatus({ inbox: [], server: { checkpoints, integration: { submissions: [], checks: [{ id: 'check-1', target: 'a'.repeat(40), candidate: 'b'.repeat(40), result: { state: 'failed', stderr: 'large test log'.repeat(100_000) } }], operations: [] } } });
  assert.ok(summary.checkpoints.some(item => item.id === 'model-draft'), 'An active file must remain visible despite saves to another file');
  assert.equal(summary.integration.checks[0].result.state, 'failed');
  assert.ok(JSON.stringify(summary).length < 4096, 'Routine replies must not contain the entire test log');
});
