'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Feedback } from '@nexus/ui';
import { fallbackMessage, readProblem } from '../../src/lib/browser';
import { dependencyAvailabilityCopy } from '../../src/lib/session-messages';

interface LoginError {
  readonly kind: 'error' | 'read-only';
  readonly message: string;
}

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const csrfResponse = await fetch('/api/v1/auth/csrf', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!csrfResponse.ok) {
        const problem = await readProblem(csrfResponse);
        if (csrfResponse.status === 503) {
          const copy = dependencyAvailabilityCopy('sign-in', problem.message);
          setError({ kind: copy.variant, message: copy.message });
          return;
        }
        setError({
          kind: 'error',
          message: problem.message ?? fallbackMessage(csrfResponse.status),
        });
        return;
      }
      const csrfPayload: unknown = await csrfResponse.json();
      const csrfToken =
        csrfPayload && typeof csrfPayload === 'object'
          ? (csrfPayload as Record<string, unknown>)['csrfToken']
          : undefined;
      if (typeof csrfToken !== 'string' || csrfToken.length < 16) {
        setError({ kind: 'error', message: 'The security challenge was invalid. Reload and retry.' });
        return;
      }

      const loginResponse = await fetch('/api/v1/auth/login', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ username, password }),
      });
      if (!loginResponse.ok) {
        const problem = await readProblem(loginResponse);
        if (loginResponse.status === 503) {
          const copy = dependencyAvailabilityCopy('sign-in', problem.message);
          setError({ kind: copy.variant, message: copy.message });
        } else if (loginResponse.status === 429 && problem.retryAfterMs !== undefined) {
          setError({
            kind: 'error',
            message: `Too many attempts. Try again in ${Math.max(
              1,
              Math.ceil(problem.retryAfterMs / 1000),
            )} seconds.`,
          });
        } else {
          setError({
            kind: 'error',
            message:
              loginResponse.status === 401
                ? 'Invalid username or password.'
                : loginResponse.status === 403
                  ? fallbackMessage(403)
                  : problem.message ?? fallbackMessage(loginResponse.status),
          });
        }
        setPassword('');
        return;
      }

      router.replace('/');
      router.refresh();
    } catch {
      setError({
        kind: 'error',
        message: 'The sign-in request could not reach the server. Try again.',
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="nexus-login-form"
      data-testid="login-form"
      aria-busy={pending}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label className="nexus-field">
        <span className="nexus-field__label">Username</span>
        <input
          autoComplete="username"
          autoFocus
          className="nexus-field__input"
          name="username"
          onChange={(event) => setUsername(event.target.value)}
          required
          value={username}
        />
      </label>

      <label className="nexus-field">
        <span className="nexus-field__label">Password</span>
        <input
          autoComplete="current-password"
          className="nexus-field__input"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </label>

      {error ? (
        <Feedback
          variant={error.kind === 'read-only' ? 'read-only' : 'error'}
          title={error.kind === 'read-only' ? 'Read-only' : 'Sign-in failed'}
          testId={error.kind === 'read-only' ? 'login-readonly' : 'login-error'}
        >
          {error.message}
        </Feedback>
      ) : null}

      <button className="nexus-button nexus-button--primary" disabled={pending} type="submit">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
