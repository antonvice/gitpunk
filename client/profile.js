import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const keys = new Set(['credentials', 'identity', 'workspace', 'stateDir', 'server', 'repo', 'branch', 'pollMs', 'debounceMs', 'upload']);

/** Profiles contain connection paths, never signing keys or bearer tokens. */
export async function withProfile(options) {
  const file = options.profile || process.env.GITPUNK_PROFILE;
  if (!file) return options;
  const location = resolve(file), raw = await readFile(location, 'utf8');
  if (Buffer.byteLength(raw) > 16_384) throw new Error('Client profile exceeds 16 KiB.');
  const profile = JSON.parse(raw);
  if (!profile || Array.isArray(profile) || typeof profile !== 'object' || Object.keys(profile).some(key => !keys.has(key))) throw new Error('Invalid client profile; use connection paths, not embedded credentials.');
  for (const key of ['credentials', 'workspace', 'stateDir']) if (profile[key] !== undefined) {
    if (typeof profile[key] !== 'string') throw new Error(`Profile ${key} must be a path.`);
    profile[key] = resolve(dirname(location), profile[key]);
  }
  return { ...profile, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
}
