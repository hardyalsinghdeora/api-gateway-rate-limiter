import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { RateLimitStore } from '../src/ratelimit/store.js';
import { createApp, startServer } from '../src/server.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Upstream {
  url: string;
  received: Received[];
  /** Mutable plan: the next `failTimes` responses are 503s; every response waits `delayMs`. */
  plan: { failTimes: number; delayMs: number };
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function startUpstream(): Promise<Upstream> {
  const received: Received[] = [];
  const plan = { failTimes: 0, delayMs: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      const respond = (): void => {
        if (plan.failTimes > 0) {
          plan.failTimes -= 1;
          res.writeHead(503, { 'retry-after': '0' });
          res.end('busy');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'stub' });
        res.end(JSON.stringify({ method: req.method, url: req.url }));
      };
      if (plan.delayMs > 0) setTimeout(respond, plan.delayMs);
      else respond();
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    plan,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

type RouteOverrides = Record<string, unknown>;

function gatewayConfig(upstream: string, routeOverrides: RouteOverrides = {}, breaker: RouteOverrides = {}): unknown {
  const retry = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 };
  return {
    breaker: { failureThreshold: 2, windowMs: 10_000, openMs: 60_000, ...breaker },
    routes: [
      {
        prefix: '/api/orders',
        upstream,
        timeoutMs: 200,
        retry,
        rateLimit: { algorithm: 'token-bucket', capacity: 3, refillPerSecond: 20, keyBy: 'api-key' },
        ...routeOverrides,
      },
      {
        prefix: '/api/catalog',
        upstream,
        stripPrefix: false,
        timeoutMs: 200,
        retry,
        rateLimit: { algorithm: 'sliding-window', limit: 2, windowMs: 60_000, keyBy: 'ip' },
      },
    ],
  };
}

