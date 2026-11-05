import type { RateLimitDecision } from './limiter.js';
import { recordHit, type SlidingWindowParams, type SlidingWindowState } from './slidingWindow.js';
import { takeToken, type TokenBucketParams, type TokenBucketState } from './tokenBucket.js';

/**
 * Where limiter state lives. Each method is one atomic read-modify-write per key; that is the
 * whole contract, and it is what makes a Redis implementation possible (each method becomes a
 * Lua script, see README "Design decisions"). The in-memory implementation is atomic because
 * it never yields between reading and writing an entry.
 */
export interface RateLimitStore {
  consumeToken(key: string, params: TokenBucketParams, now: number): Promise<RateLimitDecision>;
  recordHit(key: string, params: SlidingWindowParams, now: number): Promise<RateLimitDecision>;
}

interface Entry<S> {
  state: S;
  expiresAt: number;
}

function read<S>(map: Map<string, Entry<S>>, key: string, now: number): S | undefined {
  const entry = map.get(key);
  return entry !== undefined && entry.expiresAt > now ? entry.state : undefined;
}

function dropExpired<S>(map: Map<string, Entry<S>>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Entry<TokenBucketState>>();
  private readonly windows = new Map<string, Entry<SlidingWindowState>>();
  private writes = 0;

  /** @param sweepEvery expired entries are dropped every this many writes, so GC cost follows traffic and no timer is needed. */
  constructor(private readonly sweepEvery = 1000) {}

  consumeToken(key: string, params: TokenBucketParams, now: number): Promise<RateLimitDecision> {
    const result = takeToken(read(this.buckets, key, now), params, now);
    this.buckets.set(key, { state: result.state, expiresAt: now + result.ttlMs });
    this.afterWrite(now);
    return Promise.resolve(result.decision);
  }

  recordHit(key: string, params: SlidingWindowParams, now: number): Promise<RateLimitDecision> {
    const result = recordHit(read(this.windows, key, now), params, now);
    this.windows.set(key, { state: result.state, expiresAt: now + result.ttlMs });
    this.afterWrite(now);
    return Promise.resolve(result.decision);
  }

  /** Number of keys currently held, expired or not; useful for tests and a memory gauge. */
  get size(): number {
    return this.buckets.size + this.windows.size;
  }

  sweep(now: number): void {
    dropExpired(this.buckets, now);
    dropExpired(this.windows, now);
  }

  private afterWrite(now: number): void {
    this.writes += 1;
    if (this.writes % this.sweepEvery === 0) this.sweep(now);
  }
}
