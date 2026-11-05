import { getRequestListener } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createServer, type Server } from 'node:http';
import { Hono, type Context } from 'hono';
import type { Logger } from 'pino';
import { BreakerOpenError, CircuitBreaker } from './breaker.js';
import { API_KEY_HEADER, clientIp, clientKey, type KeyBy } from './client.js';
import type { GatewayConfig, RouteConfig } from './config.js';
import { GatewayMetrics, METRICS_CONTENT_TYPE } from './metrics.js';
import { problemResponse } from './problem.js';
import { ClientAbortedError, matchRoute, proxy, UpstreamError, type ProxyDeps } from './proxy.js';
import { ceilSeconds, rateLimitHeaders } from './ratelimit/headers.js';
import { createRateLimiter, type RateLimiter } from './ratelimit/limiter.js';
import { InMemoryRateLimitStore, type RateLimitStore } from './ratelimit/store.js';
import { requestId, type RequestIdVariables } from './requestId.js';

/** Everything with a side effect is injectable, so tests can run the whole gateway without timers, networks or luck. */
export interface GatewayDeps {
  logger: Logger;
  metrics?: GatewayMetrics;
  store?: RateLimitStore;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  remoteAddress?: (c: Context) => string | undefined;
}

interface GatewayVariables extends RequestIdVariables {
  route?: string;
}

interface AppEnv {
  Variables: GatewayVariables;
}

interface BoundRoute {
  prefix: string;
  route: RouteConfig;
  origin: string;
  breaker: CircuitBreaker;
  limit: { limiter: RateLimiter; keyBy: KeyBy } | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createApp(config: GatewayConfig, deps: GatewayDeps): Hono<AppEnv> {
  const { logger } = deps;
  const metrics = deps.metrics ?? new GatewayMetrics();
  const now = deps.now ?? ((): number => Date.now());
  const store = deps.store ?? new InMemoryRateLimitStore();
  const remoteAddress = deps.remoteAddress ?? ((c): string | undefined => getConnInfo(c).remote.address);
  const proxyDeps: ProxyDeps = {
    fetch: deps.fetch ?? fetch,
    now,
    sleep: deps.sleep ?? sleep,
    random: deps.random ?? Math.random,
    onAttempt: (upstream, durationMs) => {
      metrics.observeUpstreamLatency(upstream, durationMs / 1000);
    },
    onRetry: (route, attempt, delayMs) => {
      metrics.observeRetry(route.prefix);
      logger.debug({ route: route.prefix, upstream: route.upstream, attempt, delayMs }, 'retrying upstream request');
    },
  };

  // One breaker per upstream origin, shared by every route that points at it.
  const breakers = new Map<string, CircuitBreaker>();
  const routes: BoundRoute[] = config.routes.map((route) => {
    const origin = new URL(route.upstream).origin;
    let breaker = breakers.get(origin);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(config.breaker, (state) => {
        metrics.setBreakerState(origin, state);
        logger.warn({ upstream: origin, state }, 'circuit breaker state changed');
      });
      breakers.set(origin, breaker);
      metrics.setBreakerState(origin, 'closed');
    }
    const limit =
      route.rateLimit === undefined
        ? undefined
        : { limiter: createRateLimiter(route.rateLimit, store), keyBy: route.rateLimit.keyBy };
    return { prefix: route.prefix, route, origin, breaker, limit };
  });

  const app = new Hono<AppEnv>();
  app.use(requestId());
  app.use(async (c, next) => {
    const startedAt = now();
    metrics.requestStarted();
    try {
      await next();
    } finally {
      metrics.requestFinished();
      const route = c.get('route');
      metrics.observeRequest(route ?? '-', c.req.method, c.res.status);
      const entry = {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: now() - startedAt,
        route,
      };
      // Scrapes and health checks are noise at info level.
      if (route === undefined) logger.debug(entry, 'request completed');
      else logger.info(entry, 'request completed');
    }
  });

