import { SourceQuery, ProtocolError } from '../shared/index.js';
import { storedGit } from './git-store.js';
import { readTree, readBlobs, gitInput } from './git-objects.js';
import { ImmutableCache } from './cache.js';

const fail = (code, message, status = 400) => { throw new ProtocolError(code, message, status); };
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Repo queries work without a checkout. Only immutable Git IDs enter the shared cache. */
export function createSourceStore(gitStore, db) {
  const cache = new ImmutableCache(); let active = 0, gitCommands = 0;
  const run = async (...args) => { gitCommands++; return gitInput(gitStore.directory, args, '', 1024 * 1024); };
  const tree = oid => cache.get(`tree:${oid}`, () => { gitCommands++; return readTree(gitStore.directory, oid); });
  async function visible(commit) {
    if (db.prepare('SELECT 1 FROM checks c JOIN uploads u ON u.id=c.submission_id WHERE u.repo_id=? AND c.candidate=? LIMIT 1').get(gitStore.config.repo_id, commit)) return true;
    const tip = gitStore.readRefSync('refs/heads/main');
    const generation = db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM uploads').get().n;
    return cache.get(`visible:${tip}:${generation}:${commit}`, () => gitStore.knownBase(commit));
  }
  async function root(commit) { return cache.get(`root:${commit}`, async () => (await run('rev-parse', `${commit}^{tree}`)).toString().trim()); }
  async function metadata(commit, path) {
    let oid = await root(commit), entry;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      entry = (await tree(oid)).find(item => item.path === parts[index]);
      if (!entry) return null;
      if (index < parts.length - 1 && entry.type !== 'tree') return null;
      oid = entry.oid;
    }
    return { ...entry, path };
  }
  async function bytes(entry) {
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('unsupported_git_mode', 'Only regular files can be read.', 403);
    if (entry.size > 1024 * 1024) fail('source_too_large', 'Read API file limit is 1 MiB.', 413);
    return cache.get(`blob:${entry.oid}`, async () => { gitCommands++; return (await readBlobs(gitStore.directory, [entry.oid], 1024 * 1024)).get(entry.oid); });
  }
  async function query(raw, allow) {
    const input = SourceQuery.parse(raw);
    if (++active > 16) { active--; fail('source_busy', 'Source service is busy; retry shortly.', 429); }
    try {
      if (!await visible(input.commit) || input.base && !await visible(input.base)) fail('unknown_commit', 'Commit is outside accepted repository history.', 404);
      if (input.action === 'compare') return cache.get(`compare:${input.base}:${input.commit}`, async () => {
        const merge_base = (await run('merge-base', input.base, input.commit)).toString().trim();
        return { base: input.base, commit: input.commit, merge_base, base_is_ancestor: merge_base === input.base, commit_is_ancestor: merge_base === input.commit };
      });
      if (input.action === 'tree') {
        let oid = await root(input.commit);
        if (input.path) { allow(input.path, true); const entry = await metadata(input.commit, input.path); if (entry?.type !== 'tree') fail('not_found', 'Directory not found.', 404); oid = entry.oid; }
        const entries = (await tree(oid)).map(entry => ({ ...entry, path: input.path ? `${input.path}/${entry.path}` : entry.path })).filter(entry => {
          try { allow(entry.path, entry.type === 'tree'); return entry.path > input.after; } catch (error) { if (error instanceof ProtocolError) return false; throw error; }
        }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const page = entries.slice(0, input.limit);
        return { commit: input.commit, entries: page, more: entries.length > page.length, next_cursor: page.at(-1)?.path || input.after };
      }
      for (const path of input.paths || [input.path]) allow(path);
      if (input.action === 'snapshot') {
        const files = await Promise.all(input.paths.map(path => metadata(input.commit, path)));
        if (files.some(entry => entry && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)))) fail('unsupported_git_mode', 'Snapshots contain regular files only.', 403);
        return { commit: input.commit, object_format: gitStore.config.object_format, files: input.paths.map((path, index) => files[index] || { path, oid: null, size: 0, mode: null }) };
      }
      if (input.action === 'file') {
        const entry = await metadata(input.commit, input.path);
        if (!entry) return { commit: input.commit, path: input.path, oid: null, content_base64: null };
        return { commit: input.commit, ...entry, content_base64: (await bytes(entry)).toString('base64') };
      }
      if (input.action === 'diff') return { base: input.base, commit: input.commit, paths: input.paths, diff: await cache.get(`diff:${JSON.stringify(input)}`, async () => decode(await run('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', input.base, input.commit, '--', ...input.paths.map(path => `:(literal)${path}`)))) };
      if (input.action === 'history') return { commit: input.commit, path: input.path, history: await cache.get(`history:${JSON.stringify(input)}`, async () => decode(await run('log', `--max-count=${input.limit}`, '--format=%H%x00%at%x00%s', input.commit, '--', `:(literal)${input.path}`)).trimEnd().split('\n').filter(Boolean).map(line => { const [commit, time, ...subject] = line.split('\0'); return { commit, time: Number(time), subject: subject.join('\0') }; })) };
      if (input.end < input.start || input.end - input.start >= 500) fail('invalid_range', 'Read at most 500 blame lines.');
      return { commit: input.commit, path: input.path, blame: await cache.get(`blame:${JSON.stringify(input)}`, async () => decode(await run('blame', '--line-porcelain', '-L', `${input.start},${input.end}`, input.commit, '--', input.path))) };
    } finally { active--; }
  }
  return {
    query, metadata, tree, bytes,
    stats: () => ({ ...cache.stats(), active, git_commands: gitCommands }),
    async commit(base, checkpoints, message, eventId) {
      if (!await visible(base)) fail('unknown_base', 'Commit parent is outside accepted history.', 409);
      const edits = new Map();
      for (const item of checkpoints) {
        const entry = await metadata(base, item.path);
        if (entry && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) fail('unsupported_git_mode', 'Commit patches regular files only.', 403);
        const oid = item.content === null ? null : (await gitInput(gitStore.directory, ['hash-object', '-w', '--stdin'], Buffer.from(item.content))).toString().trim();
        edits.set(item.path, oid ? { path: item.path.split('/').at(-1), type: 'blob', mode: entry?.mode || '100644', oid } : null);
      }
      // Rebuild only directories on changed paths; no index or working tree is materialized.
      async function rewrite(oid, prefix = '') {
        const entries = new Map((oid ? await tree(oid) : []).map(entry => [entry.path, entry]));
        const children = new Set([...edits.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]));
        for (const name of children) {
          const path = prefix + name;
          if (edits.has(path)) { const next = edits.get(path); if (next) entries.set(name, next); else entries.delete(name); }
          else {
            const existing = entries.get(name);
            if (existing && existing.type !== 'tree') fail('path_conflict', 'A file blocks a patch directory.', 409);
            const child = await rewrite(existing?.oid, path + '/');
            if (child) entries.set(name, { mode: '040000', type: 'tree', oid: child, path: name }); else entries.delete(name);
          }
        }
        if (!entries.size && prefix) return null;
        const input = [...entries.values()].map(entry => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}\0`).join('');
        return (await gitInput(gitStore.directory, ['mktree', '-z'], input)).toString().trim();
      }
      const nextTree = await rewrite(await root(base));
      const commit = (await gitInput(gitStore.directory, ['-c', 'user.name=Gitpunk', '-c', 'user.email=gitpunk@example.invalid', 'commit-tree', nextTree, '-p', base], message + `\n\nGitpunk-Request: ${eventId}\n`)).toString().trim();
      return commit;
    },
  };
}
