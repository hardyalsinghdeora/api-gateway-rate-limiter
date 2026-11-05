import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  isIdempotent,
  parseRetryAfterMs,
  RETRYABLE_STATUSES,
  withRetry,
  type AttemptOutcome,
  type RetryHooks,
} from '../src/retry.js';

describe('isIdempotent', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'get'])('allows retrying %s', (method) => {
    expect(isIdempotent(method)).toBe(true);
  });

  it.each(['POST', 'PATCH', 'CONNECT'])('never retries %s', (method) => {
    expect(isIdempotent(method)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  const policy = { attempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };

  it('doubles the ceiling per attempt and caps it at maxDelayMs', () => {
    const top = (): number => 0.999_999;
    expect([1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, policy, top))).toEqual([100, 200, 400, 800, 1_000]);
  });

  it('spreads delays over the whole interval from zero (full jitter)', () => {
    expect(backoffDelayMs(3, policy, () => 0)).toBe(0);
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(200);
    for (let i = 0; i < 500; i += 1) {
      const delay = backoffDelayMs(4, policy);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(800);
    }
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('reads delay-seconds and HTTP-dates', () => {
    expect(parseRetryAfterMs('3', now)).toBe(3_000);
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfterMs('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
  });

  it('ignores absent or malformed values', () => {
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
  });
});

describe('withRetry', () => {
  const policy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };
  const retryOnBusy = (outcome: AttemptOutcome<string>): { retry: boolean } => ({
    retry: outcome.ok ? outcome.value === 'busy' : true,
  });

  function harness(): { hooks: RetryHooks<string>; sleeps: number[]; discarded: string[] } {
    const sleeps: number[] = [];
    const discarded: string[] = [];
    return {
      sleeps,
      discarded,
      hooks: {
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        random: () => 0.5,
        discard: (value) => {
          discarded.push(value);
        },
      },
    };
  }

  it('retries until an attempt succeeds, backing off in between', async () => {
    const { hooks, sleeps, discarded } = harness();
    const run = vi.fn<(attempt: number) => Promise<string>>();
    run.mockResolvedValueOnce('busy').mockResolvedValueOnce('busy').mockResolvedValueOnce('ok');
    await expect(withRetry(policy, run, retryOnBusy, hooks)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith(3);
    expect(sleeps).toEqual([50, 100]);
    expect(discarded).toEqual(['busy', 'busy']);
  });

  it('returns the last outcome once attempts are exhausted', async () => {
    const { hooks, sleeps } = harness();
    const run = vi.fn<(attempt: number) => Promise<string>>().mockResolvedValue('busy');
    await expect(withRetry(policy, run, retryOnBusy, hooks)).resolves.toBe('busy');
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it('retries thrown errors and rethrows the last one', async () => {
    const { hooks } = harness();
    const run = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(new Error('down'));
    await expect(withRetry(policy, run, retryOnBusy, hooks)).rejects.toThrow('down');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the judge says the outcome is final', async () => {
    const { hooks, sleeps } = harness();
    const run = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(new Error('bad request'));
    await expect(withRetry(policy, run, () => ({ retry: false }), hooks)).rejects.toThrow('bad request');
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('honours a Retry-After hint instead of the computed backoff', async () => {
    const { hooks, sleeps } = harness();
    const run = vi.fn<(attempt: number) => Promise<string>>().mockResolvedValueOnce('busy').mockResolvedValueOnce('ok');
    const hinted = (outcome: AttemptOutcome<string>): { retry: boolean; retryAfterMs: number } => ({
      ...retryOnBusy(outcome),
      retryAfterMs: 250,
    });
    await expect(withRetry(policy, run, hinted, hooks)).resolves.toBe('ok');
    expect(sleeps).toEqual([250]);
  });

  it('gives up at once when Retry-After exceeds maxDelayMs', async () => {
    const { hooks, sleeps, discarded } = harness();
    const run = vi.fn<(attempt: number) => Promise<string>>().mockResolvedValue('busy');
    await expect(withRetry(policy, run, () => ({ retry: true, retryAfterMs: 5_000 }), hooks)).resolves.toBe('busy');
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(discarded).toEqual([]);
  });

  it('never consults the judge on the final attempt', async () => {
    const { hooks } = harness();
    const judge = vi.fn(retryOnBusy);
    await withRetry({ ...policy, attempts: 1 }, () => Promise.resolve('busy'), judge, hooks);
    expect(judge).not.toHaveBeenCalled();
  });

  it('treats only 502, 503 and 504 as transient', () => {
    expect([...RETRYABLE_STATUSES].sort()).toEqual([502, 503, 504]);
  });
});
