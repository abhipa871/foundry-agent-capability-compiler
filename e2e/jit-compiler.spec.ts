import { test, expect } from '@playwright/test';

test('compile, verify, approve, dispatch and deoptimize a read capability', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Developer console' }).click();
  await expect(page.getByRole('heading', { name: 'Capability workflow' })).toBeVisible();

  await page.getByRole('button', { name: 'Load sample traces' }).click();
  await page.getByText('Recorded evidence', { exact: false }).click();
  await expect(page.getByRole('cell', { name: 'customer_context' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Compile candidate' }).click();
  await expect(page.getByRole('button', { name: 'Validate', exact: true })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.getByRole('button', { name: 'Approve version', exact: true })).toBeDisabled();
  await page.getByText('Compiled plan & optimizations', { exact: false }).click();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'eliminated 1 duplicate read(s) of crm.getCustomer' }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'parallelized 2 independent reads' }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'legacy_crm.search · failed_event' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Verify candidate' }).click();
  await page.locator('summary').filter({ hasText: 'Validation checks' }).click();
  await expect(page.getByText('Compiled region invokes no model')).toBeVisible();
  await expect(page.locator('.check-row .red-text')).toHaveCount(0);
  expect(await page.locator('.check-row .green-text').count()).toBeGreaterThan(15);
  await page.getByRole('button', { name: 'Approve version' }).click();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveAttribute(
    'aria-current',
    'step',
  );

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByLabel('Customer id').fill('C-101');
  await page.getByRole('button', { name: 'Dispatch task' }).click();
  await expect(page.getByText('LLM calls inside compiled portion: 0')).toBeVisible();
  await expect(page.getByText('mode: compiled')).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: 'test-results/jit-compiled-dispatch.png',
    fullPage: true,
  });

  await page.getByLabel('Customer id').fill('C-404');
  await page.getByRole('button', { name: 'Dispatch task' }).click();
  await expect(page.getByText('mode: agent')).toBeVisible();
  await page.getByText('Execution details & output', { exact: true }).click();
  await expect(page.getByText('"fallbackReason": "unsupported_state"')).toBeVisible();
  await page.getByRole('button', { name: 'Record recovery' }).click();
  await expect(page.getByText('"by": "operator"')).toBeVisible();

  expect(errors).toEqual([]);
});
