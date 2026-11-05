import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const retrySchema = z
  .object({
    /** Total attempts including the first one; 1 disables retries. */
    attempts: z.number().int().min(1).max(10).default(1),
    baseDelayMs: z.number().int().min(0).default(100),
    maxDelayMs: z.number().int().min(0).default(2000),
  })
  .refine((r) => r.maxDelayMs >= r.baseDelayMs, {
    message: 'maxDelayMs must be greater than or equal to baseDelayMs',
    path: ['maxDelayMs'],
  });

const keyBySchema = z.enum(['api-key', 'ip']);

const rateLimitSchema = z.discriminatedUnion('algorithm', [
  z.object({
    algorithm: z.literal('token-bucket'),
    capacity: z.number().int().min(1),
    refillPerSecond: z.number().positive(),
    keyBy: keyBySchema,
  }),
  z.object({
    algorithm: z.literal('sliding-window'),
    limit: z.number().int().min(1),
    windowMs: z.number().int().min(1),
    keyBy: keyBySchema,
  }),
]);

const routeSchema = z.object({
  prefix: z
    .string()
    .regex(/^\/[^\s?#]*$/, 'must be an absolute path without query or fragment')
    .refine((p) => p === '/' || !p.endsWith('/'), 'must not end with a slash'),
  upstream: z.url({ protocol: /^https?$/ }),
  stripPrefix: z.boolean().default(true),
  timeoutMs: z.number().int().min(1).default(5000),
  retry: retrySchema.prefault({}),
  rateLimit: rateLimitSchema.optional(),
});

const breakerSchema = z.object({
  /** Failures within `windowMs` that open the circuit. */
  failureThreshold: z.number().int().min(1).default(5),
  windowMs: z.number().int().min(1).default(10_000),
  /** How long the circuit stays open before a single probe is let through. */
  openMs: z.number().int().min(1).default(30_000),
});

export const configSchema = z
  .object({
    trustProxy: z.boolean().default(false),
    onStoreError: z.enum(['open', 'closed']).default('open'),
    shutdownTimeoutMs: z.number().int().min(0).default(10_000),
    breaker: breakerSchema.prefault({}),
    routes: z.array(routeSchema).min(1),
  })
  .refine((c) => new Set(c.routes.map((r) => r.prefix)).size === c.routes.length, {
    message: 'route prefixes must be unique',
    path: ['routes'],
  });

export type GatewayConfig = z.infer<typeof configSchema>;
export type RouteConfig = GatewayConfig['routes'][number];
export type RetryConfig = RouteConfig['retry'];
export type RateLimitConfig = NonNullable<RouteConfig['rateLimit']>;
export type BreakerConfig = GatewayConfig['breaker'];

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CONFIG_PATH: z.string().min(1).default('./gateway.config.json'),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validates an already-parsed JSON value; the error message lists every problem with its path. */
export function parseConfig(input: unknown, source = 'config'): GatewayConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(`Invalid gateway configuration (${source}):\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read configuration file ${path}: ${describe(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Configuration file ${path} is not valid JSON: ${describe(error)}`);
  }
  return parseConfig(json, path);
}

export function parseEnv(env: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
