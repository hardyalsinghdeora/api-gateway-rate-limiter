import type { RateLimitDecision } from './limiter.js';

export interface SlidingWindowParams {
  limit: number;
  windowMs: number;
}

export interface SlidingWindowState {
  /** Timestamps of admitted requests still inside the window, oldest first. */
  hits: number[];
}

export interface SlidingWindowResult {
  decision: RateLimitDecision;
  state: SlidingWindowState;
  ttlMs: number;
}

/** A hit recorded at `t` counts for requests at `t <= now < t + windowMs`. */
export function prune(hits: readonly number[], params: SlidingWindowParams, now: number): number[] {
  const cutoff = now - params.windowMs;
  return hits.filter((t) => t > cutoff);
}

export function recordHit(
  previous: SlidingWindowState | undefined,
  params: SlidingWindowParams,
  now: number,
): SlidingWindowResult {
  const hits = prune(previous?.hits ?? [], params, now);
  const { limit, windowMs } = params;
  const oldest = hits[0];

  if (oldest === undefined || hits.length < limit) {
    hits.push(now);
    return {
      decision: { allowed: true, limit, remaining: limit - hits.length, retryAfterMs: 0, resetMs: windowMs },
      state: { hits },
      ttlMs: windowMs,
    };
  }

  // Rejected requests are not recorded: a client that backs off as told is admitted when the
  // oldest hit expires, instead of being locked out for as long as it keeps knocking.
  const newest = hits.reduce((a, b) => Math.max(a, b), oldest);
  const resetMs = newest + windowMs - now;
  return {
    decision: { allowed: false, limit, remaining: 0, retryAfterMs: oldest + windowMs - now, resetMs },
    state: { hits },
    ttlMs: resetMs,
  };
}
