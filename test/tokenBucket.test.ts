import { describe, expect, it } from 'vitest';
import { refill, takeToken, type TokenBucketState } from '../src/ratelimit/tokenBucket.js';

const params = { capacity: 5, refillPerSecond: 2 };

function drain(now: number): TokenBucketState {
  let result = takeToken(undefined, params, now);
  for (let taken = 1; ; taken += 1) {
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.remaining).toBe(params.capacity - taken);
    if (taken === params.capacity) return result.state;
    result = takeToken(result.state, params, now);
  }
}

describe('token bucket', () => {
  it('starts full and absorbs a burst of exactly `capacity` requests', () => {
    const state = drain(1_000);
    expect(state.tokens).toBe(0);
    const denied = takeToken(state, params, 1_000);
    expect(denied.decision).toEqual({ allowed: false, limit: 5, remaining: 0, retryAfterMs: 500, resetMs: 2500 });
    expect(denied.state.tokens).toBe(0);
  });

  it('refills lazily in proportion to elapsed time', () => {
    const empty = drain(1_000);
    expect(refill(empty, params, 2_500).tokens).toBe(3);
    const result = takeToken(empty, params, 2_500);
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.remaining).toBe(2);
    expect(result.state).toEqual({ tokens: 2, updatedAt: 2_500 });
  });

  it('never refills past capacity', () => {
    const empty = drain(1_000);
    expect(refill(empty, params, 1_000_000).tokens).toBe(5);
    expect(takeToken(empty, params, 1_000_000).decision.remaining).toBe(4);
  });

  it('does not spend fractional tokens but reports when the next whole one arrives', () => {
    const empty = drain(1_000);
    const result = takeToken(empty, params, 1_250); // 0.5 tokens refilled
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.remaining).toBe(0);
    expect(result.decision.retryAfterMs).toBe(250);
    expect(result.state).toEqual({ tokens: 0.5, updatedAt: 1_250 });
  });

  it('reports reset as the time until the bucket is full again', () => {
    const result = takeToken(undefined, params, 0);
    expect(result.decision.resetMs).toBe(500); // one token missing at 2/s
    expect(result.ttlMs).toBe(500);
  });

  it('treats a clock that moved backwards as no time elapsed', () => {
    const empty = drain(5_000);
    expect(refill(empty, params, 4_000).tokens).toBe(0);
  });

  it('rounds retry-after up to the next millisecond', () => {
    const empty = drain(0);
    const result = takeToken(empty, { capacity: 5, refillPerSecond: 3 }, 0);
    expect(result.decision.retryAfterMs).toBe(334);
  });
});
