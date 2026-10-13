import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ClientStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, route TEXT NOT NULL, envelope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', response TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS inbox (cursor INTEGER PRIMARY KEY, event TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);`);
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  remove(key) { this.db.prepare('DELETE FROM state WHERE key=?').run(key); }
  fileErrors() { return this.db.prepare("SELECT value FROM state WHERE key LIKE 'file_error:%'").all().map(row => JSON.parse(row.value)); }
  entries(prefix) { return this.db.prepare('SELECT key,value FROM state WHERE key LIKE ? ORDER BY key').all(`${prefix}%`).map(row => ({ key: row.key, value: JSON.parse(row.value) })); }
  queue(route, envelope) { this.db.prepare('INSERT OR IGNORE INTO outbox(id,route,envelope) VALUES (?,?,?)').run(envelope.event_id, route, JSON.stringify(envelope)); }
  pending() { return this.db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY rowid LIMIT 50").all().map(row => ({ ...row, envelope: JSON.parse(row.envelope) })); }
  result(id) { const row = this.db.prepare('SELECT status,response,error FROM outbox WHERE id=?').get(id); return row && { ...row, response: row.response && JSON.parse(row.response), error: row.error && JSON.parse(row.error) }; }
  sent(id, response) { this.db.prepare("UPDATE outbox SET status='sent',response=?,error=NULL WHERE id=?").run(JSON.stringify(response), id); }
  failed(id, error, permanent = false) { this.db.prepare('UPDATE outbox SET status=?,error=? WHERE id=?').run(permanent ? 'rejected' : 'pending', JSON.stringify(error), id); }
  receive(events, cursor, state = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) this.db.prepare('INSERT OR IGNORE INTO inbox(cursor,event) VALUES (?,?)').run(event.cursor ?? event.seq, JSON.stringify(event));
      for (const item of state) this.set(item.key, item.value);
      this.set('cursor', cursor);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  inbox(limit = 50) { return this.db.prepare('SELECT event FROM inbox WHERE consumed=0 ORDER BY cursor LIMIT ?').all(limit).map(row => JSON.parse(row.event)); }
  errors() { return this.db.prepare('SELECT id,error FROM outbox WHERE error IS NOT NULL ORDER BY rowid DESC LIMIT 10').all().map(row => ({ event_id: row.id, ...JSON.parse(row.error) })); }
  consume(cursor) { this.db.prepare('UPDATE inbox SET consumed=1 WHERE cursor<=?').run(cursor); }
  counts() { return { outbox: this.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='pending'").get().n, rejected: this.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='rejected'").get().n, inbox: this.db.prepare('SELECT count(*) AS n FROM inbox WHERE consumed=0').get().n }; }
  close() { this.db.close(); }
}
