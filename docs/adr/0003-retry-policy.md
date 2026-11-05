# ADR 0003 — Retry only idempotent methods, with bounded full-jitter backoff

Status: accepted

## Context

Transient upstream failures (a restarting pod, a connection reset, a `503` during a deploy) are
common and cheap to paper over at the gateway. Retrying blindly is dangerous: a retried `POST` can
create a duplicate order, and synchronized retries from many clients can keep a recovering upstream
down.

## Decision

- Retry only RFC 9110 idempotent methods: `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`. Never
  `POST` or `PATCH`, with no configuration to enable it.
- Retry only on failures that mean "not right now": connection errors, timeouts waiting for
  headers, and `502`/`503`/`504`. Any other status, including `500` and `429`, is final.
- `attempts` is the total budget (default 1, max 10). Delays use full jitter:
  `uniform(0, min(maxDelayMs, baseDelayMs · 2^(attempt−1)))`.
- A `Retry-After` from the upstream replaces the computed delay. If it is larger than
  `maxDelayMs` the retry is abandoned and the response returned as is: the upstream knows more than
  the policy, and the client should hear it rather than wait on a gateway that will retry too early.
- A request body is replayed only if it was buffered (idempotent method, `Content-Length` ≤ 1 MiB);
  otherwise the body streams through once and the request is not retried.
- Every attempt goes through the circuit breaker; a circuit that opens mid-sequence ends it.

## Consequences

- Duplicate side effects are impossible by construction, not by configuration. Clients that need
  safe `POST` retries must supply an idempotency key that the *upstream* honours; that is outside
  the gateway's scope.
- Full jitter spreads retries over the whole interval, which is what prevents retry storms; the
  price is less predictable latency within the bound.
- Responses discarded by a retry have their bodies cancelled so keep-alive connections are freed.
- The worst-case added latency of a route is bounded and computable from its config:
  `(attempts − 1) · maxDelayMs + attempts · timeoutMs`.
