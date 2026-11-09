# api-gateway-rate-limiter

A small reverse proxy / API gateway in TypeScript (Node 22, Hono) that puts rate limiting, a
circuit breaker and bounded retries in front of one or more upstream HTTP services.

It is a **reference implementation built as a portfolio sample**: the scope is deliberately small
so that every part can be read in one sitting, tested in isolation and defended in a design review.
It has not been used in production and does not claim to have been.

## What it demonstrates

- **Two rate-limit algorithms behind one interface** — token bucket (burst capacity, lazy refill,
  no timers) and sliding window log (exact count per window, pruned on access), selected per route.
- **Standard rate-limit headers** — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on
  every limited response and a `429` with an integer `Retry-After` (always rounded *up*).
- **A deliberate fail-open policy** — when the limiter's store fails, requests pass with a warning
  and a metric; `onStoreError: "closed"` flips that to a `503`.
- **A circuit breaker per upstream** — closed → open after N failures in a rolling window, open
  returns `503` immediately, half-open lets exactly one probe through.
- **Bounded retries with full jitter, for idempotent methods only** — never for `POST`/`PATCH`,
  only on network errors or `502`/`503`/`504`, honouring `Retry-After`.
- **Request-id tracing** — `X-Request-Id` is echoed when well-formed or generated, forwarded
  upstream and stamped on every response, errors included.
- **Prometheus metrics** written by hand in the text exposition format, with a fixed-bucket
  latency histogram and a breaker-state gauge.
- **Graceful shutdown** — on `SIGTERM`/`SIGINT` the listener closes, in-flight requests drain
  within a deadline, and the rest are cut.
- **RFC 9457 `application/problem+json`** bodies for every error the gateway produces itself.

## Architecture

```
client ──► gateway ────────────────────────────────────────────────► upstream
           │
           ├─ request id      echo X-Request-Id if well-formed, else UUID
           ├─ identify        X-Api-Key, or client IP (X-Forwarded-For only if trustProxy)
           ├─ rate limit      token bucket | sliding window  ──► 429 + RateLimit-* / Retry-After
           ├─ breaker         closed | open (503, Retry-After) | half-open (one probe)
           ├─ proxy           fetch, streamed body, hop-by-hop stripped, X-Forwarded-*, timeout
           │   └─ retry       idempotent only, 502/503/504 or network error, full jitter
           └─ observe         pino access log, /metrics, /healthz
```

Source layout (about 1,300 lines of TypeScript, tests excluded):

| Module | Responsibility |
|---|---|
| `src/config.ts` | zod schema for `gateway.config.json` and the environment; readable errors |
| `src/ratelimit/limiter.ts` | `RateLimitDecision`, `RateLimiter`, algorithm selection |
| `src/ratelimit/tokenBucket.ts`, `slidingWindow.ts` | pure, timer-free algorithm maths |
| `src/ratelimit/store.ts` | `RateLimitStore` (the Redis extension point) and the in-memory store |
| `src/ratelimit/headers.ts` | decision → `RateLimit-*` and `Retry-After` |
| `src/client.ts` | client IP resolution and hashed per-client keys |
| `src/breaker.ts` | circuit breaker with permits, so late results cannot corrupt a newer state |
| `src/retry.ts` | idempotency rule, retryable statuses, full-jitter backoff, `withRetry` |
| `src/proxy.ts` | route matching, URL rewriting, header forwarding, timeouts, relay |
| `src/metrics.ts` | counters, gauges, histogram and the Prometheus text format |
| `src/requestId.ts`, `src/problem.ts` | request-id middleware, problem+json responses |
| `src/server.ts`, `src/main.ts` | wiring, `/healthz`, `/metrics`, graceful shutdown, signals |

## Quick start

```sh
npm install
npm run demo:upstream        # terminal 1: an echo service on :4001 (?status=503, ?delay=ms to misbehave)
npm run dev                  # terminal 2: the gateway on :8080 with ./gateway.config.json
```

