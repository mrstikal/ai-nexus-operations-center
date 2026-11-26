'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Feedback } from '@nexus/ui';
import { fallbackMessage, readProblem } from '../src/lib/browser';
import {
  dependencyAvailabilityCopy,
  signOutSecurityMessage,
} from '../src/lib/session-messages';

const RETRY_DELAY_MS = 100;
const MAX_ATTEMPTS = 3;

type CsrfResult =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'dependency'; readonly message: string | undefined }
  | { readonly kind: 'error'; readonly message: string };

interface SignOutFeedback {
  readonly variant: 'read-only' | 'error';
  readonly title: string;
  readonly message: string;
  readonly testId: string;
}

function dependencyFeedback(message?: string): SignOutFeedback {
  const copy = dependencyAvailabilityCopy('sign-out', message);
  return {
    variant: copy.variant,
    title: copy.variant === 'read-only' ? 'Read-only' : 'Sign-out unavailable',
    message: copy.message,
    testId: copy.variant === 'read-only' ? 'readonly-state' : 'signout-dependency-error',
  };
}

async function fetchCsrfToken(): Promise<CsrfResult> {
  const response = await fetch('/api/v1/auth/csrf', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    return { kind: 'unauthenticated' };
  }
  if (response.status === 503) {
    const problem = await readProblem(response);
    return { kind: 'dependency', message: problem.message };
  }
  if (!response.ok) {
    const problem = await readProblem(response);
    return {
      kind: 'error',
      message: problem.message ?? fallbackMessage(response.status),
    };
  }
  const payload: unknown = await response.json();
  const token =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['csrfToken']
      : undefined;
  if (typeof token !== 'string' || token.length < 16) {
    return { kind: 'error', message: 'The security challenge was invalid. Reload and retry.' };
  }
  return { kind: 'token', token };
}

async function postLogout(token: string): Promise<Response> {
  return fetch('/api/v1/auth/logout', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': token },
  });
}

async function sessionIsActive(): Promise<boolean | null> {
  try {
    const response = await fetch('/api/v1/auth/me', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (response.status === 401) {
      return false;
    }
    if (response.ok) {
      return true;
    }
    return null;
  } catch {
    return null;
  }
}

function waitForRetry(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, RETRY_DELAY_MS);
  });
}

export function SignOutButton() {
  const router = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<SignOutFeedback | null>(null);
  const [error, setError] = useState<string | null>(null);

  function goToLogin(): void {
    router.replace('/login');
    router.refresh();
  }

  async function signOut(): Promise<void> {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFeedback(null);
    setError(null);

    try {
      let logoutResponse: Response | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const challenge = await fetchCsrfToken();
        if (challenge.kind === 'unauthenticated') {
          goToLogin();
          return;
        }
        if (challenge.kind === 'dependency') {
          setFeedback(dependencyFeedback(challenge.message));
          return;
        }
        if (challenge.kind === 'error') {
          setError(challenge.message);
          return;
        }

        logoutResponse = await postLogout(challenge.token);
        if (logoutResponse.status === 401) {
          goToLogin();
          return;
        }
        if (logoutResponse.status === 503) {
          const problem = await readProblem(logoutResponse);
          setFeedback(dependencyFeedback(problem.message));
          return;
        }
        if (logoutResponse.status !== 403) {
          break;
        }

        const active = await sessionIsActive();
        if (active === false) {
          goToLogin();
          return;
        }
        if (attempt < MAX_ATTEMPTS) {
          await waitForRetry();
        }
      }

      if (!logoutResponse) {
        setError('Sign-out could not be completed. Reload and retry.');
        return;
      }
      if (!logoutResponse.ok) {
        const problem = await readProblem(logoutResponse);
        if (logoutResponse.status === 403) {
          await waitForRetry();
          const active = await sessionIsActive();
          if (active === false) {
            goToLogin();
            return;
          }
          setError(signOutSecurityMessage(problem.message));
          return;
        }
        setError(problem.message ?? fallbackMessage(logoutResponse.status));
        return;
      }

      goToLogin();
    } catch {
      setError('Sign-out could not reach the server. Try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="nexus-signout">
      <button
        className="nexus-button nexus-button--quiet"
        disabled={pending}
        onClick={() => {
          void signOut();
        }}
        type="button"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      {feedback ? (
        <Feedback variant={feedback.variant} title={feedback.title} testId={feedback.testId}>
          {feedback.message}
        </Feedback>
      ) : null}
      {error ? (
        <p className="nexus-signout__error" data-testid="signout-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
