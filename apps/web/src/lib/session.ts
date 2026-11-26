import {
  AuthMeResponseSchema,
  SandboxSummarySchema,
  type AuthUser,
  type SandboxSummary,
} from '@nexus/contracts';
import { cookies } from 'next/headers';
import { apiOrigin } from './api';
import {
  IDENTITY_UNAVAILABLE_MESSAGE,
  INVALID_IDENTITY_MESSAGE,
  INVALID_SANDBOX_MESSAGE,
  READ_ONLY_MESSAGE,
  SANDBOX_UNREACHABLE_MESSAGE,
  UNAVAILABLE_MESSAGE,
  identityFailureMessage,
  sandboxFailureMessage,
} from './session-messages';

export const SESSION_COOKIE_NAME = 'nexus_session';
const SESSION_TIMEOUT_MS = 5000;

export type ShellSessionState =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | {
      readonly kind: 'forbidden';
      readonly user: AuthUser;
      readonly expiresAt: string;
      readonly message: string;
    }
  | {
      readonly kind: 'read-only';
      readonly user: AuthUser;
      readonly expiresAt: string;
      readonly message: string;
    }
  | {
      readonly kind: 'authenticated';
      readonly user: AuthUser;
      readonly expiresAt: string;
      readonly sandbox: SandboxSummary;
    };

async function sessionCookieHeader(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE_NAME)?.value;
  if (!value) {
    return null;
  }
  return `${SESSION_COOKIE_NAME}=${value}`;
}

async function apiGet(path: string, cookie: string): Promise<Response | null> {
  try {
    return await fetch(`${apiOrigin()}${path}`, {
      cache: 'no-store',
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function readSessionState(): Promise<ShellSessionState> {
  const cookie = await sessionCookieHeader();
  if (!cookie) {
    return { kind: 'anonymous' };
  }

  const meResponse = await apiGet('/api/v1/auth/me', cookie);
  if (!meResponse) {
    return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
  }
  if (meResponse.status === 401) {
    return { kind: 'anonymous' };
  }
  if (meResponse.status === 503) {
    return { kind: 'unavailable', message: IDENTITY_UNAVAILABLE_MESSAGE };
  }
  if (!meResponse.ok) {
    return { kind: 'unavailable', message: identityFailureMessage(meResponse.status) };
  }

  const parsedMe = AuthMeResponseSchema.safeParse(await jsonBody(meResponse));
  if (!parsedMe.success) {
    return { kind: 'unavailable', message: INVALID_IDENTITY_MESSAGE };
  }
  const { user, expiresAt } = parsedMe.data;

  const sandboxResponse = await apiGet('/api/v1/sandbox', cookie);
  if (!sandboxResponse) {
    return { kind: 'read-only', user, expiresAt, message: SANDBOX_UNREACHABLE_MESSAGE };
  }
  if (sandboxResponse.status === 401) {
    return { kind: 'anonymous' };
  }
  if (sandboxResponse.status === 403) {
    return {
      kind: 'forbidden',
      user,
      expiresAt,
      message:
        'Your account is authenticated but does not hold the viewer role required for this workspace.',
    };
  }
  if (sandboxResponse.status === 503) {
    return { kind: 'read-only', user, expiresAt, message: READ_ONLY_MESSAGE };
  }
  if (!sandboxResponse.ok) {
    return {
      kind: 'read-only',
      user,
      expiresAt,
      message: sandboxFailureMessage(sandboxResponse.status),
    };
  }

  const parsedSandbox = SandboxSummarySchema.safeParse(await jsonBody(sandboxResponse));
  if (!parsedSandbox.success) {
    return { kind: 'read-only', user, expiresAt, message: INVALID_SANDBOX_MESSAGE };
  }

  return {
    kind: 'authenticated',
    user,
    expiresAt,
    sandbox: parsedSandbox.data,
  };
}
