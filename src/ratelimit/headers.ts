import type { RateLimitDecision } from './limiter.js';

export function ceilSeconds(ms: number): number {
  return Math.ceil(Math.max(0, ms) / 1000);
}

/**
 * Header names follow draft-ietf-httpapi-ratelimit-headers in the widely deployed
 * `RateLimit-*` form. `RateLimit-Reset` is the time until the full quota is back;
 * `Retry-After` (429 only) is the time until the very next request can succeed. Both round
 * up, so a client that obeys them never retries too early, and Retry-After is never 0.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(ceilSeconds(decision.resetMs)),
  };
  if (!decision.allowed) {
    headers['Retry-After'] = String(Math.max(1, ceilSeconds(decision.retryAfterMs)));
  }
  return headers;
}
