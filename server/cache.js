'use strict';

class SimpleCache {
  constructor(options = {}) {
    this.maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 2000;
    this.maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : 32 * 1024 * 1024;
    this._map = new Map();
    this._sizeBytes = 0;
    setInterval(() => this._cleanup(), 5 * 60 * 1000).unref();
  }
  _size(value) {
    const body = value?.body;
    return Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(String(body ?? ''), 'utf8');
  }
  _delete(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    this._sizeBytes = Math.max(0, this._sizeBytes - entry.size);
    return this._map.delete(key);
  }
  set(key, value, ttlSeconds = 300) {
    if (typeof key !== 'string' || key.length > 8192) return false;
    const size = this._size(value);
    if (size > this.maxBytes || this.maxEntries < 1) return false;
    this._delete(key);
    this._cleanup();
    while (this._map.size >= this.maxEntries || this._sizeBytes + size > this.maxBytes) {
      const oldest = this._map.keys().next().value;
      if (oldest == null) return false;
      this._delete(oldest);
    }
    this._map.set(key, { ...value, size, expires: Date.now() + Math.max(1, ttlSeconds) * 1000 });
    this._sizeBytes += size;
    return true;
  }
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expires) { this._delete(key); return null; }
    this._map.delete(key);
    this._map.set(key, entry);
    const { expires, size, ...value } = entry;
    return value;
  }
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._map) if (now >= entry.expires) this._delete(key);
  }
}
const cache = new SimpleCache();
cache.SimpleCache = SimpleCache;
module.exports = cache;