The example config limits `/api/orders` with a token bucket of 5 per API key, refilled at 1/s:

```sh
curl -i -H 'X-Api-Key: demo' 'http://localhost:8080/api/orders/42?x=1'
# HTTP/1.1 200 OK
# ratelimit-limit: 5
# ratelimit-remaining: 4
# ratelimit-reset: 1
# x-request-id: 1b1f0a9e-...
# { "method": "GET", "path": "/42", ... }          <- echoed by the demo upstream

for i in $(seq 6); do curl -s -o /dev/null -w '%{http_code} ' -H 'X-Api-Key: demo' http://localhost:8080/api/orders; done
# 200 200 200 200 429 429

curl -i -H 'X-Api-Key: demo' http://localhost:8080/api/orders
# HTTP/1.1 429 Too Many Requests
# content-type: application/problem+json
# ratelimit-limit: 5
# ratelimit-remaining: 0
# ratelimit-reset: 5
# retry-after: 1
# x-request-id: 4f7c6c2d-...
# {"type":"about:blank","title":"Too Many Requests","status":429,
#  "detail":"Rate limit of 5 requests exceeded for /api/orders.","instance":"/api/orders","requestId":"4f7c6c2d-..."}
```

Trip the breaker (5 failures in 10 s by default) and watch it in `/healthz` and `/metrics`:

```sh
for i in $(seq 5); do curl -s -o /dev/null 'http://localhost:8080/api/catalog/items?status=503'; done
curl -i http://localhost:8080/api/catalog/items          # 503 problem+json, "circuit open", Retry-After: 30
curl -s http://localhost:8080/healthz                    # {"status":"ok","upstreams":{"http://localhost:4001":"open"}}
curl -s http://localhost:8080/metrics | grep gateway_breaker_state
```

Docker:

```sh
docker build -t api-gateway-rate-limiter .
docker run --rm -p 8080:8080 -v "$PWD/gateway.config.json:/app/gateway.config.json:ro" api-gateway-rate-limiter
```

Inside a container `localhost:4001` is the container itself; point `upstream` at a reachable host
(for example `http://host.docker.internal:4001` on Docker Desktop).

## Configuration

`CONFIG_PATH` (default `./gateway.config.json`) is validated with zod at startup; every problem is
reported with its JSON path. Environment: `PORT` (8080), `LOG_LEVEL` (info), `CONFIG_PATH`. There is no
`.env` loader; use `node --env-file=.env dist/main.js` if you want one (see `.env.example`).

| Key | Default | Meaning |
|---|---|---|
| `trustProxy` | `false` | Trust `X-Forwarded-For`/`-Proto` from the hop in front. The client IP is then the **rightmost** `X-Forwarded-For` entry, the one that hop appended; entries to its left are client-controlled. When `false` the headers are ignored and replaced. |
| `onStoreError` | `"open"` | What happens when the rate-limit store throws: `open` lets the request through (warning + metric), `closed` answers `503` with `Retry-After: 1`. |
| `shutdownTimeoutMs` | `10000` | How long in-flight requests may finish after `SIGTERM`/`SIGINT` before connections are cut. |
| `breaker.failureThreshold` | `5` | Failures inside `windowMs` that open an upstream's circuit. A failure is a network error, a timeout or a `502`/`503`/`504`. |
| `breaker.windowMs` | `10000` | Rolling window for counting failures. |
| `breaker.openMs` | `30000` | How long the circuit stays open before a single probe is let through. |
| `routes[].prefix` | required | Absolute path without trailing slash; the longest matching prefix wins; `/` catches everything. |
| `routes[].upstream` | required | `http(s)://host[:port][/base-path]`. Routes sharing an origin share a breaker. |
| `routes[].stripPrefix` | `true` | Remove the prefix before forwarding (`/api/orders/1` → `/1`). |
| `routes[].timeoutMs` | `5000` | Time allowed for the upstream's response **headers**; exceeding it is a `504` and a breaker failure. |
| `routes[].retry.attempts` | `1` | Total attempts including the first (max 10); `1` disables retries. |
| `routes[].retry.baseDelayMs` | `100` | Ceiling of the first backoff; doubles per attempt. |
| `routes[].retry.maxDelayMs` | `2000` | Backoff cap. A `Retry-After` larger than this ends the retries instead of being waited for. |
| `routes[].rateLimit` | none | `{ "algorithm": "token-bucket", "capacity", "refillPerSecond", "keyBy" }` or `{ "algorithm": "sliding-window", "limit", "windowMs", "keyBy" }`; `keyBy` is `"api-key"` (hashed `X-Api-Key`, falling back to the IP when absent) or `"ip"`. |

