# ADR 0002 — Fail open when the rate-limit store is unavailable

Status: accepted

## Context

The in-memory store cannot fail, but the interface exists so that a Redis store can replace it, and
Redis can be slow, partitioned or down. The gateway must decide, per request, what to do when
`consumeToken`/`recordHit` throws.

## Decision

Default to **fail open**: the request is forwarded as if it had been allowed, no `RateLimit-*`
headers are sent (there is nothing truthful to say), a warning is logged with the error, and
`gateway_rate_limit_store_errors_total{route,policy}` is incremented. The behaviour is configurable:
`onStoreError: "closed"` answers `503 Service Unavailable` with `Retry-After: 1` instead.

## Consequences

- A store outage degrades to "no rate limiting" rather than "no service". The limiter protects
  upstreams from abusive clients; it should not be the component that turns a cache outage into a
  full outage for well-behaved ones.
- Fail-open must be loud. The metric is the alert condition; the log line carries the cause. A
  silently open limiter would be worse than either explicit choice.
- Deployments where quota enforcement is a contractual or safety requirement (paid plans, cost
  caps on expensive upstreams) set `"closed"` and accept the availability trade.
- The choice is global, not per route, on purpose: operators reason about one policy under
  incident conditions.