interface Env {
  base: string;
  upstream: Upstream;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

async function boot(options: { route?: RouteOverrides; breaker?: RouteOverrides; store?: RateLimitStore; onStoreError?: 'open' | 'closed' } = {}): Promise<Env> {
  const upstream = await startUpstream();
  const raw = gatewayConfig(upstream.url, options.route, options.breaker) as Record<string, unknown>;
  const config = parseConfig({ ...raw, ...(options.onStoreError && { onStoreError: options.onStoreError }) });
  const app = createApp(config, { logger: pino({ level: 'silent' }), ...(options.store && { store: options.store }) });
  const server = await startServer(app, { port: 0, hostname: '127.0.0.1' });
  const env: Env = {
    base: `http://127.0.0.1:${server.port}`,
    upstream,
    close: async () => {
      await server.close(1_000);
      await upstream.close();
    },
  };
  cleanups.push(() => env.close());
  return env;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function metricsText(base: string): Promise<string> {
  const res = await fetch(`${base}/metrics`);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

describe('gateway (integration)', () => {
  it('proxies to the upstream, stripping the prefix and forwarding the query, body and headers', async () => {
    const { base, upstream } = await boot();
    const res = await fetch(`${base}/api/orders/42?page=2`, {
      method: 'PUT',
      body: '{"qty":1}',
      headers: { 'content-type': 'application/json', 'x-request-id': 'trace-1', connection: 'close' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'PUT', url: '/42?page=2' });
    expect(res.headers.get('x-request-id')).toBe('trace-1');
    expect(res.headers.get('x-upstream')).toBe('stub');
    expect(res.headers.get('ratelimit-limit')).toBe('3');
    expect(res.headers.get('ratelimit-remaining')).toBe('2');
    expect(res.headers.get('ratelimit-reset')).toBe('1');

    const seen = upstream.received[0];
    expect(seen?.body).toBe('{"qty":1}');
    expect(seen?.headers['x-request-id']).toBe('trace-1');
    expect(seen?.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(seen?.headers['x-forwarded-proto']).toBe('http');
    expect(seen?.headers['x-forwarded-host']).toBe(new URL(base).host);
    expect(seen?.headers['content-type']).toBe('application/json');

    const catalog = await fetch(`${base}/api/catalog/items`);
    expect(await catalog.json()).toEqual({ method: 'GET', url: '/api/catalog/items' });
  });

  it('generates a request id when the client sends none and answers 404 as problem+json', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/nowhere`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toMatchObject({ status: 404, title: 'Not Found', instance: '/nowhere', requestId: id });
  });

  it('returns 429 with standard headers once the limit is hit, per client, and recovers', async () => {
    const { base, upstream } = await boot();
    const statuses: number[] = [];
    const remaining: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${base}/api/orders`, { headers: { 'x-api-key': 'alice' } });
      statuses.push(res.status);
      remaining.push(res.headers.get('ratelimit-remaining'));
      if (res.status === 429) {
        expect(res.headers.get('retry-after')).toBe('1');
        expect(res.headers.get('ratelimit-limit')).toBe('3');
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        expect(await res.json()).toMatchObject({ status: 429, title: 'Too Many Requests' });
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(remaining).toEqual(['2', '1', '0', '0']);
    expect(upstream.received).toHaveLength(3);

    const other = await fetch(`${base}/api/orders`, { headers: { 'x-api-key': 'bob' } });
    expect(other.status).toBe(200);

    await wait(60); // 20 tokens/s: one token is back
    const recovered = await fetch(`${base}/api/orders`, { headers: { 'x-api-key': 'alice' } });
    expect(recovered.status).toBe(200);
    expect(await metricsText(base)).toContain('gateway_rate_limited_total{route="/api/orders"} 1\n');
  });

  it('retries GET on 503 with the Retry-After hint but passes a 503 straight through for POST', async () => {
    const { base, upstream } = await boot({ breaker: { failureThreshold: 10 } });
    upstream.plan.failTimes = 2;
    const get = await fetch(`${base}/api/orders/1`);
    expect(get.status).toBe(200);
    expect(upstream.received).toHaveLength(3);

    upstream.plan.failTimes = 1;
    const post = await fetch(`${base}/api/orders`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(503);
    expect(await post.text()).toBe('busy');
    expect(upstream.received).toHaveLength(4);
    expect(await metricsText(base)).toContain('gateway_upstream_retries_total{route="/api/orders"} 2\n');
  });

  it('opens the circuit after repeated failures, fails fast with 503, and closes again after a good probe', async () => {
    const { base, upstream } = await boot({ route: { retry: { attempts: 1 } }, breaker: { openMs: 100 } });
    upstream.plan.failTimes = 10;
    expect((await fetch(`${base}/api/orders`)).status).toBe(503);
    expect((await fetch(`${base}/api/orders`)).status).toBe(503);
    expect(upstream.received).toHaveLength(2);

    const rejected = await fetch(`${base}/api/orders`);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(rejected.headers.get('content-type')).toBe('application/problem+json');
    expect(await rejected.json()).toMatchObject({ status: 503, detail: expect.stringContaining('circuit open') as string });
    expect(upstream.received).toHaveLength(2);

    const health = await fetch(`${base}/healthz`);
    expect(await health.json()).toEqual({ status: 'ok', upstreams: { [upstream.url]: 'open' } });
    expect(await metricsText(base)).toContain(`gateway_breaker_state{upstream="${upstream.url}"} 2\n`);

    await wait(120);
    upstream.plan.failTimes = 0;
    expect((await fetch(`${base}/api/orders`)).status).toBe(200);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ upstreams: { [upstream.url]: 'closed' } });
  });

  it('answers 504 when the upstream is slower than timeoutMs', async () => {
    const { base, upstream } = await boot({ route: { timeoutMs: 50, retry: { attempts: 1 } } });
    upstream.plan.delayMs = 300;
    const res = await fetch(`${base}/api/orders`);
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ status: 504, title: 'Gateway Timeout' });
  });

  it('fails open by default when the rate limit store breaks, or closed when configured', async () => {
    const broken: RateLimitStore = {
      consumeToken: () => Promise.reject(new Error('store down')),
      recordHit: () => Promise.reject(new Error('store down')),
    };
    const open = await boot({ store: broken });
    const allowed = await fetch(`${open.base}/api/orders`);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('ratelimit-limit')).toBeNull();
    expect(await metricsText(open.base)).toContain('gateway_rate_limit_store_errors_total{policy="open",route="/api/orders"} 1\n');

    const closed = await boot({ store: broken, onStoreError: 'closed' });
    const refused = await fetch(`${closed.base}/api/orders`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(closed.upstream.received).toHaveLength(0);
  });

  it('exposes request counts and upstream latency in /metrics', async () => {
    const { base, upstream } = await boot();
    await fetch(`${base}/api/orders/a`);
    await fetch(`${base}/api/orders/b`);
    await fetch(`${base}/nowhere`);
    const text = await metricsText(base);
    expect(text).toContain('gateway_requests_total{method="GET",route="/api/orders",status="200"} 2\n');
    expect(text).toContain('gateway_requests_total{method="GET",route="-",status="404"} 1\n');
    expect(text).toContain(`gateway_upstream_latency_seconds_count{upstream="${upstream.url}"} 2\n`);
    expect(text).toContain(`gateway_upstream_latency_seconds_bucket{le="+Inf",upstream="${upstream.url}"} 2\n`);
    expect(text).toContain('gateway_in_flight_requests 1\n'); // the scrape itself
  });

  it('stops accepting connections on shutdown', async () => {
    const env = await boot();
    expect((await fetch(`${env.base}/healthz`)).status).toBe(200);
    await env.close();
    await expect(fetch(`${env.base}/healthz`)).rejects.toThrow();
  });
});
