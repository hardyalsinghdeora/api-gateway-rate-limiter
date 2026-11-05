import { describe, expect, it } from 'vitest';
import { prune, recordHit, type SlidingWindowState } from '../src/ratelimit/slidingWindow.js';

const params = { limit: 3, windowMs: 1_000 };

function fill(times: number[]): SlidingWindowState {
  let state: SlidingWindowState | undefined;
  for (const t of times) {
    const result = recordHit(state, params, t);
    expect(result.decision.allowed).toBe(true);
    state = result.state;
  }
  return state ?? { hits: [] };
}

describe('sliding window log', () => {
  it('admits `limit` requests inside the window and reports remaining', () => {
    const first = recordHit(undefined, params, 100);
    expect(first.decision).toEqual({ allowed: true, limit: 3, remaining: 2, retryAfterMs: 0, resetMs: 1_000 });
    const state = fill([100, 200, 300]);
    const denied = recordHit(state, params, 400);
    expect(denied.decision).toEqual({ allowed: false, limit: 3, remaining: 0, retryAfterMs: 700, resetMs: 900 });
  });

  it('expires a hit exactly windowMs after it was recorded', () => {
    const state = fill([100, 200, 300]);
    expect(recordHit(state, params, 1_099).decision.allowed).toBe(false);
    const result = recordHit(state, params, 1_100);
    expect(result.decision.allowed).toBe(true);
    expect(result.state.hits).toEqual([200, 300, 1_100]);
  });

  it('does not record rejected requests, so backing off as told is enough', () => {
    const state = fill([100, 200, 300]);
    const denied = recordHit(state, params, 500);
    expect(denied.state.hits).toEqual([100, 200, 300]);
    const retryAt = 500 + denied.decision.retryAfterMs;
    expect(recordHit(denied.state, params, retryAt).decision.allowed).toBe(true);
  });

  it('prunes expired hits so the state never grows past the limit', () => {
    let state: SlidingWindowState | undefined;
    for (let t = 0; t < 10_000; t += 400) {
      state = recordHit(state, params, t).state;
      expect(state.hits.length).toBeLessThanOrEqual(params.limit);
    }
    expect(prune([0, 500, 1_000, 1_500], params, 1_500)).toEqual([1_000, 1_500]);
  });

  it('keeps the state only as long as the newest hit matters', () => {
    expect(recordHit(undefined, params, 0).ttlMs).toBe(1_000);
    expect(recordHit(fill([100, 200, 300]), params, 350).ttlMs).toBe(950);
  });
});
