import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestIdVariables {
  requestId: string;
}

// Only echo ids that are safe to log and forward: an attacker-controlled header must not be
// able to inject log lines or oversized values into every hop behind the gateway.
const WELL_FORMED = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(incoming: string | undefined, generate: () => string = randomUUID): string {
  return incoming !== undefined && WELL_FORMED.test(incoming) ? incoming : generate();
}

/** Attaches a request id to the context and stamps it on every response, errors included. */
export function requestId(): MiddlewareHandler<{ Variables: RequestIdVariables }> {
  return async (c, next) => {
    const id = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set('requestId', id);
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, id);
  };
}
