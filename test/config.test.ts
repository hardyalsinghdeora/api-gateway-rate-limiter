import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig, parseEnv } from '../src/config.js';

const minimalRoute = { prefix: '/api/orders', upstream: 'http://localhost:4001' };

describe('parseConfig', () => {
  it('applies defaults to a minimal route', () => {
    const config = parseConfig({ routes: [minimalRoute] });
    expect(config.trustProxy).toBe(false);
    expect(config.onStoreError).toBe('open');
    expect(config.breaker).toEqual({ failureThreshold: 5, windowMs: 10_000, openMs: 30_000 });
    expect(config.routes[0]).toMatchObject({
      stripPrefix: true,
      timeoutMs: 5000,
      retry: { attempts: 1, baseDelayMs: 100, maxDelayMs: 2000 },
    });
    expect(config.routes[0]?.rateLimit).toBeUndefined();
  });

  it('parses both rate limit algorithms', () => {
    const config = parseConfig({
      routes: [
        { ...minimalRoute, rateLimit: { algorithm: 'token-bucket', capacity: 10, refillPerSecond: 2.5, keyBy: 'api-key' } },
        { ...minimalRoute, prefix: '/api/catalog', rateLimit: { algorithm: 'sliding-window', limit: 5, windowMs: 1000, keyBy: 'ip' } },
      ],
    });
    expect(config.routes.map((r) => r.rateLimit?.algorithm)).toEqual(['token-bucket', 'sliding-window']);
  });

  it('reports every problem with its path in a readable message', () => {
    const attempt = (): void => {
      parseConfig(
        {
          routes: [
            { prefix: 'orders', upstream: 'ftp://files', retry: { attempts: 0, baseDelayMs: 500, maxDelayMs: 100 } },
            { ...minimalRoute, prefix: '/api/', rateLimit: { algorithm: 'leaky-bucket' } },
          ],
        },
        'test.json',
      );
    };
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/Invalid gateway configuration \(test\.json\)/);
    expect(attempt).toThrow(/routes\[0\]\.prefix/);
    expect(attempt).toThrow(/routes\[0\]\.upstream/);
    expect(attempt).toThrow(/routes\[0\]\.retry\.attempts/);
    expect(attempt).toThrow(/routes\[0\]\.retry\.maxDelayMs/);
    expect(attempt).toThrow(/routes\[1\]\.prefix/);
    expect(attempt).toThrow(/routes\[1\]\.rateLimit\.algorithm/);
  });

  it('rejects duplicate prefixes and empty route lists', () => {
    expect(() => parseConfig({ routes: [minimalRoute, minimalRoute] })).toThrow(/route prefixes must be unique/);
    expect(() => parseConfig({ routes: [] })).toThrow(/routes/);
  });
});

describe('loadConfig', () => {
  it('loads the committed example configuration', async () => {
    const config = await loadConfig('gateway.config.json');
    expect(config.routes.length).toBeGreaterThan(0);
  });

  it('explains unreadable and malformed files', async () => {
    await expect(loadConfig('/nonexistent/gateway.json')).rejects.toThrow(/Cannot read configuration file/);
    const dir = await mkdtemp(join(tmpdir(), 'gateway-config-'));
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ "routes": [ ');
    await expect(loadConfig(path)).rejects.toThrow(/not valid JSON/);
  });
});

describe('parseEnv', () => {
  it('defaults every variable', () => {
    expect(parseEnv({})).toEqual({ PORT: 8080, LOG_LEVEL: 'info', CONFIG_PATH: './gateway.config.json' });
  });

  it('coerces PORT and validates LOG_LEVEL', () => {
    expect(parseEnv({ PORT: '9090', LOG_LEVEL: 'debug' })).toMatchObject({ PORT: 9090, LOG_LEVEL: 'debug' });
    expect(() => parseEnv({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => parseEnv({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});
