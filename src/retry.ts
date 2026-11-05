export interface RetryPolicy {
  /** Total attempts including the first; 1 means no retries. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** RFC 9110 §9.2.2: repeating these methods cannot change the outcome, so they are safe to retry. POST and PATCH are not. */
export function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/** Statuses that mean "the upstream could not serve this right now", not "this request is wrong". */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Full jitter: uniform in [0, min(maxDelayMs, baseDelayMs * 2^(attempt - 1))]. Spreading retries
 * over the whole interval, instead of adding a little noise to a fixed schedule, is what keeps
 * many clients from retrying in lockstep against an upstream that is already struggling.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * (ceiling + 1));
}

/** Retry-After is either delay-seconds or an HTTP-date; returns milliseconds from `now`, or undefined when absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface RetryVerdict {
  retry: boolean;
  /** A delay the upstream asked for; it replaces the computed backoff. */
  retryAfterMs?: number | undefined;
}

export interface RetryHooks<T> {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** Receives a value that is about to be thrown away because the attempt is being retried. */
  discard?: (value: T) => void;
  onRetry?: (attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(
  policy: RetryPolicy,
  run: (attempt: number) => Promise<T>,
  judge: (outcome: AttemptOutcome<T>) => RetryVerdict,
  hooks: RetryHooks<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await attemptOnce(run, attempt);
    const verdict = attempt < policy.attempts ? judge(outcome) : { retry: false };
    if (!verdict.retry) return settle(outcome);
    const delayMs = verdict.retryAfterMs ?? backoffDelayMs(attempt, policy, hooks.random);
    // An upstream asking for a longer wait than the policy allows knows more than we do:
    // stop now rather than retry too early or hold the client past the budget.
    if (delayMs > policy.maxDelayMs) return settle(outcome);
    if (outcome.ok) hooks.discard?.(outcome.value);
    hooks.onRetry?.(attempt, delayMs);
    await hooks.sleep(delayMs);
  }
}

async function attemptOnce<T>(run: (attempt: number) => Promise<T>, attempt: number): Promise<AttemptOutcome<T>> {
  try {
    return { ok: true, value: await run(attempt) };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

function settle<T>(outcome: AttemptOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}
