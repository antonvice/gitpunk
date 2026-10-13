import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCandidate } from './runner.js';
import { git, head } from '../client/git.js';
import { CheckPolicy, canonicalJson, hashContent } from '../shared/index.js';

const exec = promisify(execFile);
const image = 'python@sha256:3dd7cc108ec1493442514f5c2a871af6af0ec31d768ff6e378a93340c3b3db5f';
let available = process.env.GITPUNK_DOCKER_TESTS !== '0';
if (available) { try { await exec('docker', ['image', 'inspect', image], { timeout: 10_000 }); } catch { available = false; } }
const dockerOnly = { skip: available ? false : 'Requires Docker and the documented pinned Python image.' };
const policy = overrides => CheckPolicy.parse({ image, command: ['python', '-m', 'unittest', 'discover', '-v'], ...overrides });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gitpunk-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, 'init', '-b', 'main');
  await git(directory, 'config', 'user.name', 'Runner test');
  await git(directory, 'config', 'user.email', 'runner@example.invalid');
  await writeFile(join(directory, '.gitattributes'), 'test_sandbox.py export-ignore\npayload.txt export-subst\n');
  await writeFile(join(directory, 'payload.txt'), '$Format:%H$\n');
  await writeFile(join(directory, 'test_sandbox.py'), `import os, pathlib, socket, sqlite3, unittest
class Sandbox(unittest.TestCase):
    def test_exact_tree_and_isolation(self):
        self.assertEqual(os.getuid(), 10001)
        self.assertEqual(pathlib.Path('payload.txt').read_text(), '$Format:%H$\\n')
        self.assertFalse(pathlib.Path('.git').exists())
        self.assertFalse(pathlib.Path('/var/run/docker.sock').exists())
        self.assertFalse(pathlib.Path('/run/secrets').exists())
        with self.assertRaises(OSError): pathlib.Path('/workspace/forbidden').write_text('no')
        with self.assertRaises(OSError): pathlib.Path('/forbidden').write_text('no')
        with self.assertRaises(OSError): socket.create_connection(('1.1.1.1', 443), timeout=0.2)
        status = pathlib.Path('/proc/self/status').read_text()
        self.assertIn('CapEff:\\t0000000000000000', status)
        self.assertIn('NoNewPrivs:\\t1', status)
        mounts = [line.split() for line in pathlib.Path('/proc/mounts').read_text().splitlines()]
        self.assertTrue(any(fields[1] == '/workspace' and 'ro' in fields[3].split(',') for fields in mounts))
        self.assertTrue(any(fields[1] == '/' and 'ro' in fields[3].split(',') for fields in mounts))
        db = sqlite3.connect(os.environ['GITPUNK_TEST_DATABASE'])
        db.execute('create table demo (value text)')
        db.execute("insert into demo values ('disposable')")
        self.assertEqual(db.execute('select value from demo').fetchone()[0], 'disposable')
        db.close()
`);
  await git(directory, 'add', '.');
  await git(directory, 'commit', '-m', 'sandbox fixture');
  return { directory, candidate: await head(directory) };
}
async function removed(result) {
  assert.equal(result.cleanup, 'complete');
  await assert.rejects(exec('docker', ['container', 'inspect', result.container_name]), /No such (object|container)/);
}

test('real Docker checks export exact Git bytes and enforce the isolated environment', dockerOnly, async t => {
  const input = await fixture(t);
  const configured = policy();
  const result = await runCandidate({ ...input, policy: configured });
  assert.equal(result.state, 'passed', result.stderr);
  assert.equal(result.exit_code, 0);
  assert.match(result.stderr, /test_exact_tree_and_isolation/);
  assert.equal(result.source.files, 3);
  assert.equal(result.candidate, input.candidate);
  assert.equal(result.image_digest, image);
  assert.match(result.image_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.policy_hash, await hashContent(canonicalJson(configured)));
  await removed(result);
  assert.equal(await git(input.directory, 'status', '--porcelain'), '');
});

test('real Docker failure logs stay bounded and cleanup still completes', dockerOnly, async t => {
  const input = await fixture(t);
  const result = await runCandidate({ ...input, policy: policy({ max_output_bytes: 1024, command: ['python', '-c', 'import os; os.write(1, b"\\xff" * 100000); raise SystemExit(1)'] }) });
  assert.equal(result.state, 'failed');
  assert.equal(result.exit_code, 1);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
  await removed(result);
});

test('real Docker timeout kills only its owned container and removes it', dockerOnly, async t => {
  const input = await fixture(t);
  const result = await runCandidate({ ...input, policy: policy({ timeout_ms: 1000, command: ['python', '-c', 'import time; time.sleep(30)'] }) });
  assert.equal(result.state, 'timed_out', result.stderr);
  await removed(result);
});

test('runner refuses unsafe source modes before executing candidate code', dockerOnly, async t => {
  const input = await fixture(t);
  await symlink('/etc/passwd', join(input.directory, 'outside'));
  await git(input.directory, 'add', 'outside');
  await git(input.directory, 'commit', '-m', 'unsafe source');
  const result = await runCandidate({ ...input, candidate: await head(input.directory), policy: policy() });
  assert.equal(result.state, 'error');
  assert.match(result.stderr, /refuses symlinks/);
  await removed(result);
});
