import { describe, expect, it, vi } from 'vitest';
import { BreakerOpenError, CircuitBreaker } from '../src/breaker.js';
import type { RouteConfig } from '../src/config.js';
import {
  buildUpstreamUrl,
  ClientAbortedError,
  matchRoute,
  proxy,
  stripHopByHop,
  UpstreamError,
  type ProxyDeps,
} from '../src/proxy.js';

const route: RouteConfig = {
  prefix: '/api/orders',
  upstream: 'http://upstream.test:4001',
  stripPrefix: true,
  timeoutMs: 50,
  retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
};

describe('stripHopByHop', () => {
  it('drops RFC 9110 hop-by-hop headers and those the Connection header names', () => {
    const stripped = stripHopByHop(
      new Headers({
        connection: 'keep-alive, X-Custom-Hop',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'x-custom-hop': '1',
        upgrade: 'h2c',
        te: 'trailers',
        'content-type': 'application/json',
        authorization: 'Bearer t',
      }),
    );
    expect([...stripped.keys()].sort()).toEqual(['authorization', 'content-type']);
  });
});

describe('matchRoute', () => {
  const routes = [{ prefix: '/api' }, { prefix: '/api/orders' }];

  it('picks the longest prefix and respects path boundaries', () => {
    expect(matchRoute(routes, '/api/orders/1')?.prefix).toBe('/api/orders');
    expect(matchRoute(routes, '/api/orders')?.prefix).toBe('/api/orders');
    expect(matchRoute(routes, '/api/ordersx')?.prefix).toBe('/api');
    expect(matchRoute(routes, '/other')).toBeUndefined();
    expect(matchRoute([...routes, { prefix: '/' }], '/other')?.prefix).toBe('/');
  });
});

describe('buildUpstreamUrl', () => {
  it('strips the prefix and keeps the query', () => {
    expect(buildUpstreamUrl(route, '/api/orders/1', '?page=2').href).toBe('http://upstream.test:4001/1?page=2');
    expect(buildUpstreamUrl(route, '/api/orders', '').href).toBe('http://upstream.test:4001/');
  });

  it('keeps the prefix when asked and joins onto an upstream base path', () => {
    expect(buildUpstreamUrl({ ...route, stripPrefix: false }, '/api/orders/1', '').pathname).toBe('/api/orders/1');
    expect(buildUpstreamUrl({ ...route, upstream: 'http://u/v1/' }, '/api/orders/1', '').href).toBe('http://u/v1/1');
    expect(buildUpstreamUrl({ ...route, prefix: '/' }, '/anything', '').pathname).toBe('/anything');
  });
});

