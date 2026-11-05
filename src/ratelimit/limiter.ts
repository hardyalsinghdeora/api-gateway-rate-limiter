import type { RateLimitConfig } from '../config.js';
import type { RateLimitStore } from './store.js';

/** What both algorithms report for one request; the header layer is built on this alone. */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Whole requests the client may still make right now. */
  remaining: number;
  /** Milliseconds until the next request can succeed; 0 when allowed. */
  retryAfterMs: number;
  /** Milliseconds until the full quota is available again. */
  resetMs: number;
}

export interface RateLimiter {
  readonly limit: number;
  check(key: string, now: number): Promise<RateLimitDecision>;
}

export function createRateLimiter(config: RateLimitConfig, store: RateLimitStore): RateLimiter {
  switch (config.algorithm) {
    case 'token-bucket': {
      const params = { capacity: config.capacity, refillPerSecond: config.refillPerSecond };
      return { limit: config.capacity, check: (key, now) => store.consumeToken(key, params, now) };
    }
    case 'sliding-window': {
      const params = { limit: config.limit, windowMs: config.windowMs };
      return { limit: config.limit, check: (key, now) => store.recordHit(key, params, now) };
    }
  }
}
