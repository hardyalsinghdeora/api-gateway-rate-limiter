import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, requestId, resolveRequestId } from '../src/requestId.js';

describe('resolveRequestId', () => {
  it('echoes a well-formed incoming id', () => {
    expect(resolveRequestId('req-123.abc:XYZ', () => 'generated')).toBe('req-123.abc:XYZ');
  });

  it('generates an id when the header is missing or unsafe', () => {
    expect(resolveRequestId(undefined, () => 'generated')).toBe('generated');
    expect(resolveRequestId('', () => 'generated')).toBe('generated');
    expect(resolveRequestId('bad id\r\nX-Injected: 1', () => 'generated')).toBe('generated');
    expect(resolveRequestId('x'.repeat(129), () => 'generated')).toBe('generated');
  });

  it('generates RFC 4122 UUIDs by default', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('requestId middleware', () => {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use(requestId());
  app.get('/ok', (c) => c.text(c.get('requestId')));
  app.get('/boom', () => {
    throw new Error('boom');
  });

  it('exposes the id to handlers and stamps it on the response', async () => {
    const res = await app.request('/ok', { headers: { [REQUEST_ID_HEADER]: 'abc-1' } });
    expect(await res.text()).toBe('abc-1');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('abc-1');
  });

  it('stamps error responses too', async () => {
    const res = await app.request('/boom', { headers: { [REQUEST_ID_HEADER]: 'abc-2' } });
    expect(res.status).toBe(500);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('abc-2');
  });
});
