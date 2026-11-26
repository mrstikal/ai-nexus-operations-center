import { redirect } from 'next/navigation';
import { AppShell, Feedback, StatusBadge, type ShellNavItem } from '@nexus/ui';
import { readSessionState } from '../src/lib/session';
import { SignOutButton } from './sign-out-button';

export const dynamic = 'force-dynamic';

const NAVIGATION: readonly ShellNavItem[] = [
  { key: 'overview', label: 'Overview', href: '/' },
];

function formatUtcTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)} UTC`;
}

function formatUtcDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(date);
}

function UnavailableShell({ message }: { readonly message: string }) {
  return (
    <main className="nexus-standalone" data-testid="unavailable-state">
      <div className="nexus-standalone__brand">
        <span className="nexus-brand__mark" aria-hidden="true">
          N
        </span>
        <span className="nexus-brand__text">
          <strong>NEXUS</strong>
          <span>Operations Center</span>
        </span>
      </div>
      <StatusBadge tone="info">Replay</StatusBadge>
      <Feedback
        variant="error"
        title="The authenticated shell is unavailable"
        action={
          <a className="nexus-button nexus-button--primary" href="/">
            Try again
          </a>
        }
      >
        {message}
      </Feedback>
    </main>
  );
}

export default async function HomePage() {
  const state = await readSessionState();

  if (state.kind === 'anonymous') {
    redirect('/login');
  }

  if (state.kind === 'unavailable') {
    return <UnavailableShell message={state.message} />;
  }

  const account = {
    displayName: state.user.displayName,
    username: state.user.username,
    roles: state.user.roles,
    expiresAt: state.expiresAt,
  };

  if (state.kind === 'forbidden') {
    return (
      <AppShell
        navigation={NAVIGATION}
        activeKey="overview"
        account={account}
        sandbox={null}
        footer={<SignOutButton />}
      >
        <div className="nexus-page-heading">
          <div>
            <p className="nexus-eyebrow">Operations overview</p>
            <h1>Access denied</h1>
            <p className="nexus-lede">
              This signed-in account cannot inspect the active sandbox.
            </p>
          </div>
          <StatusBadge tone="danger">Forbidden</StatusBadge>
        </div>
        <Feedback variant="error" title="Viewer role required" testId="access-denied">
          {state.message} No sandbox, case, or evidence data is exposed to this account.
        </Feedback>
      </AppShell>
    );
  }

  if (state.kind === 'read-only') {
    return (
      <AppShell
        navigation={NAVIGATION}
        activeKey="overview"
        account={account}
        sandbox={null}
        footer={<SignOutButton />}
      >
        <div className="nexus-page-heading">
          <div>
            <p className="nexus-eyebrow">Operations overview</p>
            <h1>Read-only mode</h1>
            <p className="nexus-lede">
              The session is valid, but the sandbox context could not be loaded.
            </p>
          </div>
          <StatusBadge tone="review">Read-only</StatusBadge>
        </div>
        <Feedback variant="read-only" title="Sandbox context unavailable" testId="shell-readonly-state">
          {state.message}
        </Feedback>
      </AppShell>
    );
  }

  return (
    <AppShell
      navigation={NAVIGATION}
      activeKey="overview"
      account={account}
      sandbox={state.sandbox}
      footer={<SignOutButton />}
    >
      <div className="nexus-page-heading">
        <div>
          <p className="nexus-eyebrow">Operations overview</p>
          <h1>Welcome, {state.user.displayName}</h1>
          <p className="nexus-lede">
            The authenticated shell is ready. It shows only the session and the
            server-resolved sandbox in this phase.
          </p>
        </div>
        <StatusBadge tone="success">Session active</StatusBadge>
      </div>

      <div className="nexus-card-grid">
        <section className="nexus-card" aria-labelledby="session-card-heading">
          <div className="nexus-card__header">
            <h2 id="session-card-heading">Session</h2>
            <StatusBadge tone="success">Authenticated</StatusBadge>
          </div>
          <dl className="nexus-detail-list">
            <div>
              <dt>Account</dt>
              <dd>{state.user.displayName}</dd>
            </div>
            <div>
              <dt>Username</dt>
              <dd>{state.user.username}</dd>
            </div>
            <div>
              <dt>Roles</dt>
              <dd>
                <ul className="nexus-roles nexus-roles--inline" aria-label="Session roles">
                  {state.user.roles.length === 0 ? (
                    <li className="nexus-roles__empty">No roles assigned</li>
                  ) : (
                    state.user.roles.map((role) => <li key={role}>{role}</li>)
                  )}
                </ul>
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatUtcTimestamp(state.expiresAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="nexus-card" aria-labelledby="sandbox-card-heading">
          <div className="nexus-card__header">
            <h2 id="sandbox-card-heading">Active sandbox</h2>
            <StatusBadge
              tone={state.sandbox.status === 'active' ? 'success' : 'neutral'}
            >
              {state.sandbox.status}
            </StatusBadge>
          </div>
          <dl className="nexus-detail-list">
            <div>
              <dt>Sandbox</dt>
              <dd data-testid="sandbox-detail-name">{state.sandbox.name}</dd>
            </div>
            <div>
              <dt>Business date</dt>
              <dd>
                <time dateTime={state.sandbox.businessEffectiveAt}>
                  {formatUtcDate(state.sandbox.businessEffectiveAt)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>Replay only</dd>
            </div>
          </dl>
        </section>
      </div>

      <Feedback
        variant="empty"
        title="No cases in this sandbox yet"
        testId="empty-state"
        action={<span className="nexus-feedback__hint">Case workbench is scheduled for F20.</span>}
      >
        This phase exposes the authenticated session and server-resolved sandbox only. No
        case list, approval center, or assistant screen is claimed complete.
      </Feedback>
    </AppShell>
  );
}