### Endpoints owned by the gateway

- `GET /healthz` — `200` with the breaker state of every upstream (`closed`, `open`, `half-open`).
  The gateway itself is healthy even when an upstream is not; that is what the state is for.
- `GET /metrics` — Prometheus text format: `gateway_requests_total{route,method,status}`,
  `gateway_rate_limited_total{route}`, `gateway_rate_limit_store_errors_total{route,policy}`,
  `gateway_upstream_retries_total{route}`, `gateway_breaker_state{upstream}` (0 closed, 1 half-open,
  2 open), `gateway_in_flight_requests`, `gateway_upstream_latency_seconds{upstream}` histogram.
- Everything else is matched against `routes[]`; no match is a `404` problem document.

### Header semantics

- `RateLimit-Reset` is the number of seconds until the **full quota** is back (bucket full, or
  window empty). `Retry-After` on a `429` is the number of seconds until the **next** request can
  succeed. Both are rounded up, so `Retry-After` is never `0`.
- Hop-by-hop headers (`Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`,
  `Proxy-*`, plus anything `Connection` names) are stripped in both directions. `X-Forwarded-For`,
  `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Request-Id` are set on the upstream request.
- Redirects from the upstream are passed through, not followed.
- If the upstream compresses its response, `fetch` decodes it; the stale `Content-Encoding` and
  `Content-Length` are dropped so the client gets a truthful, plain body.

## Design decisions

Short ADRs live in [`docs/adr`](docs/adr). The ones worth knowing before reading the code:

- **Lazy refill instead of timers** ([ADR 0001](docs/adr/0001-token-bucket-vs-sliding-window.md)).
  A bucket's level is a function of `(tokens, updatedAt, now)`, computed on access. Idle keys cost
  nothing, there is no timer per client to leak, and the same maths runs unchanged inside a Redis
  Lua script. The trade-off is fractional state and ceil-rounding at the edges, both covered by tests.
- **Sliding window log, not fixed windows.** Fixed windows admit 2× the limit across a boundary;
  the log is exact at the cost of `O(limit)` memory per key. Rejected requests are *not* recorded,
  so a client that backs off as told is admitted when the oldest hit expires instead of being locked
  out for as long as it keeps knocking.
- **Fail open on store errors by default** ([ADR 0002](docs/adr/0002-fail-open-on-store-errors.md)).
  A limiter exists to protect upstreams from abuse, not to turn a Redis outage into a full outage.
  Each pass-through is logged and counted (`gateway_rate_limit_store_errors_total`) so the condition
  cannot go unnoticed; `onStoreError: "closed"` exists for deployments where quota enforcement is a
  contractual requirement.
- **No retry on `POST`/`PATCH`, ever** ([ADR 0003](docs/adr/0003-retry-policy.md)). A gateway cannot
  know whether a timed-out `POST` was applied. Retries are limited to RFC 9110 idempotent methods and
  to failures that say "not right now" (`502`/`503`/`504`, connection errors), use full-jitter
  backoff so retries do not arrive in waves, and honour `Retry-After` — unless it exceeds
  `maxDelayMs`, in which case the upstream's own advice ends the attempt rather than being ignored.
  A body is replayed only when it was small enough (≤ 1 MiB, with `Content-Length`) to buffer.
