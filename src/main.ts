import pino from 'pino';
import { ConfigError, loadConfig, parseEnv } from './config.js';
import { createApp, startServer } from './server.js';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = pino({ level: env.LOG_LEVEL });
  const config = await loadConfig(env.CONFIG_PATH);
  const app = createApp(config, { logger });
  const server = await startServer(app, { port: env.PORT });
  logger.info({ port: server.port, routes: config.routes.map((r) => r.prefix) }, 'gateway listening');

  // `once`: a second signal while draining falls through to Node's default handler and exits at once.
  const stop = (signal: NodeJS.Signals): void => {
    logger.info({ signal, drainMs: config.shutdownTimeoutMs }, 'shutting down');
    server.close(config.shutdownTimeoutMs).then(
      () => {
        logger.info('shutdown complete');
      },
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error: unknown) => {
  // The logger may not exist yet (bad env), so startup failures go straight to stderr.
  const message = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
