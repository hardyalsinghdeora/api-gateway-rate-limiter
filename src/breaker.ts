export type BreakerState = 'closed' | 'open' | 'half-open';
export type Outcome = 'success' | 'failure' | 'abandoned';

export interface BreakerOptions {
  failureThreshold: number;
  windowMs: number;
  openMs: number;
}

/** Handed out by `tryAcquire` and handed back with the outcome, so a late result from a request that predates a state change cannot corrupt the new state. */
export interface Permit {
  readonly probe: boolean;
}

const REGULAR: Permit = { probe: false };
const PROBE: Permit = { probe: true };

export class BreakerOpenError extends Error {
  override readonly name = 'BreakerOpenError';

  constructor(
    readonly upstream: string,
    readonly retryAfterMs: number,
  ) {
    super(`circuit for ${upstream} is open`);
  }
}

/**
 * One breaker guards one upstream origin. Closed: requests flow and failures inside the rolling
 * window are counted. Open: requests are rejected at once until `openMs` has passed. Half-open:
 * exactly one probe is let through and its result decides whether the circuit closes or re-opens.
 */
export class CircuitBreaker {
  private current: BreakerState = 'closed';
  private failures: number[] = [];
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly options: BreakerOptions,
    private readonly onChange?: (state: BreakerState, now: number) => void,
  ) {}

  /** The state as an observer sees it at `now`; reading it changes nothing. */
  state(now: number): BreakerState {
    return this.current === 'open' && this.openElapsed(now) ? 'half-open' : this.current;
  }

  tryAcquire(now: number): Permit | undefined {
    if (this.current === 'open' && this.openElapsed(now)) this.transition('half-open', now);
    switch (this.current) {
      case 'closed':
        return REGULAR;
      case 'open':
        return undefined;
      case 'half-open':
        if (this.probing) return undefined;
        this.probing = true;
        return PROBE;
    }
  }

  /** Milliseconds until a request could be let through again; 0 unless the circuit is open. */
  retryAfterMs(now: number): number {
    return this.current === 'open' ? Math.max(0, this.openedAt + this.options.openMs - now) : 0;
  }

  record(permit: Permit, outcome: Outcome, now: number): void {
    if (permit.probe) {
      if (this.current !== 'half-open') return;
      this.probing = false;
      if (outcome === 'success') this.transition('closed', now);
      else if (outcome === 'failure') this.open(now);
      // An abandoned probe (the client went away) proves nothing; the next request probes again.
      return;
    }
    // Results of ordinary requests only matter while the circuit is closed.
    if (this.current !== 'closed' || outcome !== 'failure') return;
    this.failures = this.failures.filter((t) => t > now - this.options.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.options.failureThreshold) this.open(now);
  }

  private openElapsed(now: number): boolean {
    return now >= this.openedAt + this.options.openMs;
  }

  private open(now: number): void {
    this.openedAt = now;
    this.failures = [];
    this.transition('open', now);
  }

  private transition(to: BreakerState, now: number): void {
    this.current = to;
    this.onChange?.(to, now);
  }
}
