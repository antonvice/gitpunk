#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { GitpunkClient } from './index.js';

const help = `Gitpunk: declare work and share saved drafts. Git remains unchanged.

  gitpunk start [--once] [--upload | --no-upload]
  gitpunk work --file intent.json
  gitpunk work "Add car model" --files models.py services.py
  gitpunk work --respond response.json
  gitpunk status [--json]

Connection: --profile FILE (or GITPUNK_PROFILE); saves the connection/workspace options.
Or: --credentials FILE --identity alice|bob --workspace DIR --state-dir DIR
Or: --server URL --repo ID --run ID --token-file FILE --key-file FILE
Optional: --branch main --poll-ms 1000 --remote (workspace without .git).
Development HTTP is loopback only.
`;

// Accept a human-friendly file list without adding more daily commands.
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) if (args[i] === '--files') {
  const files = [];
  while (args[i + 1] && !args[i + 1].startsWith('--')) files.push(args.splice(i + 1, 1)[0]);
  args.splice(i + 1, 0, files.join(','));
}
let client;
try {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries([
    ...['profile', 'credentials', 'identity', 'workspace', 'state-dir', 'server', 'repo', 'run', 'token-file', 'key-file', 'branch', 'poll-ms', 'file', 'files', 'type', 'summary', 'respond'].map(key => [key, { type: 'string' }]),
    ...['json', 'once', 'help', 'upload', 'no-upload', 'remote'].map(key => [key, { type: 'boolean' }]),
  ]) });
  const [command, ...title] = positionals;
  if (values.help || !command) { process.stdout.write(help); process.exit(0); }
  if (!['start', 'work', 'status'].includes(command)) throw new Error('Use start, work or status.');
  if ((values.upload || values['no-upload']) && command !== 'start') throw new Error('Configure uploads with start --upload or start --no-upload.');
  if (values.upload && values['no-upload']) throw new Error('Choose --upload or --no-upload.');
  client = await GitpunkClient.create({ ...values, noUpload: values['no-upload'], stateDir: values['state-dir'], tokenFile: values['token-file'], keyFile: values['key-file'], pollMs: values['poll-ms'] });
  let result;
  if (command === 'work') {
    if (values.respond) result = await client.respond(JSON.parse(await readFile(values.respond, 'utf8')));
    else {
      const intent = values.file ? JSON.parse(await readFile(values.file, 'utf8')) : { title: title.join(' '), type: values.type || 'feature', summary: values.summary || title.join(' '), files: (values.files || '').split(',').filter(Boolean), done_when: ['Declared behavior is implemented and required checks pass.'], sharing: 'summary' };
      result = await client.work(intent);
    }
  } else if (command === 'status') result = await client.status();
  else if (values.once) { await client.tick(); result = await client.status({ refresh: false }); }
  else {
    const abort = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
    process.stdout.write(JSON.stringify({ state: 'syncing', workspace: client.options.workspace, note: 'Foreground service; Ctrl-C stops sync.' }) + '\n');
    await client.start({ signal: abort.signal });
    result = { state: 'stopped' };
  }
  process.stdout.write(JSON.stringify(result, null, values.json ? 0 : 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ state: 'error', code: error.code || 'invalid_input', message: error.message, next_actions: error.next_actions || ['gitpunk --help'] }) + '\n');
  process.exitCode = 1;
} finally { client?.close(); }
