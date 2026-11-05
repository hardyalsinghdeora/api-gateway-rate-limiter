import { describe, expect, it } from 'vitest';
import { CircuitBreaker, type BreakerState, type Permit } from '../src/breaker.js';

const options = { failureThreshold: 3, windowMs: 1_000, openMs: 5_000 };

function acquire(breaker: CircuitBreaker, now: number): Permit {
  const permit = breaker.tryAcquire(now);
  if (permit === undefined) throw new Error(`expected a permit at t=${now}`);
  return permit;
}

function fail(breaker: CircuitBreaker, now: number): void {
  breaker.record(acquire(breaker, now), 'failure', now);
}

describe('CircuitBreaker', () => {
  it('opens after `failureThreshold` failures inside the window', () => {
    const breaker = new CircuitBreaker(options);
    fail(breaker, 0);
    fail(breaker, 100);
    expect(breaker.state(100)).toBe('closed');
    fail(breaker, 200);
    expect(breaker.state(200)).toBe('open');
    expect(breaker.tryAcquire(201)).toBeUndefined();
    expect(breaker.retryAfterMs(1_200)).toBe(4_000);
  });

  it('forgets failures that have left the rolling window', () => {
    const breaker = new CircuitBreaker(options);
    fail(breaker, 0);
    fail(breaker, 900);
    fail(breaker, 1_000); // the failure at t=0 has expired by now
    expect(breaker.state(1_000)).toBe('closed');
    fail(breaker, 1_050);
    expect(breaker.state(1_050)).toBe('open');
  });

  it('moves to half-open after openMs and lets exactly one probe through', () => {
    const breaker = new CircuitBreaker(options);
    [0, 1, 2].forEach((t) => {
      fail(breaker, t);
    });
    expect(breaker.tryAcquire(5_001)).toBeUndefined();
    expect(breaker.state(5_002)).toBe('half-open');
    expect(breaker.tryAcquire(5_002)).toEqual({ probe: true });
    expect(breaker.tryAcquire(5_003)).toBeUndefined();
    expect(breaker.state(5_003)).toBe('half-open');
  });

  it('closes on a successful probe and counts failures afresh', () => {
    const breaker = new CircuitBreaker(options);
    [0, 1, 2].forEach((t) => {
      fail(breaker, t);
    });
    breaker.record(acquire(breaker, 5_002), 'success', 5_010);
    expect(breaker.state(5_010)).toBe('closed');
    expect(breaker.tryAcquire(5_011)).toEqual({ probe: false });
    fail(breaker, 5_020);
    fail(breaker, 5_030);
    expect(breaker.state(5_030)).toBe('closed');
    fail(breaker, 5_040);
    expect(breaker.state(5_040)).toBe('open');
  });

  it('re-opens on a failed probe for another full openMs', () => {
    const breaker = new CircuitBreaker(options);
    [0, 1, 2].forEach((t) => {
      fail(breaker, t);
    });
    breaker.record(acquire(breaker, 5_002), 'failure', 5_050);
    expect(breaker.state(5_050)).toBe('open');
    expect(breaker.retryAfterMs(5_050)).toBe(5_000);
    expect(breaker.tryAcquire(10_049)).toBeUndefined();
    expect(breaker.tryAcquire(10_050)).toEqual({ probe: true });
  });

  it('stays half-open when a probe is abandoned, so the next request probes', () => {
    const breaker = new CircuitBreaker(options);
    [0, 1, 2].forEach((t) => {
      fail(breaker, t);
    });
    breaker.record(acquire(breaker, 5_002), 'abandoned', 5_003);
    expect(breaker.state(5_003)).toBe('half-open');
    expect(breaker.tryAcquire(5_004)).toEqual({ probe: true });
  });

  it('ignores late results from requests that predate a state change', () => {
    const changes: BreakerState[] = [];
    const breaker = new CircuitBreaker({ ...options, failureThreshold: 1 }, (state) => changes.push(state));
    const early = acquire(breaker, 0);
    fail(breaker, 10);
    breaker.record(early, 'failure', 20);
    expect(changes).toEqual(['open']);
    const probe = acquire(breaker, 5_010);
    breaker.record(early, 'success', 5_011);
    expect(breaker.state(5_011)).toBe('half-open');
    breaker.record(probe, 'success', 5_012);
    expect(changes).toEqual(['open', 'half-open', 'closed']);
  });
});
