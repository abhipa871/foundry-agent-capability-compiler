import { test, expect } from '@playwright/test';
import { captureTravel, travelInputs, travelRegistry } from '../src/examples/travel-day.js';

test('compile, verify, shadow, approve, deploy, run and revoke a general task', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Developer console', exact: true }).click();
  const console = page.getByRole('region', { name: 'General task console' });
  await console.getByLabel('Registered task').selectOption('travel_day');
  await console.getByRole('button', { name: 'Load fixture evidence' }).click();
  await expect(console.getByText('2 trajectories selected', { exact: true })).toBeVisible();
  await console.getByLabel('Capability name').fill('ui_travel_context');
  await console.getByRole('button', { name: 'Compile candidate' }).click();
  await expect(
    console.getByRole('button', { name: 'Approve version', exact: true }),
  ).toBeDisabled();
  await expect(console.getByRole('button', { name: 'Deploy version', exact: true })).toBeDisabled();
  await expect(console.getByText('13 operations', { exact: false })).toBeVisible();
  await console
    .getByText('Inspect compiled plan, bindings and pinned contracts', { exact: true })
    .click();
  await expect(console.getByRole('cell', { name: 'load_profile', exact: true })).toBeVisible();
  await console.getByRole('button', { name: 'Verify candidate' }).click();
  await expect(console.locator('.task-checks .pass')).toHaveCount(22);
  await expect(console.locator('.task-checks .fail')).toHaveCount(0);
  await expect(console.getByRole('button', { name: 'Deploy version', exact: true })).toBeDisabled();
  await console.getByRole('button', { name: 'Compare example inputs' }).click();
  await expect(
    console.getByText('3 / 3 distinct shadow inputs matched', { exact: true }),
  ).toBeVisible();
  await console
    .getByLabel('I reviewed this exact digest, verification results, and required scopes.')
    .check();
  await console.getByRole('button', { name: 'Approve version', exact: true }).click();
  await expect(console.getByRole('button', { name: 'Deploy version', exact: true })).toBeEnabled();
  await console.getByRole('button', { name: 'Deploy version', exact: true }).click();
  await expect(console.getByRole('heading', { name: 'Execute the deployed tool' })).toBeVisible();
  await console.getByRole('button', { name: 'Run deployed tool' }).click();
  await expect(console.getByLabel('Execution JSON')).toContainText('"outcome": "success"');
  await expect(console.getByLabel('Execution JSON')).toContainText('"toolCalls": 13');
  await expect(console.getByLabel('Execution JSON')).toContainText('"llmInvocations": 0');
  await console.getByLabel('Example input').selectOption('2');
  await expect(console.getByLabel('tripId')).toHaveValue('trip-c');
  await console.getByRole('button', { name: 'Run deployed tool' }).click();
  await expect(console.getByLabel('Execution JSON')).toContainText('"userId": "carol"');
  await page.screenshot({
    path: 'test-results/general-task-run.png',
    fullPage: true,
    animations: 'disabled',
  });
  await console.getByLabel('userId').fill('unauthorized-user');
  await console.getByRole('button', { name: 'Run deployed tool' }).click();
  await expect(console.getByLabel('Execution JSON')).toContainText('"outcome": "denied"');
  await console.getByLabel('Edit full input JSON').check();
  await console.getByLabel('Task input JSON', { exact: true }).fill('{invalid');
  await console.getByRole('button', { name: 'Run deployed tool' }).click();
  await expect(console.getByRole('alert')).toBeVisible();
  await expect(console.getByLabel('Execution JSON')).toHaveCount(0);
  await console
    .getByLabel('Task input JSON', { exact: true })
    .fill(JSON.stringify(travelInputs[0]));
  await console.getByLabel('Edit full input JSON').uncheck();
  page.once('dialog', (dialog) => void dialog.accept());
  await console.getByRole('button', { name: 'Revoke version' }).click();
  await expect(console.getByRole('button', { name: 'Run deployed tool' })).toBeDisabled();
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click();
  await expect(console.getByRole('heading', { name: 'Registered capabilities' })).toBeVisible();
  const row = console.getByRole('row').filter({ hasText: 'ui_travel_context' });
  await expect(row).toContainText('revoked');
  await expect(row).toContainText('Inactive');
  await row.getByRole('button', { name: 'Inspect version' }).click();
  await expect(console.getByRole('button', { name: 'Verify candidate' })).toBeDisabled();
  await console.getByLabel('Registered task').selectOption('personal_departure');
  await console
    .getByRole('navigation', { name: 'General task stages' })
    .getByRole('button', { name: /Run/ })
    .click();
  await expect(console.getByLabel('userId')).toBeVisible();
  await expect(console.getByLabel('now')).toBeVisible();
  await expect(console.getByLabel('tripId')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('imports SDK evidence and remains usable on mobile', async ({ page }) => {
  const traces = await Promise.all(
    travelInputs.slice(0, 2).map((input) => captureTravel(travelRegistry(), input)),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Developer console', exact: true }).click();
  const console = page.getByRole('region', { name: 'General task console' });
  await console.getByLabel('Registered task').selectOption('travel_day');
  await console.getByLabel('Trace JSON', { exact: true }).fill('{broken');
  await console.getByRole('button', { name: 'Import traces', exact: true }).click();
  await expect(console.getByRole('alert')).toBeVisible();
  await console.getByLabel('Trace JSON', { exact: true }).fill(JSON.stringify(traces));
  await console.getByRole('button', { name: 'Import traces', exact: true }).click();
  await expect(console.getByText('2 trajectories selected', { exact: true })).toBeVisible();
  await console.getByLabel('Capability name').fill('ui_sdk_import');
  await console.getByRole('button', { name: 'Compile candidate' }).click();
  await expect(console.getByRole('button', { name: 'Verify candidate' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: 'test-results/general-task-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});
