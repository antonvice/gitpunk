import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const run = promisify(execFile), root = resolve('.'), output = join(root, '.local/release');
const rootFiles = new Set(['.gitignore', 'AGENTS.md', 'README.md', 'MVP.md', 'Roadmap.md', 'SUBMISSION.md', 'techdoc.md', 'Suggestions.md', 'COSTS.md', 'LICENSE', 'package.json', 'package-lock.json']);
const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
const files = [...new Set(stdout.split('\0').filter(file => rootFiles.has(file) || /^(client|server|shared|infra|examples|scripts|tests|\.github\/workflows)\//.test(file)))].sort();
for (const file of files) {
  if (file.split('/').some(part => ['.git', '.local', 'node_modules'].includes(part)) || !(await lstat(join(root, file))).isFile()) throw new Error(`Refusing to archive private state or a nonregular file: ${file}`);
}
await mkdir(output, { recursive: true, mode: 0o700 });
const list = join(output, 'files.list'), archive = join(output, 'gitpunk-mvp.tar.gz');
await writeFile(list, files.join('\0') + '\0', { mode: 0o600 });
await run('tar', ['-czf', archive, '--null', '-T', list], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } });
const inventory = (await run('tar', ['-tzf', archive])).stdout.trimEnd().split('\n').sort();
if (inventory.join('\0') !== files.join('\0')) throw new Error('Archive inventory differs from the public source list.');
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
const receipt = { archive, sha256, files: files.length, private_state_included: false, license_selected: files.includes('LICENSE') };
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
