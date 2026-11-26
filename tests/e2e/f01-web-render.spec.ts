import { expect, test } from '@playwright/test';

test('renders the public shell entry without external requests', async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1').origin;

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(request.url());
  });
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return;
    }
    if (new URL(url).origin !== origin) {
      externalRequests.push(url);
    }
  });

  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('login-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByText('Replay', { exact: true })).toBeVisible();
  expect(failedRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
