export const UNAVAILABLE_MESSAGE =
  'The API is unreachable, so the authenticated shell cannot be loaded. No account or sandbox data is shown.';

export const IDENTITY_UNAVAILABLE_MESSAGE =
  'The identity service is unavailable, so the authenticated shell cannot be loaded. No account or sandbox data is shown.';

export const INVALID_IDENTITY_MESSAGE =
  'The identity response was not valid, so the authenticated shell cannot be loaded. No account or sandbox data is shown.';

export const READ_ONLY_MESSAGE =
  'A required dependency is unavailable. Authenticated reads may continue, but mutations fail closed until it recovers.';

export const SANDBOX_UNREACHABLE_MESSAGE =
  'The sandbox read could not reach the API. No sandbox data is shown; mutations remain unavailable.';

export const INVALID_SANDBOX_MESSAGE =
  'The sandbox response was not valid. No sandbox data is shown; mutations remain unavailable.';

export function identityFailureMessage(status: number): string {
  return `The identity read failed with HTTP ${status}. No account or sandbox data is shown.`;
}

export function sandboxFailureMessage(status: number): string {
  return `The sandbox read failed with HTTP ${status}. No sandbox data is shown; mutations remain unavailable.`;
}

export interface DependencyAvailabilityCopy {
  readonly variant: 'read-only' | 'error';
  readonly message: string;
}

export function dependencyAvailabilityCopy(
  operation: 'sign-in' | 'sign-out',
  upstreamMessage?: string,
): DependencyAvailabilityCopy {
  if (upstreamMessage?.includes('admission is unavailable')) {
    return {
      variant: 'read-only',
      message:
        operation === 'sign-out'
          ? 'Read-only: mutation admission is unavailable. Reads continue; retry sign-out when the cache recovers.'
          : 'Read-only: login admission is unavailable. Existing reads may continue; retry sign-in when the cache recovers.',
    };
  }
  if (upstreamMessage?.includes('Identity storage')) {
    return {
      variant: 'error',
      message: `The identity service is unavailable, so ${operation} cannot proceed. Try again when it recovers.`,
    };
  }
  return {
    variant: 'error',
    message: 'A required service is unavailable. Try again shortly.',
  };
}

export function signOutSecurityMessage(upstreamMessage?: string): string {
  if (upstreamMessage?.includes('CSRF token')) {
    return 'Sign-out could not be completed because the session challenge changed. Reload and try again.';
  }
  return upstreamMessage ?? 'Sign-out was rejected by the security check.';
}
