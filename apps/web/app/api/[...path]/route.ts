import { NextResponse } from 'next/server';
import {
  problemResponse,
  proxyTarget,
  requestHeadersForProxy,
  responseHeadersForProxy,
} from '../../../src/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly path: string[] }>;
}

type ProxyRequestInit = RequestInit & { duplex?: 'half' };

const METHODS_WITHOUT_REQUEST_BODY = new Set(['GET', 'HEAD']);

async function handleProxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const requestUrl = new URL(request.url);

  let target: URL | null;
  try {
    target = proxyTarget(path, requestUrl.search);
  } catch {
    return problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'API proxy is not configured');
  }
  if (!target) {
    return problemResponse(400, 'VALIDATION_FAILED', 'Unsupported API path');
  }

  const init: ProxyRequestInit = {
    method: request.method,
    headers: requestHeadersForProxy(request.headers),
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  };
  if (!METHODS_WITHOUT_REQUEST_BODY.has(request.method) && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }

  try {
    const upstream = await fetch(target, init);
    const suppressBody =
      request.method === 'HEAD' ||
      upstream.status === 204 ||
      upstream.status === 205 ||
      upstream.status === 304;
    return new NextResponse(suppressBody ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeadersForProxy(upstream.headers),
    });
  } catch {
    return problemResponse(
      503,
      'DEPENDENCY_UNAVAILABLE',
      'The API is unavailable; no upstream target was substituted.',
    );
  }
}

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return handleProxy(request, context);
}

export function HEAD(request: Request, context: RouteContext): Promise<Response> {
  return handleProxy(request, context);
}

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return handleProxy(request, context);
}

export function PUT(request: Request, context: RouteContext): Promise<Response> {
  return handleProxy(request, context);
}

export function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return handleProxy(request, context);
}

export function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return handleProxy(request, context);
}
