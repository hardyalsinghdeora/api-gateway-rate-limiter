import { describe, expect, it } from 'vitest';
import { ceilSeconds, rateLimitHeaders } from '../src/ratelimit/headers.js';

describe('rate limit headers', () => {
  it('describes an allowed request without Retry-After', () => {
    const headers = rateLimitHeaders({ allowed: true, limit: 10, remaining: 7, retryAfterMs: 0, resetMs: 1_500 });
    expect(headers).toEqual({ 'RateLimit-Limit': '10', 'RateLimit-Remaining': '7', 'RateLimit-Reset': '2' });
  });

  it('adds a Retry-After in whole seconds, rounded up, on a denied request', () => {
    const denied = (retryAfterMs: number): string | undefined =>
      rateLimitHeaders({ allowed: false, limit: 10, remaining: 0, retryAfterMs, resetMs: 5_000 })['Retry-After'];
    expect(denied(1)).toBe('1');
    expect(denied(999)).toBe('1');
    expect(denied(1_000)).toBe('1');
    expect(denied(1_001)).toBe('2');
    expect(denied(0)).toBe('1');
  });

  it('reports Remaining as 0 and Reset rounded up when denied', () => {
    const headers = rateLimitHeaders({ allowed: false, limit: 3, remaining: 0, retryAfterMs: 700, resetMs: 900 });
    expect(headers['RateLimit-Remaining']).toBe('0');
    expect(headers['RateLimit-Reset']).toBe('1');
  });

  it('never reports negative seconds', () => {
    expect(ceilSeconds(-5)).toBe(0);
    expect(ceilSeconds(0)).toBe(0);
    expect(ceilSeconds(2_001)).toBe(3);
  });
});
