import { describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore } from '../src/ratelimit/store.js';

const bucket = { capacity: 2, refillPerSecond: 1 };
const window = { limit: 2, windowMs: 1_000 };

describe('InMemoryRateLimitStore', () => {
  it('keeps token bucket state between calls, per key', async () => {
    const store = new InMemoryRateLimitStore();
    expect((await store.consumeToken('a', bucket, 0)).remaining).toBe(1);
    expect((await store.consumeToken('a', bucket, 0)).remaining).toBe(0);
    expect((await store.consumeToken('a', bucket, 0)).allowed).toBe(false);
    expect((await store.consumeToken('b', bucket, 0)).allowed).toBe(true);
  });

  it('keeps sliding window state between calls', async () => {
    const store = new InMemoryRateLimitStore();
    await store.recordHit('a', window, 0);
    await store.recordHit('a', window, 100);
    expect((await store.recordHit('a', window, 200)).allowed).toBe(false);
    expect((await store.recordHit('a', window, 1_000)).allowed).toBe(true);
  });

  it('treats an expired entry as absent, which for a bucket means full', async () => {
    const store = new InMemoryRateLimitStore();
    await store.consumeToken('a', bucket, 0);
    await store.consumeToken('a', bucket, 0);
    // Two tokens refill in 2s; the entry expires then and a fresh full bucket takes over.
    expect((await store.consumeToken('a', bucket, 2_000)).remaining).toBe(1);
  });

  it('namespaces the two algorithms separately', async () => {
    const store = new InMemoryRateLimitStore();
    await store.consumeToken('shared', bucket, 0);
    await store.recordHit('shared', window, 0);
    expect(store.size).toBe(2);
  });

  it('drops expired keys every `sweepEvery` writes without a timer', async () => {
    const store = new InMemoryRateLimitStore(4);
    await store.consumeToken('a', bucket, 0);
    await store.consumeToken('b', bucket, 0);
    await store.consumeToken('c', bucket, 0);
    expect(store.size).toBe(3);
    await store.consumeToken('d', bucket, 10_000); // 4th write sweeps: a, b, c expired by now
    expect(store.size).toBe(1);
    store.sweep(20_000);
    expect(store.size).toBe(0);
  });
});
