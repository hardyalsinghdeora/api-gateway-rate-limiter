import { describe, expect, it } from 'vitest';
import { clientIp, clientKey } from '../src/client.js';

const headers =
  (map: Record<string, string>) =>
  (name: string): string | undefined =>
    map[name];

describe('clientIp', () => {
  it('uses the socket address when the proxy is not trusted, whatever the headers say', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.9' }), '10.0.0.5', false)).toBe('10.0.0.5');
  });

  it('uses the rightmost X-Forwarded-For entry when the proxy is trusted', () => {
    const forwarded = headers({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7 , 192.0.2.1 ' });
    expect(clientIp(forwarded, '10.0.0.5', true)).toBe('192.0.2.1');
  });

  it('falls back to the socket when the trusted proxy sent nothing usable', () => {
    expect(clientIp(headers({}), '10.0.0.5', true)).toBe('10.0.0.5');
    expect(clientIp(headers({ 'x-forwarded-for': ' ' }), '10.0.0.5', true)).toBe('10.0.0.5');
    expect(clientIp(headers({}), undefined, true)).toBe('unknown');
  });
});

describe('clientKey', () => {
  it('hashes API keys so the credential never appears in the store', () => {
    const key = clientKey('api-key', 'secret-key-123', '10.0.0.5');
    expect(key).toMatch(/^key:[A-Za-z0-9_-]{24}$/);
    expect(key).not.toContain('secret');
    expect(clientKey('api-key', 'secret-key-123', '192.0.2.1')).toBe(key);
    expect(clientKey('api-key', 'other-key', '10.0.0.5')).not.toBe(key);
  });

  it('limits keyless requests by address, in their own namespace', () => {
    expect(clientKey('api-key', undefined, '10.0.0.5')).toBe('ip:10.0.0.5');
    expect(clientKey('api-key', '', '10.0.0.5')).toBe('ip:10.0.0.5');
  });

  it('ignores the key when limiting by address', () => {
    expect(clientKey('ip', 'secret-key-123', '10.0.0.5')).toBe('ip:10.0.0.5');
  });
});
