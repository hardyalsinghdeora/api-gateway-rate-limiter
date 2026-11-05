import { serve } from '@hono/node-server';
import pino from 'pino';
import { ConfigError, loadConfig, parseEnv } from './config.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = pino({ level: env.LOG_LEVEL });
  const config = await loadConfig(env.CONFIG_PATH);
  const app = createApp(config, { logger });

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, routes: config.routes.length }, 'gateway listening');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet (bad env), so startup failures go straight to stderr.
  const message = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
