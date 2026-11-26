import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Role } from '@nexus/contracts';
import { LoginRequestSchema } from '@nexus/contracts';
import type { LoginRateLimiter } from '@nexus/integrations/rate-limits';
import {
  RateLimitedError,
  RateLimitUnavailableError,
} from '@nexus/integrations/rate-limits';
import {
  authenticateUser,
  consumePreauthChallenge,
  createPreauthChallenge,
  createSession,
  findSessionByToken,
  revokeSession,
  rotateSessionCsrf,
  SESSION_COOKIE_NAME,
  SESSION_TTL_HOURS,
  type AuthenticatedSession,
  type IdentityStore,
} from '@nexus/application/identity/sessions';
import { ProblemException } from '../errors.js';
import {
  SessionAuthGuard,
  SessionCsrfGuard,
  assertAllowedOrigin,
  assertSessionCsrfRefreshAllowed,
  cookieIsSecure,
  headerValue,
  requestIp,
  sessionTokenFromRequest,
  type RequestLike,
} from './guards.js';
import { LOGIN_RATE_LIMITER, NEXUS_DB } from './tokens.js';

interface CookieResponse {
  setHeader(name: string, value: string): void;
}

function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_HOURS * 60 * 60}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

function clearedCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function requireStore(store: IdentityStore | null): IdentityStore {
  if (!store) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Identity storage is not configured',
    );
  }
  return store;
}

function csrfTokenFromRequest(request: RequestLike): string {
  const token = headerValue(request, 'x-csrf-token');
  if (!token) {
    throw new ProblemException('FORBIDDEN', 'CSRF token is required');
  }
  return token;
}

function authResponse(session: AuthenticatedSession): {
  user: { id: string; username: string; displayName: string; roles: Role[] };
  expiresAt: string;
} {
  return {
    user: {
      id: session.userId,
      username: session.username,
      displayName: session.displayName,
      roles: session.roles,
    },
    expiresAt: session.expiresAt.toISOString(),
  };
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(NEXUS_DB) private readonly store: IdentityStore | null,
    @Inject(LOGIN_RATE_LIMITER) private readonly limiter: LoginRateLimiter,
  ) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  async csrf(@Req() request: RequestLike): Promise<{
    csrfToken: string;
    expiresAt: string;
  }> {
    const store = requireStore(this.store);
    const token = sessionTokenFromRequest(request);
    try {
      if (token) {
        const session = await findSessionByToken(store, token);
        if (session) {
          assertSessionCsrfRefreshAllowed(request);
          return {
            csrfToken: await rotateSessionCsrf(store, session.sessionId),
            expiresAt: session.expiresAt.toISOString(),
          };
        }
      }
      const challenge = await createPreauthChallenge(store);
      return {
        csrfToken: challenge.token,
        expiresAt: challenge.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof ProblemException) {
        throw error;
      }
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Identity storage is unavailable',
      );
    }
  }

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<{
    user: { id: string; username: string; displayName: string; roles: Role[] };
    expiresAt: string;
    csrfToken: string;
  }> {
    assertAllowedOrigin(request);
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException('VALIDATION_FAILED', 'Invalid login request', {
        issues: parsed.error.issues,
      });
    }
    const store = requireStore(this.store);
    const csrfToken = csrfTokenFromRequest(request);
    const attempt = {
      ip: requestIp(request),
      username: parsed.data.username,
    };

    try {
      await this.limiter.admit(attempt);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        throw new ProblemException('RATE_LIMITED', 'Too many login attempts', {
          retryAfterMs: error.retryAfterMs,
        });
      }
      if (error instanceof RateLimitUnavailableError) {
        throw new ProblemException(
          'DEPENDENCY_UNAVAILABLE',
          'Login admission is unavailable',
        );
      }
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Login admission is unavailable',
      );
    }

    try {
      const challengeConsumed = await consumePreauthChallenge(store, csrfToken);
      if (!challengeConsumed) {
        await this.limiter.releaseChallenge(attempt);
        throw new ProblemException('FORBIDDEN', 'CSRF challenge is missing, used or expired');
      }
      const user = await authenticateUser(
        store,
        parsed.data.username,
        parsed.data.password,
      );
      if (!user) {
        try {
          await this.limiter.recordFailure(attempt);
        } catch {
          throw new ProblemException(
            'DEPENDENCY_UNAVAILABLE',
            'Login admission is unavailable',
          );
        }
        throw new ProblemException('UNAUTHENTICATED', 'Invalid username or password');
      }
      await this.limiter.recordSuccess(attempt);
      const session = await createSession(store, user.userId);
      response.setHeader(
        'Set-Cookie',
        sessionCookie(session.token, session.expiresAt, cookieIsSecure()),
      );
      return {
        user: {
          id: user.userId,
          username: user.username,
          displayName: user.displayName,
          roles: user.roles,
        },
        expiresAt: session.expiresAt.toISOString(),
        csrfToken: session.csrfToken,
      };
    } catch (error) {
      if (error instanceof ProblemException) {
        throw error;
      }
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Identity storage is unavailable',
      );
    }
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard)
  me(@Req() request: RequestLike): {
    user: { id: string; username: string; displayName: string; roles: Role[] };
    expiresAt: string;
  } {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    return authResponse(request.auth);
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, SessionCsrfGuard)
  async logout(
    @Req() request: RequestLike,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<{ loggedOut: true }> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const store = requireStore(this.store);
    try {
      await revokeSession(store, request.auth.sessionId);
    } catch {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Identity storage is unavailable',
      );
    }
    response.setHeader('Set-Cookie', clearedCookie());
    return { loggedOut: true };
  }
}
