import { readFile } from 'node:fs/promises';

const assets = new Map(await Promise.all(['board.html', 'board-client.js', 'board-data.js'].map(async file => [file, await readFile(new URL(file, import.meta.url))])));

export function serveBoard(request, response) {
  const route = new URL(request.url, 'http://localhost').pathname;
  const file = route === '/' || route === '/board' ? 'board.html' : ['/board-client.js', '/board-data.js'].includes(route) ? route.slice(1) : null;
  if (request.method !== 'GET' || !file) return false;
  response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(assets.get(file));
  return true;
}
