import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../client/git.js';
const examples = fileURLToPath(new URL('../examples/cars/', import.meta.url));
export async function createWorkspaces(root, { withTests = false, remote = false } = {}) {
  const source = resolve(root, 'source');
  await mkdir(source, { recursive: true });
  for (const file of ['models.py', 'services.py']) await copyFile(join(examples, file), join(source, file));
  if (withTests) {
    await mkdir(join(source, 'tests'), { recursive: true });
    await copyFile(join(examples, 'test_contract.py'), join(source, 'tests', 'test_contract.py'));
  }
  await git(source, 'init', '-b', 'main');
  await git(source, '-c', 'user.name=Gitpunk test', '-c', 'user.email=test@example.invalid', 'add', '.');
  await git(source, '-c', 'user.name=Gitpunk test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Car fixture');
  const alice = resolve(root, 'alice'), bob = resolve(root, 'bob');
  if (remote) { await mkdir(alice); await mkdir(bob); }
  else { await git(root, 'clone', source, alice); await git(root, 'clone', source, bob); }
  return { source, alice, bob };
}
