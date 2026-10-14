import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { git, head } from '../client/git.js';
import { GitpunkClient } from '../client/index.js';
import { SourceCache } from '../client/source.js';
import { createGitpunkServer } from '../server/index.js';

const jobs = 8, selected = 'pkg/code.py', sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function size(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) bytes += entry.isDirectory() ? await size(join(directory, entry.name)) : (await stat(join(directory, entry.name))).size;
  return bytes;
}
async function corpus(source) {
  for (const path of ['assets', 'pkg', 'parts', 'tests']) await mkdir(join(source, path), { recursive: true });
  for (let i = 0; i < 128; i++) await writeFile(join(source, `assets/${i}.bin`), createHash('shake256', { outputLength: 128 * 1024 }).update(`gitpunk-fixture-${i}`).digest());
  for (let i = 0; i < jobs; i++) await writeFile(join(source, `parts/part_${i}.py`), 'value = 0\n');
  const expected = pbkdf2Sync('gitpunk', 'fixed-salt', 600_000, 32, 'sha256').toString('hex');
  await writeFile(join(source, 'tests/test_contract.py'), `import hashlib, importlib, unittest
class Contract(unittest.TestCase):
    def test_parts(self):
        for i in range(${jobs}): self.assertIn(importlib.import_module(f'parts.part_{i}').value, (0, 1))
    def test_checksum(self):
        self.assertEqual(hashlib.pbkdf2_hmac('sha256', b'gitpunk', b'fixed-salt', 600000).hex(), '${expected}')
`);
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.name', 'Gitpunk benchmark'); await git(source, 'config', 'user.email', 'benchmark@example.invalid');
  // File transport uses real upload-pack filtering, rather than local hard-link clones.
  await git(source, 'config', 'uploadpack.allowFilter', 'true'); await git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (let revision = 0; revision < 32; revision++) {
    await writeFile(join(source, selected), `revision = ${revision}\n` + '# selected source\n'.repeat(256));
    await git(source, 'add', '.'); await git(source, 'commit', '-m', `History ${revision}`);
  }
}
async function queries(root, source) {
  const wanted = await readFile(join(source, selected)), checksum = sha(wanted);
  const results = [];
  for (const partial of [false, true]) {
    const directory = join(root, partial ? 'partial' : 'full'); await mkdir(directory);
    const started = performance.now(); let retained = 0, gitBytes = 0;
    for (let i = 0; i < jobs; i++) {
      const workspace = join(directory, String(i));
      await git(root, 'clone', ...(partial ? ['--filter=blob:none', '--no-checkout'] : []), pathToFileURL(source).href, workspace);
      if (partial) { await git(workspace, 'sparse-checkout', 'set', '--no-cone', selected); await git(workspace, 'checkout', 'main'); }
      assert.equal(sha(await readFile(join(workspace, selected))), checksum);
      retained += await size(workspace); gitBytes += await size(join(workspace, '.git'));
    }
    results.push({ mode: partial ? 'Git partial clone + sparse checkout' : 'Git full clone', jobs, wall_ms: Math.round(performance.now() - started), retained_bytes: retained, retained_git_bytes: gitBytes });
  }
  const app = await createGitpunkServer({ dataDir: join(root, 'api-server'), port: 0, bootstrap: true, gitSource: source });
  const started = await app.start(); let bodyBytes = 0;
  const identity = app.fixture.identities.alice, commit = await head(source), sharedCache = join(root, 'node-cache');
  const query = async input => {
    const response = await fetch(`${started.endpoint}/v1/repos/demo/git`, { method: 'POST', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const text = await response.text(); bodyBytes += Buffer.byteLength(text);
    assert.equal(response.status, 200, text); return JSON.parse(text).data;
  };
  try {
    for (const pass of ['cold node cache', 'warm node cache']) {
      const directory = join(root, pass.startsWith('cold') ? 'api-cold' : 'api-warm'); await mkdir(directory);
      const before = bodyBytes, started = performance.now(); let downloaded = 0;
      for (let i = 0; i < jobs; i++) {
        const cache = new SourceCache(query, sharedCache);
        await cache.materialize(commit, [selected], join(directory, String(i)));
        downloaded += cache.downloaded;
        assert.equal(sha(await readFile(join(directory, String(i), selected))), checksum);
      }
      results.push({ mode: `Gitpunk ${pass}`, jobs, wall_ms: Math.round(performance.now() - started), retained_bytes: await size(directory), shared_cache_bytes: await size(sharedCache), api_response_body_bytes: bodyBytes - before, downloaded_file_bytes: downloaded, git_checkouts: 0 });
    }
    return { selected, selected_bytes: wanted.length, sha256: checksum, baseline_measurement: 'Retained logical file bytes; Git wire traffic is not measured. API bytes count JSON response bodies only.', results, server_cache: app.sourceStore.stats() };
  } finally { await app.stop(); }
}
async function checks(root, source, concurrency) {
  const configured = JSON.parse(await readFile(new URL('../infra/checks.example.json', import.meta.url), 'utf8'));
  const policy = { ...configured, approval: 'automatic', source_paths: ['parts', 'tests'], check_concurrency: concurrency };
  const app = await createGitpunkServer({ dataDir: join(root, `checks-${concurrency}`), port: 0, bootstrap: true, gitSource: source, checkPolicy: policy });
  const startChecks = app.coordinator.start;
  app.coordinator.start = () => {}; // Stage equal queues before starting each measured run.
  const started = await app.start(), clients = [];
  try {
    for (let i = 0; i < jobs; i++) {
      const workspace = join(root, `writer-${concurrency}-${i}`); await mkdir(workspace);
      const client = await GitpunkClient.create({ credentials: started.fixture_path, identity: 'alice', workspace, remote: true, stateDir: `${workspace}-state`, cacheDir: join(root, 'writer-cache'), debounceMs: 0 }); clients.push(client);
      const path = `parts/part_${i}.py`;
      await client.work({ title: `Part ${i}`, type: 'change', summary: 'Advance one independent part.', files: [path], done_when: ['Combined owner contract passes'] });
      await writeFile(join(workspace, path), 'value = 1\n');
      await client.observeFiles(); await client.observeFiles(); await client.flush();
      await client.respond({ action: 'commit', message: `Update part ${i}` });
    }
    const startedAt = performance.now(), deadline = Date.now() + 120_000;
    startChecks();
    let status;
    while (Date.now() < deadline) {
      await app.coordinator.flush(); status = app.coordinator.status();
      if (status.submissions.length === jobs && status.submissions.every(row => row.state === 'integrated')) break;
      assert.ok(!status.submissions.some(row => ['failed', 'conflict'].includes(row.state)), JSON.stringify(status));
      await delay(20);
    }
    assert.equal(status.submissions.filter(row => row.state === 'integrated').length, jobs, 'All exact candidates must integrate.');
    const wall_ms = Math.round(performance.now() - startedAt), target = await app.gitStore.readRef('refs/heads/main');
    for (let i = 0; i < jobs; i++) assert.equal(await git(app.gitStore.directory, 'show', `${target}:parts/part_${i}.py`), 'value = 1');
    assert.equal(status.checks.length, jobs);
    assert.ok(status.checks.every(row => row.state === 'passed' && row.result.cleanup === 'complete' && row.result.candidate === row.candidate && row.result.target === row.target && row.result.policy_hash === row.policy_hash));
    return { jobs, check_concurrency: concurrency, wall_ms, peak_checks: status.peak_checks, checks_started: status.checks_started, integrated: jobs, image: policy.image, source_paths: policy.source_paths, exported_bytes_per_check: status.checks.map(row => row.result.source.bytes), checks: status.checks.map(row => ({ target: row.target, candidate: row.candidate, policy_hash: row.policy_hash, state: row.state })), target, cloud_writes: false };
  } finally { for (const client of clients) client.close(); await app.stop(); }
}
export async function benchmark() {
  await mkdir(resolve('.local'), { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve('.local/scale-'));
  const source = join(root, 'source'); await mkdir(source);
  process.stdout.write('Building the deterministic local fixture.\n'); await corpus(source);
  const report = { date: new Date().toISOString(), node: process.version, git: await git(root, '--version'), source_commit: await head(source), fixture: { history_commits: 32, unrelated_binary_bytes: 16 * 1024 * 1024, jobs }, limitations: ['One Mac; filesystem/Docker caches are not reset.', 'Eight scripted submissions under one development owner; no real model calls.', 'Automatic approval is an explicit benchmark policy; the MVP default remains manual.', 'Two local cache levels; no distributed backend or Anthropic-scale load is claimed.'] };
  process.stdout.write('Comparing full clones, native Git partial/sparse clones and scoped API snapshots.\n'); report.source = await queries(root, source);
  report.checks = [];
  for (const concurrency of [1, 4]) { process.stdout.write(`Running eight real Docker checks with concurrency ${concurrency}.\n`); report.checks.push(await checks(root, source, concurrency)); }
  const receipt = join(root, 'receipt.json'); await writeFile(receipt, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { receipt, source: report.source.results, checks: report.checks.map(({ checks, ...summary }) => summary) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(await benchmark(), null, 2) + '\n');
