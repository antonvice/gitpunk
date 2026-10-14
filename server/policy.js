import { ProtocolError } from '../shared/index.js';

const fail = (code, message, status = 400, details) => { throw new ProtocolError(code, message, status, details); };

function safePath(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || /[\\\x00-\x1f]/.test(file) || file.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) fail('unsafe_path', 'Path must be relative and outside .git.');
  if (file.split('/').some(segment => /^(\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:db|sqlite(?:3)?|pem|key))$/i.test(segment)) || /^(?:data|\.local|infra|\.github)(?:\/|$)/.test(file)) fail('protected_path', `Publishing ${file} is prohibited.`, 403);
  return file;
}
export function matches(pattern, file) {
  if (pattern === '**') return true;
  const expression = pattern.split('**').map(part => part.split('*').map(value => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${expression}$`).test(file);
}
export function intersects(a, b) {
  if (a === b || a === '**' || b === '**' || matches(a, b) || matches(b, a)) return true;
  if (a.endsWith('/**') && b.startsWith(a.slice(0, -2))) return true;
  if (b.endsWith('/**') && a.startsWith(b.slice(0, -2))) return true;
  return false;
}
export function checkScope(auth, file, operation) {
  safePath(file);
  const scope = JSON.parse(auth.scope);
  if (!scope.operations.includes(operation) || !scope.files.some(pattern => matches(pattern, file))) fail('scope_denied', 'Run does not have permission for this operation/path.', 403, { path: file, operation });
}
export function checkReadScope(auth, file, directory = false) {
  safePath(file);
  const scope = JSON.parse(auth.scope);
  if (!(scope.read_files || scope.files).some(pattern => matches(pattern, file) || directory && pattern.startsWith(file + '/'))) throw new ProtocolError('scope_denied', 'Run cannot read this path.', 403);
}
export function secrets(content) {
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk-proj-|ghp_|github_pat_)[A-Za-z0-9_\-]{20,}/.test(content ?? '');
}