- **Breaker state is guarded by permits.** `tryAcquire` hands out a permit that must be handed back
  with the outcome. A late result from a request that started before the circuit opened, or a regular
  request's result arriving while half-open, is ignored; only the probe decides. Half-open → closed
  also clears the failure history. A client that disconnects mid-probe neither closes nor opens the
  circuit; the next request probes again.
- **Timeouts cover headers, not bodies.** `timeoutMs` bounds the wait for the upstream's status and
  headers. A slow download afterwards is the client's business, while a client that disconnects
  aborts the upstream call through its own signal (`AbortSignal.any`).
- **In-memory store first, Redis as the extension point.** `RateLimitStore` has exactly two
  methods, `consumeToken` and `recordHit`, each an atomic read-modify-write for one key. That is the
  whole contract a distributed implementation has to meet (sketch below). The in-memory store sweeps
  expired keys every N writes, so garbage collection follows traffic and needs no timer either.
- **Problem details everywhere.** A client can tell a gateway-generated error from an upstream
  payload by the media type alone, and the `requestId` member ties it to the logs.

### How Redis slots in

A Redis store implements the same two methods with scripts, so the read-modify-write stays atomic
across gateway instances. The token bucket is the same maths as `tokenBucket.ts`:

```lua
-- KEYS[1] = bucket key   ARGV = capacity, refillPerSecond, nowMs
local capacity, rate, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local tokens, updatedAt = unpack(redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt'))
if tokens == false then tokens, updatedAt = capacity, now
else tokens, updatedAt = tonumber(tokens), tonumber(updatedAt) end
tokens = math.min(capacity, tokens + math.max(0, now - updatedAt) / 1000 * rate)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity - tokens) / rate * 1000))
return { allowed and 1 or 0, tostring(tokens) }
```

The sliding window is a sorted set of hit timestamps:

```
ZREMRANGEBYSCORE key -inf (now - windowMs)      -- prune
ZCARD key                                       -- count
ZADD key now <now>:<uuid>  (only if count < limit)
PEXPIRE key windowMs
```

Run inside `MULTI`/`EXEC` those four commands are cheap but the `ZCARD`/`ZADD` pair is not atomic
with respect to other gateway instances, so a window can briefly over-admit by about one request per
concurrent instance. Wrapping the same commands in a Lua script gives exactly the semantics of
`slidingWindow.ts`. Either way the gateway code does not change: `createRateLimiter` only sees a
`RateLimitStore`.

## Deliberately out of scope

- Authentication and authorization (JWT validation, API-key lookup, scopes). The gateway only uses
  `X-Api-Key` as an opaque, hashed rate-limit key.
- TLS termination; run it behind a load balancer or a TLS-terminating proxy and set `trustProxy`.
- A distributed rate-limit store; the interface and the Redis sketch above are the extension point.
- WebSockets, HTTP/2 to upstreams, request/response transformation, caching, service discovery.

## Development

```sh
npm run lint        # eslint, type-aware rules
npm run typecheck   # tsc --noEmit, including tests and scripts
npm test            # vitest: unit tests with fake timers + integration tests over real TCP
npm run build       # tsc → dist/
npm start           # node dist/main.js
```

CI (`.github/workflows/ci.yml`) runs the same four steps on every push to `main` and every pull
request. The Dockerfile is a two-stage build on `node:22-alpine` that runs as the unprivileged `node`
user with a `HEALTHCHECK` against `/healthz`.

## About

Written by Hardyal Singh Deora — [hardyal.is-a.dev](https://hardyal.is-a.dev) ·
[github.com/hardyalsinghdeora](https://github.com/hardyalsinghdeora) — as a reference implementation
and portfolio sample of the gateway concerns (rate limiting, resilience, observability) that I care
about in backend work. It is MIT licensed; use it as a starting point, not as a dependency.
