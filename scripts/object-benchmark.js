import assert from 'node:assert/strict';
import { createHash, randomFillSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { localObjects } from './local-objects.js';
import { objectClient } from '../server/object-client.js';
import { createGitpunkServer } from '../server/index.js';
import { GitpunkClient } from '../client/index.js';

const { values } = parseArgs({ options: { 'history-gib': { type: 'string', default: '1' }, 'worktree-gib': { type: 'string', default: '0.25' }, 'dense-mib': { type: 'string', default: '64' }, commits: { type: 'string', default: '256' }, jobs: { type: 'string', default: '16' }, seconds: { type: 'string', default: '60' } } });
const history = Number(values['history-gib']) * 1024 ** 3, worktree = Number(values['worktree-gib']) * 1024 ** 3, dense = Number(values['dense-mib']) * 1024 ** 2, jobs = Number(values.jobs), seconds = Number(values.seconds), chunk = 2 * 1024 ** 2;
const historyCommits = Number(values.commits);
if (!Number.isInteger(historyCommits) || historyCommits < 0 || historyCommits > 3000) throw new Error('Use 0..3000 additional history commits.');
if (![history, worktree, dense].every(size => Number.isSafeInteger(size) && size % chunk === 0) || dense < 0 || dense >= worktree || history < worktree || history > 100 * 1024 ** 3 || !Number.isInteger(jobs) || jobs < 2 || jobs > 128 || !Number.isFinite(seconds) || seconds < 1 || seconds > 600) throw new Error('Use 2 MiB multiples, history <=100 GiB, 2..128 jobs and 1..600 seconds.');
const root = await mkdtemp(resolve('.local/object-scale-')); let cloud, app; const clients = [];
const receipt = { started_at: new Date().toISOString(), runtime: 'local workerd / R2 / SQLite Durable Objects', cloud_writes: false, llm_calls: 0, fixture: { logical_history_bytes: 0, logical_worktree_bytes: 0, dense_blob_bytes: dense, objects: 0, compressible_fixture: true }, evidence: {} };
const save = () => writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const percentile = (data, q) => [...data].sort((a,b) => a-b)[Math.floor((data.length - 1) * q)];
async function disk(dir) { let size = 0; for (const entry of await readdir(dir, { withFileTypes: true })) size += entry.isDirectory() ? await disk(join(dir, entry.name)) : (await stat(join(dir, entry.name))).size; return size; }
try {
  cloud = await localObjects(join(root, 'cloud'), { requests: 500_000, bytes: 4 * 1024 ** 3 }); const remote = objectClient(cloud);
  let uploaded = 0;
  async function put(type, bytes, count = true) {
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]), id = createHash('sha1').update(raw).digest('hex');
    const stored = await remote.put(id, raw); if (count && stored.created) { receipt.fixture.objects++; if (type === 'blob') receipt.fixture.logical_history_bytes += bytes.length; }
    if (++uploaded % 2048 === 0) { process.stdout.write(JSON.stringify({ object_put_attempts: uploaded, logical_fixture_gib: Number((receipt.fixture.logical_history_bytes / 1024 ** 3).toFixed(2)) }) + '\n'); await save(); }
    return id;
  }
  const tree = entries => put('tree', Buffer.concat([...entries].sort(([a],[b]) => a.localeCompare(b)).flatMap(([name, entry]) => [Buffer.from(`${entry.mode || '100644'} ${name}\0`), Buffer.from(entry.oid, 'hex')])));
  const commit = (tree, parent, title, count = true) => put('commit', Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Fixture <fixture@example.invalid> 1791936000 +0000\ncommitter Fixture <fixture@example.invalid> 1791936000 +0000\n\n${title}\n`), count);
  async function fill(count, action) { let next = 0; await Promise.all(Array.from({ length: 8 }, async () => { for (;;) { const index = next++; if (index >= count) return; await action(index); } })); }
  const files = new Map(), archives = new Map(), denseEntries = new Map(), parts = new Map();
  for (const file of ['models.py','services.py']) files.set(file, { oid: await put('blob', Buffer.from('value = 0\n')) });
  for (let i = 0; i < jobs; i++) parts.set(`part-${i.toString().padStart(4,'0')}.py`, { oid: await put('blob', Buffer.from(`slot = 0  # ${i}\n`)) });
  files.set('parts', { mode: '40000', oid: await tree(parts) });
  await fill(dense / chunk, async i => { const bytes = Buffer.allocUnsafe(chunk); randomFillSync(bytes); denseEntries.set(`data-${i.toString().padStart(6,'0')}.bin`, { oid: await put('blob', bytes) }); });
  if (denseEntries.size) files.set('dense', { mode: '40000', oid: await tree(denseEntries) });
  const archiveFiles = (worktree - dense) / chunk, archiveObjects = (history - dense) / chunk;
  let base, first, rootTree;
  for (let offset = 0; offset < archiveObjects; offset += archiveFiles) {
    const count = Math.min(archiveFiles, archiveObjects - offset);
    await fill(count, async i => { const bytes = Buffer.alloc(chunk); bytes.write(`unique-object-${offset + i}\n`); archives.set(`file-${i.toString().padStart(6,'0')}.bin`, { oid: await put('blob', bytes) }); });
    files.set('archive', { mode: '40000', oid: await tree(archives) }); rootTree = await tree(files);
    base = await commit(rootTree, base, `History version ${offset / archiveFiles}`); first ||= base;
  }
  for (let i = 0; i < historyCommits; i++) base = await commit(rootTree, base, `Metadata history ${i}`);
  receipt.fixture.history_commits = historyCommits + Math.ceil(archiveObjects / archiveFiles);
  await remote.cas(null, base, 'trusted-import');
  receipt.fixture.logical_worktree_bytes = worktree + 20 + [...parts.keys()].reduce((n, _, i) => n + Buffer.byteLength(`slot = 0  # ${i}\n`), 0);
  const bucket = await cloud.runtime.getR2Bucket('OBJECTS'); let cursor, storedBytes = 0;
  do { const page = await bucket.list({ prefix: 'demo/', cursor, limit: 1000 }); storedBytes += page.objects.reduce((n, entry) => n + entry.size, 0); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  receipt.fixture.compressed_r2_object_bytes = storedBytes;
  receipt.fixture.physical_runtime_bytes = await disk(join(root, 'cloud')); receipt.fixture.base = base; await save();
  const config = join(root, 'objects.json'); await writeFile(config, JSON.stringify({ endpoint: cloud.endpoint, token: cloud.token, repo: 'demo', base }), { mode: 0o600 });
  const policy = { image: 'python@sha256:3dd7cc108ec1493442514f5c2a871af6af0ec31d768ff6e378a93340c3b3db5f', command: ['python','-c', `import ast,pathlib; files=list(pathlib.Path('parts').glob('*.py')); assert len(files)==${jobs}; [ast.parse(p.read_text()) for p in files]; assert sum(i*i for i in range(600000)) > 0`], source_paths: ['parts'], approval: 'automatic', check_concurrency: 4 };
  app = await createGitpunkServer({ dataDir: join(root, 'server'), port: 0, bootstrap: true, objectConfig: config, checkPolicy: policy }); const started = await app.start();
  for (const name of ['alice','bob']) { const workspace = join(root, name); await mkdir(workspace); clients.push(await GitpunkClient.create({ credentials: started.fixture_path, identity: name, remote: true, workspace, stateDir: join(root, `${name}-state`), cacheDir: join(root, 'client-cache'), debounceMs: 0 })); }
  const latencies = []; const wanted = Buffer.from('value = 0\n');
  for (let i = 0; i < 32; i++) { const start = performance.now(), result = await clients[i % 2].source({ action: 'file', commit: base, path: 'models.py' }); assert.equal(digest(Buffer.from(result.content_base64, 'base64')), digest(wanted)); latencies.push(performance.now() - start); }
  const before = app.gitStore.stats(); assert.ok(before.downloaded_bytes < 4 * 1024 * 1024, JSON.stringify(before));
  receipt.evidence.selected_reads = { count: latencies.length, p50_ms: percentile(latencies, .5), p95_ms: percentile(latencies, .95), sha256: digest(wanted), backend: before };
  const pipelineStart = performance.now(); let lastProgress = performance.now();
  await Promise.all(clients.map(async (client, owner) => { for (let i = owner; i < jobs; i += clients.length) {
    const file = `parts/part-${i.toString().padStart(4,'0')}.py`;
    const declared = await client.work({ title: `Update slot ${i}`, summary: 'Change one selected file.', type: 'change', files: [file], done_when: ['Pinned Docker contract passes'] });
    await client.prepareWrite({ action: 'prepare_write', files: [file] });
    await writeFile(join(client.options.workspace, file), `slot = ${i + 1}\n`); await client.observeFiles(); await client.observeFiles(); await client.flush();
    await client.respond({ action: 'commit', message: `Update slot ${i}` }); await client.respond({ action: 'finish', intent_id: declared.intent.id });
    if (performance.now() - lastProgress > 30_000) { process.stdout.write(JSON.stringify({ submitted: i + 1, integrated: app.coordinator.status().operations.filter(row => row.state === 'integrated').length }) + '\n'); lastProgress = performance.now(); }
  } }));
  const deadline = Date.now() + 600_000;
  while (app.coordinator.status().submissions.filter(row => row.state === 'integrated').length < jobs && Date.now() < deadline) {
    await app.coordinator.flush(); const state = app.coordinator.status(); if (state.submissions.some(row => ['failed','conflict'].includes(row.state))) throw new Error(JSON.stringify(state));
    if (performance.now() - lastProgress > 30_000) { process.stdout.write(JSON.stringify({ integrated: state.operations.filter(row => row.state === 'integrated').length, jobs }) + '\n'); lastProgress = performance.now(); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(app.coordinator.status().submissions.filter(row => row.state === 'integrated').length, jobs);
  const elapsed = (performance.now() - pipelineStart) / 1000, canonical = await remote.head();
  for (let i = 0; i < jobs; i++) assert.equal(Buffer.from((await clients[0].source({ action: 'file', commit: canonical, path: `parts/part-${i.toString().padStart(4,'0')}.py` })).content_base64, 'base64').toString(), `slot = ${i + 1}\n`);
  assert.deepEqual(await readdir(join(root, 'server', 'object-caches')), []);
  receipt.evidence.checked_integrations = { jobs, elapsed_seconds: elapsed, observed_per_second: jobs / elapsed, equivalent_per_day: jobs / elapsed * 86400, includes: 'Signed intent, draft, server commit, real Docker check and DO admission; short local trial, not a 24-hour capacity claim.', backend: app.gitStore.stats(), peak_checks: app.coordinator.status().peak_checks };
  await app.stop(); app = null;
  const raw = await remote.get(canonical); rootTree = raw.subarray(raw.indexOf(0) + 1).toString().match(/^tree ([a-f0-9]{40})/)[1];
  let head = canonical, updates = 0; const timings = [], updateStart = performance.now();
  while (performance.now() - updateStart < seconds * 1000 && updates < 50_000) {
    const start = performance.now(), next = await commit(rootTree, head, `Head update ${updates}`, false);
    await remote.cas(head, next, `load-${updates}`); assert.equal((await remote.receipt(`load-${updates}`)).candidate, next); head = next; updates++; timings.push(performance.now() - start);
  }
  receipt.evidence.branch_updates = { updates, elapsed_seconds: (performance.now() - updateStart) / 1000, p50_ms: percentile(timings,.5), p95_ms: percentile(timings,.95), includes: 'Object PUT, durable conditional head update and receipt read; excludes merge computation and CI.' };
  assert.equal(await remote.head(), head); receipt.evidence.source_cache = clients[0].sourceCache ? 'SHA-256 verified' : null; receipt.completed_at = new Date().toISOString(); receipt.state = 'passed';
  await save(); process.stdout.write(JSON.stringify({ receipt: join(root, 'receipt.json'), ...receipt }, null, 2) + '\n');
} catch (error) { receipt.state = 'failed'; receipt.error = error.message; await save(); throw error; }
finally { for (const client of clients) client.close(); await app?.stop(); await cloud?.stop(); }
