# ADR 0001 — Token bucket and sliding window log, both with lazy state

Status: accepted

## Context

Routes need a per-client request limit. The two common asks differ: "allow bursts but cap the
average rate" (API keys calling a backend) and "no more than N in any window" (anonymous traffic by
IP). A single algorithm serves one of them badly. Whatever is chosen must also work unchanged when
the state moves from process memory to Redis.

## Decision

Offer two algorithms behind one `RateLimiter` interface, selected per route:

- **Token bucket** — `capacity` tokens, refilled at `refillPerSecond`. Refill is computed on
  access from `(tokens, updatedAt, now)`; there is no timer per bucket. Fractional tokens
  accumulate but only whole tokens can be spent.
- **Sliding window log** — the timestamps of admitted requests in the last `windowMs`, pruned on
  access. Exact: never more than `limit` in any window of that length. Rejected requests are not
  recorded.

Both return the same `RateLimitDecision` (`allowed`, `limit`, `remaining`, `retryAfterMs`,
`resetMs`), from which the headers are derived in one place. State is kept only as long as it
matters: a bucket is dropped once it would be full, a window once it would be empty.

## Consequences

- No timers: idle clients cost nothing, nothing leaks, and the same maths runs inside a Redis Lua
  script. The cost is a little rounding care (`Retry-After` and `Reset` are rounded up).
- The window log is exact but `O(limit)` memory per key; a fixed window would be `O(1)` but admits
  up to 2× the limit across a boundary. For the limits a gateway applies per client this is a good
  trade; a sliding *counter* approximation would be the next step if memory mattered.
- Not recording rejected hits means a client that honours `Retry-After` is admitted exactly then;
  a client that ignores it is not punished further, which keeps the headers truthful.
