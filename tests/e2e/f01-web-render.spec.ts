import { expect, test } from '@playwright/test';

test('renders the F01 workbench shell without external requests', async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(request.url());
  });

  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'NEXUS Operations Center', level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId('f01-shell')).toBeVisible();
  await expect(page.getByTestId('replay-badge')).toContainText('Replay mode');
  expect(failedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
