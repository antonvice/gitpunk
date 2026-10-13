/** Kafka receives references only; HTTP polling reads the authoritative SQLite log. */
export function createOutboxDispatcher(db, { brokers = [], topic = 'gitpunk.events.v1' } = {}) {
  let producer, timer, busy = false, lastError = null;
  const pending = db.prepare('SELECT id, event_id, repo_id, branch, seq, type, payload FROM events WHERE delivered_at IS NULL ORDER BY id LIMIT 100');
  async function flush() {
    if (!producer || busy) return;
    busy = true;
    try {
      await producer.connect();
      for (const event of pending.all()) {
        // Accepted order is persisted before production. A lost broker acknowledgement
        // may cause a duplicate; event_id and branch sequence permit consumer dedup.
        await producer.send({ topic, messages: [{ key: `${event.repo_id}:${event.branch}`, value: JSON.stringify({ event_id: event.event_id, repo_id: event.repo_id, branch: event.branch, seq: event.seq, type: event.type, reference: JSON.parse(event.payload).id ?? null }) }] });
        db.prepare('UPDATE events SET delivered_at=? WHERE id=?').run(Date.now(), event.id);
      }
      lastError = null;
    } catch (error) { lastError = error.message; }
    finally { busy = false; }
  }
  return {
    async start() {
      if (!brokers.length) return;
      const { Kafka, logLevel } = await import('kafkajs');
      producer = new Kafka({ clientId: 'gitpunk-local', brokers, logLevel: logLevel.NOTHING, connectionTimeout: 2000, requestTimeout: 3000, retry: { retries: 1 } }).producer();
      try { await producer.connect(); } catch (error) { lastError = error.message; }
      timer = setInterval(flush, 1000); timer.unref();
      await flush();
    },
    flush,
    status() { return { configured: !!brokers.length, pending: Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE delivered_at IS NULL').get().n), last_error: lastError }; },
    async stop() { clearInterval(timer); while (busy) await new Promise(resolve => setTimeout(resolve, 20)); if (producer) await producer.disconnect().catch(() => {}); }
  };
}
