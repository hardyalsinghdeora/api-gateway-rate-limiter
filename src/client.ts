import { createHash } from 'node:crypto';

export type KeyBy = 'api-key' | 'ip';

export const API_KEY_HEADER = 'x-api-key';

/**
 * Every proxy appends one entry to X-Forwarded-For, so with `trustProxy` the rightmost entry is
 * the address seen by the proxy directly in front of this gateway; everything to its left was
 * written by parties we have no reason to believe. Without `trustProxy` the header is ignored.
 */
export function clientIp(
  getHeader: (name: string) => string | undefined,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const last = getHeader('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (last !== undefined && last !== '') return last;
  }
  return remoteAddress ?? 'unknown';
}

/**
 * The store key for a client. API keys are hashed so the credential never becomes a store key
 * name or a log field; a request without a key is limited by address, in its own namespace, so a
 * missing header can never share a bucket with a real key.
 */
export function clientKey(keyBy: KeyBy, apiKey: string | undefined, ip: string): string {
  if (keyBy === 'api-key' && apiKey !== undefined && apiKey !== '') {
    return `key:${createHash('sha256').update(apiKey).digest('base64url').slice(0, 24)}`;
  }
  return `ip:${ip}`;
}
