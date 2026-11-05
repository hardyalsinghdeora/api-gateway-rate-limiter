/**
 * Error bodies the gateway produces itself follow RFC 9457 (Problem Details), so clients
 * can tell a gateway-generated error from an upstream payload by the media type alone.
 */
export interface Problem {
  status: number;
  title: string;
  detail?: string | undefined;
  /** The request path, which RFC 9457 calls the problem "instance". */
  instance: string;
  requestId: string;
  headers?: Record<string, string> | undefined;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function problemResponse(p: Problem): Response {
  const body = {
    type: 'about:blank',
    title: p.title,
    status: p.status,
    ...(p.detail !== undefined && { detail: p.detail }),
    instance: p.instance,
    requestId: p.requestId,
  };
  const headers = new Headers(p.headers);
  headers.set('content-type', PROBLEM_CONTENT_TYPE);
  return new Response(JSON.stringify(body), { status: p.status, headers });
}
