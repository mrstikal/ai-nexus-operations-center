const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3001';

const REQUEST_HEADER_ALLOWLIST = [
  'accept',
  'accept-language',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'x-csrf-token',
  'x-request-id',
] as const;

const RESPONSE_HEADER_ALLOWLIST = [
  'cache-control',
  'content-disposition',
  'content-language',
  'content-type',
  'retry-after',
  'vary',
  'x-request-id',
] as const;

const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,128}$/;
const MAX_PATH_SEGMENTS = 16;
const MAX_SEARCH_LENGTH = 2048;

export function apiOrigin(): string {
  const configured = process.env['NEXUS_API_ORIGIN'] ?? DEFAULT_API_ORIGIN;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('NEXUS_API_ORIGIN is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('NEXUS_API_ORIGIN must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('NEXUS_API_ORIGIN must not contain credentials, a query or a fragment');
  }
  if (url.pathname !== '/') {
    throw new Error('NEXUS_API_ORIGIN must not contain a path');
  }
  return url.origin;
}

export function proxyTarget(
  segments: readonly string[],
  search: string,
): URL | null {
  if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) {
    return null;
  }
  if (segments[0] !== 'v1') {
    return null;
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)) {
      return null;
    }
  }
  if (search.length > MAX_SEARCH_LENGTH) {
    return null;
  }
  const path = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return new URL(`/api/${path}${search}`, apiOrigin());
}

export function requestHeadersForProxy(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) {
      forwarded.set(name, value);
    }
  }
  return forwarded;
}

function setCookieHeaders(headers: Headers): string[] {
  const withCookies = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = withCookies.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    return cookies;
  }
  const single = headers.get('set-cookie');
  return single === null ? [] : [single];
}

export function responseHeadersForProxy(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) {
      forwarded.set(name, value);
    }
  }
  for (const cookie of setCookieHeaders(headers)) {
    forwarded.append('set-cookie', cookie);
  }
  return forwarded;
}

export function problemResponse(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      code,
      message,
      requestId: crypto.randomUUID(),
    }),
    {
      status,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/problem+json; charset=utf-8',
      },
    },
  );
}