describe('proxy', () => {
  function harness(fetchImpl: typeof fetch): { deps: ProxyDeps; sleeps: number[]; statuses: (number | undefined)[] } {
    const sleeps: number[] = [];
    const statuses: (number | undefined)[] = [];
    const deps: ProxyDeps = {
      fetch: fetchImpl,
      now: () => Date.now(),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      onAttempt: (_upstream, _durationMs, status) => {
        statuses.push(status);
      },
    };
    return { deps, sleeps, statuses };
  }

  const breakerOptions = { failureThreshold: 5, windowMs: 1_000, openMs: 1_000 };

  function send(
    request: Request,
    deps: ProxyDeps,
    overrides: { route?: Partial<RouteConfig>; breaker?: CircuitBreaker; trustProxy?: boolean } = {},
  ): Promise<Response> {
    return proxy(
      {
        request,
        route: { ...route, ...overrides.route },
        breaker: overrides.breaker ?? new CircuitBreaker(breakerOptions),
        requestId: 'req-1',
        clientIp: '10.0.0.5',
        trustProxy: overrides.trustProxy ?? false,
      },
      deps,
    );
  }

  function sentInit(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): RequestInit & { duplex?: string } {
    const init = fetchMock.mock.calls[call]?.[1];
    if (init === undefined) throw new Error(`fetch call ${call} had no init`);
    return init;
  }

  function sentUrl(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): string {
    const input = fetchMock.mock.calls[call]?.[0];
    if (!(input instanceof URL)) throw new Error(`fetch call ${call} was not given a URL`);
    return input.href;
  }

  /** A fetch that never answers; it rejects when (or if already) aborted, as the real one does. */
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });

  it('forwards the request with forwarding headers and without hop-by-hop ones', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const request = new Request('http://gw.local/api/orders/7?x=1', {
      method: 'POST',
      body: 'payload',
      headers: {
        host: 'gw.local',
        'content-type': 'text/plain',
        connection: 'keep-alive',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
      },
    });
    await send(request, harness(fetchMock).deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl(fetchMock)).toBe('http://upstream.test:4001/7?x=1');
    const init = sentInit(fetchMock);
    const headers = new Headers(init.headers);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.duplex).toBe('half');
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(headers.get('content-type')).toBe('text/plain');
    expect(headers.get('connection')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBe('10.0.0.5');
    expect(headers.get('x-forwarded-proto')).toBe('http');
    expect(headers.get('x-forwarded-host')).toBe('gw.local');
    expect(headers.get('x-request-id')).toBe('req-1');
  });

  it('appends to X-Forwarded-For and keeps X-Forwarded-Proto when the proxy is trusted', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const request = new Request('http://gw.local/api/orders', {
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
    });
    await send(request, harness(fetchMock).deps, { trustProxy: true });
    const headers = new Headers(sentInit(fetchMock).headers);
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9, 10.0.0.5');
    expect(headers.get('x-forwarded-proto')).toBe('https');
  });

  it('retries a GET on 503 with jittered backoff but never a POST', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(new Response('ok'));
    const { deps, sleeps, statuses } = harness(fetchMock);
    const response = await send(new Request('http://gw.local/api/orders/1'), deps);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([5]);
    expect(statuses).toEqual([503, 200]);

    fetchMock.mockReset().mockResolvedValue(new Response('busy', { status: 503 }));
    const post = await send(new Request('http://gw.local/api/orders', { method: 'POST', body: '{}' }), harness(fetchMock).deps);
    expect(post.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('buffers a small idempotent body so a PUT can be replayed', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 })).mockResolvedValueOnce(new Response('ok'));
    const request = new Request('http://gw.local/api/orders/1', {
      method: 'PUT',
      body: 'data',
      headers: { 'content-length': '4' },
    });
    const response = await send(request, harness(fetchMock).deps);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentInit(fetchMock, 1).body).toBeInstanceOf(ArrayBuffer);
  });

  it('honours Retry-After on a 503 and gives up when it is beyond the budget', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response('ok'));
    const { deps, sleeps } = harness(fetchMock);
    const response = await send(new Request('http://gw.local/api/orders'), deps, {
      route: { retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 2_000 } },
    });
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([1_000]);

    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 503, headers: { 'retry-after': '30' } }));
    const slow = harness(fetchMock);
    const giveUp = await send(new Request('http://gw.local/api/orders'), slow.deps);
    expect(giveUp.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slow.sleeps).toEqual([]);
  });

  it('turns a network failure into 502 after exhausting retries', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const { deps, sleeps, statuses } = harness(fetchMock);
    const error = await send(new Request('http://gw.local/api/orders'), deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(502);
    expect((error as UpstreamError).cause).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5, 10]);
    expect(statuses).toEqual([undefined, undefined, undefined]);
  });

  it('turns a timeout waiting for headers into 504 and counts it against the breaker', async () => {
    const breaker = new CircuitBreaker({ ...breakerOptions, failureThreshold: 1 });
    const { deps, statuses } = harness(hangingFetch);
    const error = await send(new Request('http://gw.local/api/orders'), deps, {
      breaker,
      route: { retry: { attempts: 1, baseDelayMs: 10, maxDelayMs: 100 } },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(504);
    expect(statuses).toEqual([undefined]);
    expect(breaker.state(Date.now())).toBe('open');
  });

  it('fails fast with BreakerOpenError and never calls the upstream when the circuit is open', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const breaker = new CircuitBreaker({ ...breakerOptions, failureThreshold: 1 });
    const { deps } = harness(fetchMock);
    await expect(send(new Request('http://gw.local/api/orders'), deps, { breaker })).rejects.toBeInstanceOf(
      BreakerOpenError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rejected = await send(new Request('http://gw.local/api/orders'), deps, { breaker }).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(BreakerOpenError);
    expect((rejected as BreakerOpenError).retryAfterMs).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a client that went away without blaming the upstream', async () => {
    const controller = new AbortController();
    const breaker = new CircuitBreaker({ ...breakerOptions, failureThreshold: 1 });
    const pending = send(
      new Request('http://gw.local/api/orders', { signal: controller.signal }),
      harness(hangingFetch).deps,
      { breaker },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ClientAbortedError);
    expect(breaker.state(Date.now())).toBe('closed');
  });

  it('relays status and body, dropping hop-by-hop and stale encoding headers', async () => {
    const upstream = new Response('plain text', {
      status: 201,
      headers: { 'content-encoding': 'gzip', 'content-length': '31', connection: 'close', 'x-upstream': 'a' },
    });
    const response = await send(new Request('http://gw.local/api/orders'), harness(vi.fn<typeof fetch>().mockResolvedValue(upstream)).deps);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('plain text');
    expect(response.headers.get('x-upstream')).toBe('a');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('connection')).toBeNull();
  });
});
