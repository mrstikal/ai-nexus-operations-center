import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from './status-badge';

export interface ShellNavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

export interface ShellAccount {
  readonly displayName: string;
  readonly username: string;
  readonly roles: readonly string[];
  readonly expiresAt?: string;
}

export interface ShellSandbox {
  readonly name: string;
  readonly status: string;
  readonly businessEffectiveAt: string;
}

export interface AppShellProps {
  readonly navigation: readonly ShellNavItem[];
  readonly activeKey: string;
  readonly account: ShellAccount;
  readonly sandbox: ShellSandbox | null;
  readonly modeLabel?: string;
  readonly modeDescription?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

function formatUtcDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const formatted = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `${formatted} UTC`;
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

function sandboxTone(status: string): StatusTone {
  if (status === 'active') {
    return 'success';
  }
  if (status === 'retired') {
    return 'neutral';
  }
  return 'review';
}

export function AppShell({
  navigation,
  activeKey,
  account,
  sandbox,
  modeLabel = 'Replay',
  modeDescription = 'No live model calls',
  children,
  footer,
}: AppShellProps) {
  return (
    <div className="nexus-shell">
      <a className="nexus-skip-link" href="#nexus-main">
        Skip to content
      </a>
      <aside className="nexus-rail" data-testid="shell-rail" aria-label="Workspace">
        <div className="nexus-brand">
          <span className="nexus-brand__mark" aria-hidden="true">
            N
          </span>
          <span className="nexus-brand__text">
            <strong>NEXUS</strong>
            <span>Operations Center</span>
          </span>
        </div>

        <div className="nexus-mode" data-testid="mode-badge">
          <StatusBadge tone="info">{modeLabel}</StatusBadge>
          <span className="nexus-mode__detail">{modeDescription}</span>
        </div>

        <nav className="nexus-nav" aria-label="Primary">
          <p className="nexus-rail-label">Workspace</p>
          <ul className="nexus-nav__list">
            {navigation.map((item) => {
              const current = item.key === activeKey;
              return (
                <li key={item.key}>
                  <a
                    className="nexus-nav__link"
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                  >
                    <span className="nexus-nav__marker" aria-hidden="true" />
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="nexus-rail__spacer" />

        <section className="nexus-account" aria-label="Signed-in account">
          <p className="nexus-rail-label">Account</p>
          <p className="nexus-account__name" data-testid="account-name">
            {account.displayName}
          </p>
          <p className="nexus-account__username">{account.username}</p>
          <ul className="nexus-roles" data-testid="role-list" aria-label="Roles">
            {account.roles.length === 0 ? (
              <li className="nexus-roles__empty">No roles assigned</li>
            ) : (
              account.roles.map((role) => <li key={role}>{role}</li>)
            )}
          </ul>
          {account.expiresAt ? (
            <p className="nexus-account__expiry">
              Session ends {formatUtcDateTime(account.expiresAt)}
            </p>
          ) : null}
        </section>

        <section className="nexus-sandbox" aria-label="Active sandbox">
          <p className="nexus-rail-label">Sandbox</p>
          {sandbox ? (
            <>
              <p className="nexus-sandbox__name" data-testid="sandbox-name">
                {sandbox.name}
              </p>
              <div className="nexus-sandbox__meta">
                <StatusBadge tone={sandboxTone(sandbox.status)}>
                  {sandbox.status}
                </StatusBadge>
              </div>
              <p className="nexus-sandbox__date">
                Business date{' '}
                <time dateTime={sandbox.businessEffectiveAt} data-testid="sandbox-business-date">
                  {formatUtcDate(sandbox.businessEffectiveAt)}
                </time>
              </p>
            </>
          ) : (
            <p className="nexus-sandbox__missing">No sandbox context is available.</p>
          )}
        </section>

        {footer ? <div className="nexus-rail__footer">{footer}</div> : null}
      </aside>

      <main className="nexus-main" id="nexus-main" data-testid="shell-main" tabIndex={-1}>
        <header className="nexus-topbar">
          <span className="nexus-topbar__company">Northstar Commerce</span>
          <span className="nexus-topbar__divider" aria-hidden="true">
            /
          </span>
          <span className="nexus-topbar__context">Simulated operations</span>
          <StatusBadge tone="info">{modeLabel} mode</StatusBadge>
        </header>
        <div className="nexus-content">{children}</div>
      </main>
    </div>
  );
}
