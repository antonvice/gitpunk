import { mkdir, chmod, readFile, writeFile, access, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitpunkServer } from '../server/index.js';
import { GitpunkClient } from '../client/index.js';
import { git, head } from '../client/git.js';
import { createWorkspaces } from './git-fixture.js';

const run = promisify(execFile);
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const privateJson = async (file, value) => { await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(file, 0o600); };
const project = fileURLToPath(new URL('../', import.meta.url));

export async function startMvp({ root = '.local/mvp', port = 8787, source, kafkaBrokers = [], checks = true, runner, remote = false } = {}) {
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const workspaces = { source: source ? resolve(source) : join(root, 'source'), alice: join(root, 'alice'), bob: join(root, 'bob') };
  if (!source && !await exists(workspaces.source)) await createWorkspaces(root, { withTests: true, remote });
  await head(workspaces.source);
  for (const name of ['alice', 'bob']) {
    if (remote) {
      await mkdir(workspaces[name], { recursive: true });
      if (await exists(join(workspaces[name], '.git'))) throw new Error('Remote mode requires a fresh data directory without agent Git checkouts.');
      continue;
    }
    if (!await exists(workspaces[name])) await git(root, 'clone', workspaces.source, workspaces[name]);
    if (await git(workspaces[name], 'remote', 'get-url', 'origin') !== workspaces.source) throw new Error(`Existing ${name} workspace belongs to a different source; choose a different --data-dir.`);
    await head(workspaces[name]);
  }
  const checkPolicy = checks ? JSON.parse(await readFile(new URL('../infra/checks.example.json', import.meta.url), 'utf8')) : undefined;
  const server = await createGitpunkServer({ dataDir: join(root, 'server'), bootstrap: true, port, gitSource: workspaces.source, kafkaBrokers, checkPolicy, runner });
  const clients = {}, sync = [], abort = new AbortController();
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    abort.abort();
    await Promise.allSettled(sync);
    for (const client of Object.values(clients)) {
      if (client.lockPath) await unlink(client.lockPath).catch(() => {});
      client.close();
    }
    await server.stop();
  }
  try {
    const started = await server.start();
    const fixture = server.fixture;
    const profiles = {};
    for (const name of ['alice', 'bob']) {
      const credentials = join(root, `${name}.credentials.json`);
      await privateJson(credentials, { endpoint: started.endpoint, repository_id: 'demo', branch: 'main', identities: { [name]: fixture.identities[name] } });
      profiles[name] = join(root, `${name}.profile.json`);
      await privateJson(profiles[name], { credentials, identity: name, workspace: workspaces[name], stateDir: join(root, `${name}-state`), upload: true, remote, cacheDir: join(root, 'source-cache') });
      await privateJson(join(root, `${name}.mcp.json`), { mcpServers: { gitpunk: { command: process.execPath, args: [join(project, 'client/mcp.js'), '--profile', profiles[name]] } } });
      await writeFile(join(root, `${name}.codex.toml`), `[mcp_servers.gitpunk]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([join(project, 'client/mcp.js'), '--profile', profiles[name]])}\nenabled_tools = ["gitpunk_work", "gitpunk_status", "gitpunk_respond"]\nstartup_timeout_sec = 10\n`, { mode: 0o600 });
      clients[name] = await GitpunkClient.create({ profile: profiles[name] });
      await clients[name].request('status?branch=main');
      await clients[name].acquireLock();
    }
    // Browser profile holds a development bearer token only; signing keys stay out of the UI.
    const boardProfile = join(root, 'board.profile.json');
    await privateJson(boardProfile, { server: started.endpoint, repo: 'demo', branch: 'main', token: fixture.identities.alice.token });
    for (const client of Object.values(clients)) {
      await client.tick();
      sync.push((async () => {
        while (!abort.signal.aborted) {
          await client.tick();
          try { await delay(1000, undefined, { signal: abort.signal }); }
          catch { break; }
        }
      })());
    }
    const receipt = { mode: 'local-development', remote, endpoint: started.endpoint, board: `${started.endpoint}/board`, root, workspaces, profiles, board_profile: boardProfile, checks: checks ? 'pinned Docker; manual exact approval' : 'disabled; uploads stay unverified', kafka: kafkaBrokers.length ? 'configured; delivery visible in /health' : 'disabled; durable cursor polling remains available', cloud_writes: false, agent_models: 'Bring an MCP-capable coding agent; no model credentials are required by Gitpunk.' };
    await privateJson(join(root, 'runtime.json'), { ...receipt, pid: process.pid, started_at: new Date().toISOString() });
    return { receipt, server, clients, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, port: { type: 'string' }, source: { type: 'string' }, remote: { type: 'boolean' }, 'no-kafka': { type: 'boolean' }, 'no-checks': { type: 'boolean' } } });
    if (!values['no-kafka']) await run('docker', ['compose', '-f', join(project, 'infra/compose.yaml'), 'up', '-d'], { timeout: 30_000 });
    const app = await startMvp({ root: values['data-dir'] || (values.remote ? '.local/mvp-remote' : undefined), port: Number(values.port || 8787), source: values.source, remote: values.remote, kafkaBrokers: values['no-kafka'] ? [] : ['127.0.0.1:9092'], checks: !values['no-checks'] });
    process.stdout.write(JSON.stringify(app.receipt, null, 2) + '\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.stop(); process.exit(0); });
  } catch (error) { process.stderr.write(`Gitpunk startup failed: ${error.message}\n`); process.exitCode = 1; }
}
