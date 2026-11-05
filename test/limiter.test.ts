import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/ratelimit/limiter.js';
import { InMemoryRateLimitStore } from '../src/ratelimit/store.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wires a token bucket to the store and recovers with time', async () => {
    const limiter = createRateLimiter(
      { algorithm: 'token-bucket', capacity: 2, refillPerSecond: 1, keyBy: 'ip' },
      new InMemoryRateLimitStore(),
    );
    expect(limiter.limit).toBe(2);
    expect((await limiter.check('k', Date.now())).allowed).toBe(true);
    expect((await limiter.check('k', Date.now())).allowed).toBe(true);
    const denied = await limiter.check('k', Date.now());
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1_000);
    vi.advanceTimersByTime(1_000);
    expect((await limiter.check('k', Date.now())).allowed).toBe(true);
  });

  it('wires a sliding window to the store', async () => {
    const limiter = createRateLimiter(
      { algorithm: 'sliding-window', limit: 1, windowMs: 500, keyBy: 'api-key' },
      new InMemoryRateLimitStore(),
    );
    expect(limiter.limit).toBe(1);
    expect((await limiter.check('k', Date.now())).allowed).toBe(true);
    expect((await limiter.check('k', Date.now())).allowed).toBe(false);
    vi.advanceTimersByTime(500);
    expect((await limiter.check('k', Date.now())).allowed).toBe(true);
  });
});
