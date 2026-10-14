/** Immutable values only. Concurrent misses share work; reads still require authorization. */
export class ImmutableCache {
  constructor(maxBytes = 32 * 1024 * 1024, maxEntries = 1024) {
    this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.values = new Map(); this.pending = new Map();
    this.bytes = 0; this.hits = 0; this.misses = 0;
  }
  async get(key, load) {
    if (this.values.has(key)) {
      const entry = this.values.get(key); this.values.delete(key); this.values.set(key, entry); this.hits++; return entry.value;
    }
    if (this.pending.has(key)) { this.hits++; return this.pending.get(key); }
    this.misses++;
    const promise = Promise.resolve().then(load).then(value => {
      const size = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(JSON.stringify(value));
      if (size <= this.maxBytes) {
        while (this.values.size && (this.bytes + size > this.maxBytes || this.values.size >= this.maxEntries)) {
          const oldest = this.values.keys().next().value; this.bytes -= this.values.get(oldest).size; this.values.delete(oldest);
        }
        this.values.set(key, { value, size }); this.bytes += size;
      }
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise); return promise;
  }
  stats() { return { hits: this.hits, misses: this.misses, bytes: this.bytes, entries: this.values.size, pending: this.pending.size }; }
}
