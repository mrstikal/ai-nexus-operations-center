import { redirect } from 'next/navigation';
import { Feedback, StatusBadge } from '@nexus/ui';
import { readSessionState } from '../../src/lib/session';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const state = await readSessionState();
  if (state.kind === 'authenticated' || state.kind === 'read-only' || state.kind === 'forbidden') {
    redirect('/');
  }

  return (
    <main className="nexus-login" data-testid="login-page">
      <section className="nexus-login__intro" aria-labelledby="login-intro-heading">
        <div className="nexus-brand nexus-brand--large">
          <span className="nexus-brand__mark" aria-hidden="true">
            N
          </span>
          <span className="nexus-brand__text">
            <strong>NEXUS</strong>
            <span>Operations Center</span>
          </span>
        </div>
        <StatusBadge tone="info">Replay</StatusBadge>
        <h1 id="login-intro-heading">Simulated operations, real boundaries.</h1>
        <p>
          Investigate supply, reconciliation, and customer cases against a deterministic
          company scenario. This environment runs replay mode only; no live model call is
          made.
        </p>
        <ul className="nexus-login__facts">
          <li>Server-side session and role checks</li>
          <li>Server-resolved sandbox and business date</li>
          <li>Same-origin API proxy with no browser secrets</li>
        </ul>
      </section>

      <section className="nexus-login__panel" aria-labelledby="login-heading">
        <p className="nexus-eyebrow">Local account</p>
        <h2 id="login-heading">Sign in</h2>
        <p className="nexus-login__lede">
          Use an account seeded by <code>pnpm demo:init</code>. Passwords remain server-side.
        </p>

        {state.kind === 'unavailable' ? (
          <Feedback
            variant="read-only"
            title="Service unavailable"
            testId="login-initial-notice"
          >
            {state.message}
          </Feedback>
        ) : null}

        <LoginForm />
        <p className="nexus-login__footnote">
          Replay mode is the only available mode in this phase. Live model access is not
          exposed.
        </p>
      </section>
    </main>
  );
}
