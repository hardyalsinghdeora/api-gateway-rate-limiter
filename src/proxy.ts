import { BreakerOpenError, type CircuitBreaker } from './breaker.js';
import type { RouteConfig } from './config.js';
import { REQUEST_ID_HEADER } from './requestId.js';
import {
  isIdempotent,
  parseRetryAfterMs,
  RETRYABLE_STATUSES,
  withRetry,
  type AttemptOutcome,
  type RetryVerdict,
} from './retry.js';

/** RFC 9110 §7.6.1: connection-specific headers are meaningful for one hop only and must not be forwarded. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Bodies up to this size are buffered so an idempotent request can be replayed on retry; larger or chunked ones stream through once. */
const MAX_REPLAYABLE_BODY_BYTES = 1024 * 1024;

type ForwardedBody = NonNullable<RequestInit['body']> | null;

export function stripHopByHop(source: Headers): Headers {
  // The Connection header may name additional hop-by-hop headers.
  const named = (source.get('connection') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  const out = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP.has(name) && !named.includes(name)) out.append(name, value);
  }
  return out;
}

/** Longest matching prefix wins; a prefix matches the path itself or any path beneath it. */
export function matchRoute<R extends { prefix: string }>(routes: readonly R[], path: string): R | undefined {
  let best: R | undefined;
  for (const route of routes) {
    const { prefix } = route;
    const matches = prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
    if (matches && (best === undefined || prefix.length > best.prefix.length)) best = route;
  }
  return best;
}

export type RouteTarget = Pick<RouteConfig, 'prefix' | 'upstream' | 'stripPrefix'>;

export function buildUpstreamUrl(route: RouteTarget, path: string, search: string): URL {
  const rest = route.stripPrefix && route.prefix !== '/' ? path.slice(route.prefix.length) : path;
  const url = new URL(route.upstream);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${rest === '' ? '/' : rest}`;
  url.search = search;
  return url;
}

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';

  constructor(
    readonly status: 502 | 504,
    readonly title: string,
    readonly upstream: string,
    options?: ErrorOptions,
  ) {
    super(`${title}: ${upstream}`, options);
  }
}

export class ClientAbortedError extends Error {
  override readonly name = 'ClientAbortedError';

  constructor() {
    super('client closed the connection before the upstream responded');
  }
}

export interface ProxyInput {
  request: Request;
  route: RouteConfig;
  breaker: CircuitBreaker;
  requestId: string;
  clientIp: string;
  trustProxy: boolean;
}

export interface ProxyDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** Sees every upstream attempt; `status` is undefined when no response arrived. */
  onAttempt?: (upstream: string, durationMs: number, status: number | undefined) => void;
  onRetry?: (route: RouteConfig, attempt: number, delayMs: number) => void;
}

export async function proxy(input: ProxyInput, deps: ProxyDeps): Promise<Response> {
  const { request, route, breaker } = input;
  const incoming = new URL(request.url);
  const url = buildUpstreamUrl(route, incoming.pathname, incoming.search);
  const headers = forwardedHeaders(input, incoming);
  const { body, replayable } = await prepareBody(request);
  const policy = replayable && isIdempotent(request.method) ? route.retry : { ...route.retry, attempts: 1 };

  const attempt = async (): Promise<Response> => {
    const startedAt = deps.now();
    const permit = breaker.tryAcquire(startedAt);
    if (permit === undefined) throw new BreakerOpenError(route.upstream, breaker.retryAfterMs(startedAt));

    // The timeout covers the wait for response headers only; a slow body is the client's
    // business, while a client that leaves aborts the upstream call through its own signal.
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, route.timeoutMs);
    try {
      const response = await deps.fetch(url, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.any([timeout.signal, request.signal]),
        ...(body !== null && { duplex: 'half' as const }),
      });
      const transient = RETRYABLE_STATUSES.has(response.status);
      breaker.record(permit, transient ? 'failure' : 'success', deps.now());
      deps.onAttempt?.(route.upstream, deps.now() - startedAt, response.status);
      return response;
    } catch (error: unknown) {
      const now = deps.now();
      deps.onAttempt?.(route.upstream, now - startedAt, undefined);
      if (request.signal.aborted) {
        breaker.record(permit, 'abandoned', now);
        throw new ClientAbortedError();
      }
      breaker.record(permit, 'failure', now);
      throw timeout.signal.aborted
        ? new UpstreamError(504, 'Gateway Timeout', route.upstream, { cause: error })
        : new UpstreamError(502, 'Bad Gateway', route.upstream, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };

  const judge = (outcome: AttemptOutcome<Response>): RetryVerdict => {
    if (!outcome.ok) return { retry: outcome.error instanceof UpstreamError };
    if (!RETRYABLE_STATUSES.has(outcome.value.status)) return { retry: false };
    return { retry: true, retryAfterMs: parseRetryAfterMs(outcome.value.headers.get('retry-after'), deps.now()) };
  };

  const upstream = await withRetry(policy, attempt, judge, {
    sleep: deps.sleep,
    random: deps.random,
    discard: (response) => {
      // Release the connection held by a response we will not forward.
      void response.body?.cancel();
    },
    onRetry: (n, delayMs) => deps.onRetry?.(route, n, delayMs),
  });
  return relay(upstream);
}

function forwardedHeaders(input: ProxyInput, incoming: URL): Headers {
  const headers = stripHopByHop(input.request.headers);
  headers.delete('host'); // fetch derives it from the upstream URL
  headers.delete('content-length'); // recomputed for buffered bodies, chunked for streams
  const priorFor = input.trustProxy ? headers.get('x-forwarded-for') : null;
  const priorProto = input.trustProxy ? headers.get('x-forwarded-proto') : null;
  headers.set('x-forwarded-for', priorFor === null ? input.clientIp : `${priorFor}, ${input.clientIp}`);
  headers.set('x-forwarded-proto', priorProto ?? incoming.protocol.slice(0, -1));
  headers.set('x-forwarded-host', input.request.headers.get('host') ?? incoming.host);
  headers.set(REQUEST_ID_HEADER, input.requestId);
  return headers;
}

async function prepareBody(request: Request): Promise<{ body: ForwardedBody; replayable: boolean }> {
  if (request.body === null) return { body: null, replayable: true };
  const length = Number(request.headers.get('content-length'));
  if (isIdempotent(request.method) && length > 0 && length <= MAX_REPLAYABLE_BODY_BYTES) {
    return { body: await request.arrayBuffer(), replayable: true };
  }
  return { body: request.body, replayable: false };
}

function relay(upstream: Response): Response {
  const headers = stripHopByHop(upstream.headers);
  // fetch has already decoded the body but left the headers describing the encoded one.
  if (headers.has('content-encoding')) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
