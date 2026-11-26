export default function HomePage() {
  return (
    <main className="shell" data-testid="f01-shell">
      <p className="eyebrow">NEXUS</p>
      <h1>NEXUS Operations Center</h1>
      <p className="lede">
        Replay-first operations workbench. F01 provides the workspace, build, and verification
        harness; business features start in later phases.
      </p>
      <p className="badge" data-testid="replay-badge">
        Replay mode - no live model calls
      </p>
    </main>
  );
}
