import { test, expect } from '@playwright/test';

test('one persistent sidebar connects benchmarks and developer tools', async ({ page }) => {
  await page.goto('/');
  const sidebar = await page.getByLabel('Workspace sidebar').elementHandle();
  await expect(page.locator('.bw-sidebar')).toHaveCount(1);
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button'),
  ).toHaveCount(5);
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Audit log' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Developer console', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capability workflow' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Capability steps' }).getByRole('button'),
  ).toHaveCount(3);
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/developer-console-overview.png',
    fullPage: true,
  });
  await expect(
    page.getByRole('button', { name: 'Developer console', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  expect(await sidebar!.evaluate((node) => node.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dispatch task', exact: true })).toBeDisabled();
  await page.getByLabel('Customer id').fill('C-202');
  await page.getByRole('button', { name: 'Agent playground', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make every token count.' })).toBeVisible();
  await page.getByRole('button', { name: 'API & SDK', exact: true }).click();
  await page.getByRole('button', { name: 'Open developer console', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capability workflow' })).toBeVisible();
  await expect(page.getByLabel('Customer id')).toHaveValue('C-202');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveAttribute(
    'aria-current',
    'step',
  );
  expect(await sidebar!.evaluate((node) => node.isConnected)).toBe(true);
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/unified-compiler-console.png',
    fullPage: true,
  });
});

test('advanced tools remain discoverable without occupying sidebar entries', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Developer console', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Developer sections' }).getByRole('button'),
  ).toHaveCount(3);
  await page.getByLabel('More developer tools').selectOption('Audit log');
  await expect(page.getByRole('heading', { name: 'Workspace events' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Developer console', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByLabel('More developer tools').selectOption('Capability graph');
  await expect(page.getByRole('heading', { name: 'The capability graph' })).toBeVisible();
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Capabilities', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Execution history' })).toBeVisible();
  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capability workflow' })).toBeVisible();
});

test('a rejected compilation stays in Build and does not expose approval', async ({ page }) => {
  await page.route('**/api/v2/compile', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Compilation rejected for this regression check.' }),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Developer console', exact: true }).click();
  await page.getByRole('button', { name: 'Compile candidate', exact: true }).click();
  await expect(
    page.getByText('Compilation rejected for this regression check.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build', exact: true })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.getByRole('button', { name: 'Approve version', exact: true })).toHaveCount(0);
});

test('compare a task, inspect its trace, export and discover the SDK', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Make every token count.' })).toBeVisible();
  await expect(page.locator('.bw-metric-value').first()).toContainText('5,876');
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/benchmark-playground.png',
    fullPage: true,
  });
  await page.getByLabel('Task contract').selectOption('orders');
  await page
    .getByLabel('Your prompt')
    .fill('Which order is most delayed? Only retrieve my orders.');
  await page.getByRole('button', { name: 'Run comparison' }).click();
  await expect(page.getByRole('heading', { name: 'Execution comparison' })).toBeVisible();
  await expect(page.getByText('Deterministic preview responses', { exact: false })).toBeVisible();
  await expect(page.getByText('Contract checks pass')).toHaveCount(2);
  await page.getByRole('tab', { name: 'Token breakdown' }).click();
  await expect(page.getByRole('cell', { name: 'Not measured' })).toHaveCount(6);
  await page.getByRole('tab', { name: 'Execution trace' }).click();
  await expect(page.getByText('orders.list', { exact: true })).toHaveCount(2);
  await expect(page.getByText('crm.getCustomer', { exact: true })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export run' }).click();
  expect((await download).suggestedFilename()).toMatch(/^foundry-.*\.json$/);
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/benchmark-run.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Developer console', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capability workflow' })).toBeVisible();
  await page.getByRole('button', { name: 'Agent playground', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Execution comparison' })).toBeVisible();
  await expect(page.getByLabel('Your prompt')).toHaveValue(
    'Which order is most delayed? Only retrieve my orders.',
  );
  await page.getByRole('button', { name: 'Run history' }).click();
  await page.getByRole('button', { name: /Which order is most delayed/ }).click();
  await expect(page.getByRole('heading', { name: 'Execution comparison' })).toBeVisible();
  await page.getByRole('button', { name: 'API & SDK' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your agent. Powered by Foundry.' }),
  ).toBeVisible();
  await expect(page.getByLabel('SDK architecture')).toBeVisible();
  await expect(page.locator('pre')).toContainText('FoundryClient');
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/benchmark-integration.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Benchmark results', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Four ways to run the same work' })).toBeVisible();
  await expect(page.getByText('4,452', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile workspace remains usable without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run comparison' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/benchmark-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'API & SDK' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Developer console', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capability workflow' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/unified-compiler-mobile.png',
    fullPage: true,
  });
});
