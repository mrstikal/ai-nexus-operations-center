import { defineConfig, devices } from '@playwright/test';

type WebServer = {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  timeout: number;
  env: Record<string, string>;
};

const fallbackPort = 30000 + Math.floor(Math.random() * 20000);
const port = Number(process.env['NEXUS_E2E_PORT'] ?? String(fallbackPort));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid E2E port: ${process.env['NEXUS_E2E_PORT'] ?? String(port)}`);
}

const configuredApiPort = process.env['NEXUS_E2E_API_PORT'];
const apiPort = configuredApiPort ? Number(configuredApiPort) : null;

if (apiPort !== null && (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)) {
  throw new Error(`Invalid E2E API port: ${configuredApiPort ?? ''}`);
}

const webOrigin = `http://127.0.0.1:${port}`;
const apiOrigin = apiPort === null ? null : `http://127.0.0.1:${apiPort}`;

const webServers: WebServer[] = [];

if (apiPort !== null && apiOrigin !== null) {
  webServers.push({
    command: 'pnpm --filter @nexus/api start',
    url: `${apiOrigin}/health`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: String(apiPort),
    },
  });
}

webServers.push({
  command: 'pnpm --filter @nexus/web start',
  url: webOrigin,
  reuseExistingServer: false,
  timeout: 120000,
  env: {
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port),
    ...(apiOrigin === null ? {} : { NEXUS_API_ORIGIN: apiOrigin }),
    ...(apiPort === null ? {} : { NEXUS_ALLOWED_ORIGINS: webOrigin }),
  },
});

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 90000,
  expect: {
    timeout: 15000,
  },
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: webServers,
});
