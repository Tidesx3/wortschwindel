/** Simple token bucket: `capacity` events, refilled at `refillPerSecond`. */
export class TokenBucket {
  constructor(capacity = 20, refillPerSecond = 20) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.updatedAt = Date.now();
  }

  take(now = Date.now()) {
    const elapsed = (now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Counts failures per key (e.g. IP) in a sliding window and blocks after `max`.
 */
export class FailureLimiter {
  constructor({ max = 10, windowMs = 60_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.failures = new Map();
  }

  recent(key, now) {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  isBlocked(key, now = Date.now()) {
    return this.recent(key, now).length >= this.max;
  }

  fail(key, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
  }

  cleanup(now = Date.now()) {
    for (const key of this.failures.keys()) this.recent(key, now);
  }
}
