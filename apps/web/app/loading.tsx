import { Feedback, StatusBadge } from '@nexus/ui';

export default function LoadingPage() {
  return (
    <main className="nexus-standalone" data-testid="loading-state">
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
      <Feedback variant="loading" title="Loading the authenticated shell">
        Reading the server-side session and sandbox context.
      </Feedback>
    </main>
  );
}
