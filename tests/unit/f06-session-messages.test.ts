import { describe, expect, it } from 'vitest';
import {
  IDENTITY_UNAVAILABLE_MESSAGE,
  INVALID_IDENTITY_MESSAGE,
  INVALID_SANDBOX_MESSAGE,
  READ_ONLY_MESSAGE,
  SANDBOX_UNREACHABLE_MESSAGE,
  UNAVAILABLE_MESSAGE,
  dependencyAvailabilityCopy,
  identityFailureMessage,
  sandboxFailureMessage,
  signOutSecurityMessage,
} from '../../apps/web/src/lib/session-messages.js';

describe('shell failure messages', () => {
  it('keeps the identity outage state consistent with its unavailable shell title', () => {
    expect(IDENTITY_UNAVAILABLE_MESSAGE).toContain('identity service is unavailable');
    expect(IDENTITY_UNAVAILABLE_MESSAGE).toContain('No account or sandbox data is shown');
    expect(IDENTITY_UNAVAILABLE_MESSAGE).not.toBe(READ_ONLY_MESSAGE);
    expect(IDENTITY_UNAVAILABLE_MESSAGE).not.toContain('Authenticated reads may continue');
  });

  it('reports the actual identity status for unexpected responses', () => {
    expect(identityFailureMessage(500)).toContain('HTTP 500');
    expect(identityFailureMessage(500)).not.toContain('Authenticated reads may continue');
    expect(INVALID_IDENTITY_MESSAGE).toContain('identity response was not valid');
  });

  it('distinguishes sandbox dependency, transport and status failures', () => {
    expect(READ_ONLY_MESSAGE).toContain('Authenticated reads may continue');
    expect(SANDBOX_UNREACHABLE_MESSAGE).toContain('could not reach the API');
    expect(sandboxFailureMessage(409)).toContain('HTTP 409');
    expect(sandboxFailureMessage(409)).not.toBe(READ_ONLY_MESSAGE);
    expect(INVALID_SANDBOX_MESSAGE).toContain('sandbox response was not valid');
    expect(UNAVAILABLE_MESSAGE).toContain('API is unreachable');
  });

  it('attributes mutation admission and identity storage failures separately', () => {
    const admission = dependencyAvailabilityCopy(
      'sign-out',
      'Mutation admission is unavailable',
    );
    expect(admission.variant).toBe('read-only');
    expect(admission.message).toContain('Read-only');
    expect(admission.message).toContain('retry sign-out');

    const loginAdmission = dependencyAvailabilityCopy(
      'sign-in',
      'Login admission is unavailable',
    );
    expect(loginAdmission.variant).toBe('read-only');
    expect(loginAdmission.message).toContain('login admission is unavailable');
    expect(loginAdmission.message).toContain('retry sign-in');

    const identity = dependencyAvailabilityCopy(
      'sign-in',
      'Identity storage is unavailable',
    );
    expect(identity.variant).toBe('error');
    expect(identity.message).toContain('identity service is unavailable');
    expect(identity.message).not.toContain('Read-only');
    expect(identity.message).not.toContain('reads may continue');

    const unknown = dependencyAvailabilityCopy('sign-in', undefined);
    expect(unknown.variant).toBe('error');
    expect(unknown.message).not.toContain('cache');
  });

  it('keeps the actual non-rotation sign-out rejection reason', () => {
    expect(signOutSecurityMessage('CSRF token is missing or invalid')).toContain(
      'session challenge changed',
    );
    expect(signOutSecurityMessage('Request origin is not allowed')).toBe(
      'Request origin is not allowed',
    );
    expect(signOutSecurityMessage(undefined)).toContain('security check');
  });
});
