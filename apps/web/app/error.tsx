'use client';

import { Feedback } from '@nexus/ui';

export default function ShellError({ reset }: { readonly reset: () => void }) {
  return (
    <main className="nexus-standalone" data-testid="error-state">
      <Feedback
        variant="error"
        title="The shell could not load"
        action={
          <button className="nexus-button nexus-button--primary" onClick={reset} type="button">
            Try again
          </button>
        }
      >
        No account or sandbox data is shown after a shell error. The server log holds the
        redacted diagnostic context.
      </Feedback>
    </main>
  );
}