  app.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      upstreams: Object.fromEntries([...breakers].map(([origin, breaker]) => [origin, breaker.state(now())])),
    }),
  );

  app.get('/metrics', (c) => {
    // The open→half-open move happens lazily, so refresh the gauge before rendering.
    for (const [origin, breaker] of breakers) metrics.setBreakerState(origin, breaker.state(now()));
    return c.text(metrics.render(), 200, { 'content-type': METRICS_CONTENT_TYPE });
  });

  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const bound = matchRoute(routes, url.pathname);
    if (bound === undefined) return c.notFound();
    const { route, breaker, limit } = bound;
    c.set('route', route.prefix);
    const id = c.get('requestId');
    const ip = clientIp((name) => c.req.header(name), remoteAddress(c), config.trustProxy);
    const fail = (status: number, title: string, detail: string, headers?: Record<string, string>): Response =>
      problemResponse({ status, title, detail, instance: url.pathname, requestId: id, headers });

    let limitHeaders: Record<string, string> = {};
    if (limit !== undefined) {
      const key = `${route.prefix}|${clientKey(limit.keyBy, c.req.header(API_KEY_HEADER), ip)}`;
      try {
        const decision = await limit.limiter.check(key, now());
        limitHeaders = rateLimitHeaders(decision);
        if (!decision.allowed) {
          metrics.observeRateLimited(route.prefix);
          return fail(
            429,
            'Too Many Requests',
            `Rate limit of ${decision.limit} requests exceeded for ${route.prefix}.`,
            limitHeaders,
          );
        }
      } catch (error: unknown) {
        metrics.observeStoreError(route.prefix, config.onStoreError);
        logger.warn({ err: error, route: route.prefix, policy: config.onStoreError }, 'rate limit store failed');
        if (config.onStoreError === 'closed') {
          return fail(503, 'Service Unavailable', 'Rate limiting is unavailable and the gateway fails closed.', {
            'Retry-After': '1',
          });
        }
      }
    }

    try {
      const response = await proxy(
        { request: c.req.raw, route, breaker, requestId: id, clientIp: ip, trustProxy: config.trustProxy },
        proxyDeps,
      );
      for (const [name, value] of Object.entries(limitHeaders)) response.headers.set(name, value);
      return response;
    } catch (error: unknown) {
      if (error instanceof BreakerOpenError) {
        return fail(503, 'Service Unavailable', `Upstream ${error.upstream} is unavailable: circuit open.`, {
          'Retry-After': String(Math.max(1, ceilSeconds(error.retryAfterMs))),
        });
      }
      if (error instanceof UpstreamError) {
        logger.warn({ err: error, route: route.prefix, requestId: id }, 'upstream request failed');
        const reason = error.status === 504 ? 'did not respond in time' : 'could not be reached';
        return fail(error.status, error.title, `Upstream ${error.upstream} ${reason}.`);
      }
      // Nobody is listening any more; nginx's 499 keeps the log line honest.
      if (error instanceof ClientAbortedError) return new Response(null, { status: 499 });
      throw error;
    }
  });

  app.notFound((c) =>
    problemResponse({
      status: 404,
      title: 'Not Found',
      detail: 'No route matches this path.',
      instance: c.req.path,
      requestId: c.get('requestId'),
    }),
  );

  app.onError((error, c) => {
    logger.error({ err: error, requestId: c.get('requestId') }, 'unhandled error');
    return problemResponse({
      status: 500,
      title: 'Internal Server Error',
      instance: c.req.path,
      requestId: c.get('requestId'),
    });
  });

  return app;
}

export interface RunningServer {
  readonly port: number;
  /** Stops accepting connections, waits up to `drainMs` for in-flight requests, then cuts the rest. */
  close(drainMs: number): Promise<void>;
}

export function startServer(app: Hono<AppEnv>, options: { port: number; hostname?: string }): Promise<RunningServer> {
  const listener = getRequestListener((request, env) => app.fetch(request, env));
  // The adapter's listener settles every request itself (errors become 500s), so nothing is lost here.
  const server = createServer((req, res) => {
    void listener(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: options.port, host: options.hostname }, () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({ port, close: (drainMs) => shutdown(server, drainMs) });
    });
  });
}

async function shutdown(server: Server, drainMs: number): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  // close() stops accepting and drops idle keep-alive connections once; connections that go
  // idle after finishing their last response still need to be swept until everything is gone.
  const sweep = setInterval(() => {
    server.closeIdleConnections();
  }, 100);
  const deadline = setTimeout(() => {
    server.closeAllConnections();
  }, drainMs);
  try {
    await closed;
  } finally {
    clearInterval(sweep);
    clearTimeout(deadline);
  }
}
