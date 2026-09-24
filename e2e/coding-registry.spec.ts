import { test, expect } from '@playwright/test';

test('register, secure, verify, approve, deploy and reload a coding task', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .getByLabel('Task for the coding agent')
    .fill('Check the package manifest for this project.');
  await page.getByRole('button', { name: 'Run and record trajectory' }).click();
  await page.getByRole('button', { name: 'Prepare deployment' }).click();
  await expect(page.getByRole('heading', { name: 'Coding task registry' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploy and measure' })).toBeDisabled();
  await page.getByRole('button', { name: 'Add assertion', exact: true }).click();
  await page.getByLabel('Relative file path').fill('package.json');
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await page.getByRole('button', { name: 'Run security checks' }).click();
  await expect(page.getByLabel('Security check results')).toContainText('PASS');
  await page.getByRole('button', { name: 'Approve verified version' }).click();
  await page.getByRole('button', { name: 'Deploy and measure' }).click();
  await expect(
    page.getByRole('heading', { name: 'Latest deployment: success (simulated)' }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/coding-registry.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Open in registry' }).click();
  await expect(
    page.getByRole('heading', { name: 'Latest deployment: success (simulated)' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Revoke version' }).click();
  await expect(page.getByRole('button', { name: 'Deploy and measure' })).toBeDisabled();
  expect(errors).toEqual([]);
});
