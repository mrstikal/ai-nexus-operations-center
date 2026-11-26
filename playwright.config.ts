import { defineConfig, devices } from '@playwright/test';

const fallbackPort = 30000 + Math.floor(Math.random() * 20000);
const port = Number(process.env['NEXUS_E2E_PORT'] ?? String(fallbackPort));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid E2E port: ${process.env['NEXUS_E2E_PORT'] ?? String(port)}`);
}

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @nexus/web build && pnpm --filter @nexus/web start',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 180000,
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: String(port),
    },
  },
});
