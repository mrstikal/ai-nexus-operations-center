import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const workerEntry = path.join(root, 'apps/worker/dist/main.js');

interface ExitState {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface SpawnedApp {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
  waitForExit: (timeoutMs?: number) => Promise<ExitState>;
}

function spawnApp(entry: string, environment: Record<string, string>): SpawnedApp {
  if (!existsSync(entry)) {
    throw new Error(`Missing compiled entry ${entry}; run "pnpm build" before integration tests`);
  }

  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let exitState: ExitState | null = null;
  let resolveExit: ((state: ExitState) => void) | null = null;
  const exitPromise = new Promise<ExitState>((resolve) => {
    resolveExit = resolve;
  });
  const outputListeners = new Set<() => void>();

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    for (const listener of outputListeners) {
      listener();
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('exit', (code, signal) => {
    exitState = { code, signal };
    resolveExit?.(exitState);
    for (const listener of outputListeners) {
      listener();
    }
  });

  const waitForOutput = (pattern: RegExp, timeoutMs = 15000): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const match = pattern.exec(stdout);
        if (match) {
          cleanup();
          resolve(match);
          return;
        }
        if (exitState) {
          cleanup();
          reject(
            new Error(
              `Process exited before matching ${String(pattern)}. stdout: ${stdout} stderr: ${stderr}`,
            ),
          );
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${String(pattern)}. stdout: ${stdout} stderr: ${stderr}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        outputListeners.delete(check);
      };
      outputListeners.add(check);
      check();
    });

  const waitForExit = (timeoutMs = 10000): Promise<ExitState> => {
    if (exitState) {
      return Promise.resolve(exitState);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for process exit. stdout: ${stdout} stderr: ${stderr}`));
      }, timeoutMs);
      void exitPromise.then((state) => {
        clearTimeout(timer);
        resolve(state);
      });
    });
  };

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForOutput,
    waitForExit,
  };
}

async function stopApp(app: SpawnedApp): Promise<ExitState> {
  if (app.child.exitCode === null && app.child.signalCode === null) {
    app.child.kill('SIGTERM');
  }
  return app.waitForExit();
}

describe('F01 compiled Nest bootstrap', () => {
  it('starts the API, serves health with the injected provider, and shuts down cleanly', async () => {
    const app = spawnApp(apiEntry, { PORT: '0' });

    try {
      const ready = await app.waitForOutput(/NEXUS_API_READY port=(\d+)/);
      const portText = ready[1];
      expect(portText).toBeDefined();
      const port = Number(portText);
      expect(Number.isInteger(port) && port > 0).toBe(true);

      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 'ok',
        service: 'api',
        provider: 'f01-injected-provider',
        ready: true,
        injected: true,
      });

      const exit = await stopApp(app);
      expect(exit.code).toBe(0);
      expect(app.stdout()).toContain('NEXUS_API_STOPPED');
    } finally {
      if (app.child.exitCode === null && app.child.signalCode === null) {
        app.child.kill('SIGKILL');
      }
    }
  });

  it('starts the worker with its injected provider and shuts down cleanly', async () => {
    const app = spawnApp(workerEntry, {});

    try {
      await app.waitForOutput(/NEXUS_WORKER_READY provider=f01-worker-provider ready=true/);
      const exit = await stopApp(app);
      expect(exit.code).toBe(0);
      expect(app.stdout()).toContain('NEXUS_WORKER_STOPPED');
    } finally {
      if (app.child.exitCode === null && app.child.signalCode === null) {
        app.child.kill('SIGKILL');
      }
    }
  });
});
