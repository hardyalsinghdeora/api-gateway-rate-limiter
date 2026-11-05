import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import type { Logger } from 'pino';
import { BreakerOpenError, CircuitBreaker } from './breaker.js';
import { API_KEY_HEADER, clientIp, clientKey, type KeyBy } from './client.js';
import type { GatewayConfig, RouteConfig } from './config.js';
import { problemResponse } from './problem.js';
import { ClientAbortedError, matchRoute, proxy, UpstreamError, type ProxyDeps } from './proxy.js';
import { ceilSeconds, rateLimitHeaders } from './ratelimit/headers.js';
import { createRateLimiter, type RateLimiter } from './ratelimit/limiter.js';
import { InMemoryRateLimitStore, type RateLimitStore } from './ratelimit/store.js';
import { requestId, type RequestIdVariables } from './requestId.js';

export interface GatewayDeps {
  logger: Logger;
  store?: RateLimitStore;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  remoteAddress?: (c: Context) => string | undefined;
}

interface AppEnv {
  Variables: RequestIdVariables;
}

interface BoundRoute {
  prefix: string;
  route: RouteConfig;
  breaker: CircuitBreaker;
  limit: { limiter: RateLimiter; keyBy: KeyBy } | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createApp(config: GatewayConfig, deps: GatewayDeps): Hono<AppEnv> {
  const { logger } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const store = deps.store ?? new InMemoryRateLimitStore();
  const remoteAddress = deps.remoteAddress ?? ((c): string | undefined => getConnInfo(c).remote.address);
  const proxyDeps: ProxyDeps = {
    fetch: deps.fetch ?? fetch,
    now,
    sleep: deps.sleep ?? sleep,
    random: deps.random ?? Math.random,
    onRetry: (route, attempt, delayMs) => {
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
        logger.warn({ upstream: origin, state }, 'circuit breaker state changed');
      });
      breakers.set(origin, breaker);
    }
    const limit =
      route.rateLimit === undefined
        ? undefined
        : { limiter: createRateLimiter(route.rateLimit, store), keyBy: route.rateLimit.keyBy };
    return { prefix: route.prefix, route, breaker, limit };
  });

  const app = new Hono<AppEnv>();
  app.use(requestId());

  app.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      upstreams: Object.fromEntries([...breakers].map(([origin, breaker]) => [origin, breaker.state(now())])),
    }),
  );

  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const bound = matchRoute(routes, url.pathname);
    if (bound === undefined) return c.notFound();
    const { route, breaker, limit } = bound;
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
          return fail(
            429,
            'Too Many Requests',
            `Rate limit of ${decision.limit} requests exceeded for ${route.prefix}.`,
            limitHeaders,
          );
        }
      } catch (error: unknown) {
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
