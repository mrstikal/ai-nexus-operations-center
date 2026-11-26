import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@nexus/contracts';
import {
  findSessionByToken,
  verifySessionCsrf,
  type AuthenticatedSession,
  type IdentityStore,
} from '@nexus/application/identity/sessions';
import { hasAnyRole } from '@nexus/application/identity/permissions';
import type { LoginRateLimiter } from '@nexus/integrations/rate-limits';
import { ProblemException } from '../errors.js';
import { LOGIN_RATE_LIMITER, NEXUS_DB } from './tokens.js';

export const ROLES_KEY = 'nexus:roles';

export function Roles(...roles: Role[]): CustomDecorator<string> {
  return SetMetadata(ROLES_KEY, roles);
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
  auth?: AuthenticatedSession;
}

export function headerValue(
  request: RequestLike,
  name: string,
): string | undefined {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function sessionTokenFromRequest(request: RequestLike): string | null {
  const cookieHeader = headerValue(request, 'cookie');
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === 'nexus_session') {
      const value = part.slice(separator + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

export function requestIp(request: RequestLike): string {
  return request.socket?.remoteAddress ?? request.ip ?? 'unknown';
}

export function allowedOrigins(): string[] {
  return (process.env['NEXUS_ALLOWED_ORIGINS'] ??
    'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function assertAllowedOrigin(request: RequestLike): void {
  const origin = headerValue(request, 'origin');
  if (!origin || !allowedOrigins().includes(origin)) {
    throw new ProblemException('FORBIDDEN', 'Request origin is not allowed');
  }
}

export function cookieIsSecure(): boolean {
  const configured = process.env['NEXUS_COOKIE_SECURE'];
  if (configured === 'false') {
    return false;
  }
  return true;
}

export function assertSessionCsrfRefreshAllowed(request: RequestLike): void {
  const fetchSite = headerValue(request, 'sec-fetch-site');
  const origin = headerValue(request, 'origin');
  if (fetchSite === 'same-origin' || fetchSite === 'none') {
    return;
  }
  if (origin && allowedOrigins().includes(origin)) {
    return;
  }
  throw new ProblemException('FORBIDDEN', 'CSRF refresh origin is not allowed');
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(@Inject(NEXUS_DB) private readonly store: IdentityStore | null) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestLike>();
    if (!this.store) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Identity storage is not configured',
      );
    }
    const token = sessionTokenFromRequest(request);
    if (!token) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    let session: AuthenticatedSession | null;
    try {
      session = await findSessionByToken(this.store, token);
    } catch {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Identity storage is unavailable',
      );
    }
    if (!session) {
      throw new ProblemException('UNAUTHENTICATED', 'Session is invalid or expired');
    }
    request.auth = session;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<RequestLike>();
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    if (!hasAnyRole(request.auth.roles, required)) {
      throw new ProblemException('FORBIDDEN', 'Required role is missing');
    }
    return true;
  }
}

@Injectable()
export class SessionCsrfGuard implements CanActivate {
  constructor(
    @Inject(LOGIN_RATE_LIMITER) private readonly limiter: LoginRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestLike>();
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    assertAllowedOrigin(request);
    try {
      await this.limiter.admitMutation();
    } catch {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Mutation admission is unavailable',
      );
    }
    const token = headerValue(request, 'x-csrf-token');
    if (!token || !verifySessionCsrf(request.auth, token)) {
      throw new ProblemException('FORBIDDEN', 'CSRF token is missing or invalid');
    }
    return true;
  }
}
