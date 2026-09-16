import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

export function pinMatches(input, expected) {
  if (typeof input !== 'string') return false;
  return timingSafeEqual(digest(input.trim()), digest(expected));
}

/**
 * Host tokens are issued after a correct PIN. They survive reloads (stored in the
 * browser) and restarts (persisted together with the rooms).
 */
export class HostTokens {
  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, number>} token -> issuedAt */
    this.tokens = new Map();
  }

  issue(now = Date.now()) {
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, now);
    return token;
  }

  isValid(token, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const issuedAt = this.tokens.get(token);
    if (issuedAt === undefined) return false;
    if (now - issuedAt > this.ttlMs) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** Keeps a token alive while the host is active. */
  refresh(token, now = Date.now()) {
    if (this.tokens.has(token)) this.tokens.set(token, now);
  }

  cleanup(now = Date.now()) {
    for (const [token, issuedAt] of this.tokens) {
      if (now - issuedAt > this.ttlMs) this.tokens.delete(token);
    }
  }

  toJSON() {
    return [...this.tokens];
  }

  load(entries) {
    if (Array.isArray(entries)) this.tokens = new Map(entries);
  }
}
