import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { GatewayConfig } from './config.js';
import { problemResponse } from './problem.js';
import { requestId, type RequestIdVariables } from './requestId.js';

export interface GatewayDeps {
  logger: Logger;
}

interface AppEnv {
  Variables: RequestIdVariables;
}

export function createApp(config: GatewayConfig, deps: GatewayDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestId());

  app.get('/healthz', (c) =>
    c.json({ status: 'ok', routes: config.routes.map((r) => r.prefix) }),
  );

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
    deps.logger.error({ err: error, requestId: c.get('requestId') }, 'unhandled error');
    return problemResponse({
      status: 500,
      title: 'Internal Server Error',
      instance: c.req.path,
      requestId: c.get('requestId'),
    });
  });

  return app;
}
