import type { RateLimitDecision } from './limiter.js';

export interface TokenBucketParams {
  capacity: number;
  refillPerSecond: number;
}

export interface TokenBucketState {
  /** May be fractional between refills; only whole tokens can be spent. */
  tokens: number;
  updatedAt: number;
}

export interface TokenBucketResult {
  decision: RateLimitDecision;
  state: TokenBucketState;
  /** How long the state is worth keeping: once the bucket is full again, no state equals full. */
  ttlMs: number;
}

/**
 * Refill is computed from elapsed time on access instead of by a timer per bucket, so idle keys
 * cost nothing and the maths is the same whether the state lives in memory or in Redis.
 */
export function refill(state: TokenBucketState, params: TokenBucketParams, now: number): TokenBucketState {
  // A clock that moved backwards must not mint tokens.
  const elapsedMs = Math.max(0, now - state.updatedAt);
  const tokens = Math.min(params.capacity, state.tokens + (elapsedMs / 1000) * params.refillPerSecond);
  return { tokens, updatedAt: now };
}

function msUntilFull(state: TokenBucketState, params: TokenBucketParams): number {
  return Math.ceil(((params.capacity - state.tokens) / params.refillPerSecond) * 1000);
}

export function takeToken(
  previous: TokenBucketState | undefined,
  params: TokenBucketParams,
  now: number,
): TokenBucketResult {
  const bucket = previous === undefined ? { tokens: params.capacity, updatedAt: now } : refill(previous, params, now);
  const limit = params.capacity;

  if (bucket.tokens >= 1) {
    const state = { tokens: bucket.tokens - 1, updatedAt: now };
    const resetMs = msUntilFull(state, params);
    return {
      decision: { allowed: true, limit, remaining: Math.floor(state.tokens), retryAfterMs: 0, resetMs },
      state,
      ttlMs: resetMs,
    };
  }

  const retryAfterMs = Math.ceil(((1 - bucket.tokens) / params.refillPerSecond) * 1000);
  const resetMs = msUntilFull(bucket, params);
  return {
    decision: { allowed: false, limit, remaining: 0, retryAfterMs, resetMs },
    state: bucket,
    ttlMs: resetMs,
  };
}
