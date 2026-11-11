import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  BillingEnvironment,
  BillingApiError,
  assessBilling,
  billingAccess,
  billingCustomer,
  billingDataset,
  billingInstruction,
  billingNow,
  billingVariants,
  parseBillingAnswer,
  type BillingTool,
} from '../../src/benchmarks/billing-fixtures.js';
import {
  BillingWorkspace,
  billingCapabilityName,
  type BillingRun,
} from '../../src/benchmarks/billing-workspace.js';
import { ModelClient, publicGeminiExchange } from '../../src/agent/providers.js';
import { digest, json, type Json } from '../../src/compiler/contracts.js';
import { createApp } from '../../src/app.js';
import { Store } from '../../src/registry/store.js';
import { writeFileSync } from 'node:fs';
import { estimateBillingCost } from '../../src/benchmarks/billing-statistics.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskClient } from '../../src/integration/task-client.js';

// A deterministic test driver, NOT a model or live benchmark. It exercises the exact fixed
// financial state and real HTTP/SDK lifecycle, without claiming inference measurements.
function fixtureProvider(): ModelClient {
  return {
    run: async (options: Parameters<ModelClient['run']>[0]) => {
      expect(options.prompt).toBe(billingInstruction);
      const supplied: Record<string, any> = {};
      let toolCalls = 0;
      const exec = async (name: string, args: Json) => {
        toolCalls++;
        return options.execute(name, args) as Promise<any>;
      };
      if (options.tools.some((tool) => tool.name === billingCapabilityName)) {
        const result = await exec(billingCapabilityName, {});
        if (result.unavailable) Object.assign(supplied, result.available_reads);
        else Object.assign(supplied, result);
      }
      const read = async (name: BillingTool, args: Json) => {
        const key = `${name}_${digest(args).slice(0, 12)}`;
        if (supplied[key]) return supplied[key];
        let result = await exec(name, args);
        if (result.error?.retryable) result = await exec(name, args);
        if (result.error) throw new Error(`Fixture API failure: ${result.error.code}`);
        return result;
      };
      const account = { customer_id: billingCustomer };
      await read('get_customer', account);
      await read('get_account_history', account);
      const subscriptions = await read('list_subscriptions', account);
      for (const sub of subscriptions.data.items)
        await read('get_plan_changes', { subscription_id: sub.id });
      const allPages = async (name: 'list_invoices' | 'list_payments') => {
        const items: any[] = [];
        let cursor: string | null = null;
        do {
          const result = await read(name, { ...account, cursor, limit: 100 });
          items.push(...result.data.items);
          cursor = result.data.pagination.next_cursor;
        } while (cursor);
        return items;
      };
      const invoices = await allPages('list_invoices');
      const payments = await allPages('list_payments');
      for (const invoice of invoices) await read('get_invoice_items', { invoice_id: invoice.id });
      for (const payment of payments) await read('get_payment_details', { payment_id: payment.id });
      const contract = await read('get_contract', account);
      const policy = await read('get_refund_policy', { contract_id: contract.data.id });
      await read('get_tickets', account);
      const refunds: { payment_id: string; amount: number; refund_id: string }[] = [];
      for (const [payment_id, amount, reason] of [
        ['PAY-013', 120, 'duplicate_payment'],
        ['PAY-011', 80, 'charge_after_cancellation'],
      ] as const) {
        const result = await exec('create_refund', {
          payment_id,
          amount,
          reason,
          idempotency_key: `fixture-${payment_id}`,
          authorization_context: policy.data.authorization_context,
        });
        expect(result.error).toBeUndefined();
        await exec('get_refund_status', { refund_id: result.data.id });
        refunds.push({ payment_id, amount, refund_id: result.data.id });
      }
      const audit = await exec('create_audit_entry', {
        entity_id: 'PAY-001',
        action: 'escalated_for_approval',
        evidence: { payment_id: 'PAY-001', reason: 'outside_window' },
        timestamp: billingNow,
      });
      const resolution = {
        customer_id: billingCustomer,
        refunded_total: 200,
        refunds,
        legitimate_payment_ids: payments
          .filter(
            (payment) =>
              payment.status === 'succeeded' &&
              !['PAY-001', 'PAY-011', 'PAY-013'].includes(payment.id),
          )
          .map((payment) => payment.id),
        escalated_payment_ids: ['PAY-001'],
        ticket_id: 'TICKET-1042',
        audit_ids: [audit.data.id],
        items: payments
          .filter((payment) => payment.status === 'succeeded')
          .map((payment) => ({
            payment_id: payment.id,
            invoice_id: payment.invoice_id,
            amount: payment.amount,
            currency: 'USD',
            decision: ['PAY-011', 'PAY-013'].includes(payment.id)
              ? 'refund'
              : payment.id === 'PAY-001'
                ? 'escalate'
                : 'legitimate',
            reason: ['PAY-011', 'PAY-013'].includes(payment.id)
              ? 'Policy-authorized duplicate or cancelled add-on.'
              : payment.id === 'PAY-001'
                ? 'Older dispute requires approval.'
                : 'Authorized service obligation.',
            ...(refunds.some((refund) => refund.payment_id === payment.id)
              ? { refund_id: refunds.find((refund) => refund.payment_id === payment.id)!.refund_id }
              : {}),
          })),
        summary:
          'Two authorized refunds; older dispute escalated. All remaining settled payments are legitimate.',
      };
      await exec('update_ticket', {
        ticket_id: 'TICKET-1042',
        status: 'pending_approval',
        resolution,
      });
      return {
        text: JSON.stringify(resolution),
        usage: {
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          reasoningTokens: null,
        },
        events: [],
        toolCalls,
      };
    },
  } as unknown as ModelClient;
}
const workspaces: BillingWorkspace[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.close();
});

describe('fixed enterprise billing investigation', () => {
  it('accepts a single JSON presentation fence without repairing malformed or incomplete answers', () => {
    const value = {
      customer_id: billingCustomer,
      refunded_total: 0,
      refunds: [],
      legitimate_payment_ids: [],
      escalated_payment_ids: [],
      ticket_id: 'TICKET-1042',
      audit_ids: [],
      items: [],
      summary: 'Structural parser test only; not a correct financial resolution.',
    };
    const text = JSON.stringify(value);
    expect(parseBillingAnswer(text)).toEqual(value);
    expect(parseBillingAnswer('```json\n' + text + '\n```')).toEqual(value);
    expect(() => parseBillingAnswer('```json\n' + text + '\n```\nExtra explanation')).toThrow();
    expect(() => parseBillingAnswer('{"customer_id":"CUST-1042"}')).toThrow();
  });
  it('keeps default budgets and rejects fixture reports when restoring paid training evidence', () => {
    const workspace = new BillingWorkspace();
    expect(workspace.catalog().limits.totalTokenLimit).toBe(5000000);
    expect(() => workspace.restoreObservedTraining([])).toThrow();
    expect(() =>
      workspace.restoreObservedTraining([
        { seed: 1, origin: 'fixture' },
        { seed: 2, origin: 'fixture' },
      ] as unknown as BillingRun[]),
    ).toThrow('observed');
    expect(
      () => new BillingWorkspace({ limits: { totalTokens: 24000001, taskTokens: 250000 } }),
    ).toThrow();
    const expanded = new BillingWorkspace({
      limits: { totalTokens: 24000000, taskTokens: 400000 },
    });
    expect(expanded.catalog().limits.taskTokenLimit).toBe(400000);
    expect(expanded.catalog().limits.totalTokenLimit).toBe(24000000);
  });
  it('retains failed measurements and reserves unknown usage without converting it to measured tokens', () => {
    const workspace = new BillingWorkspace({
      limits: { totalTokens: 20000000, taskTokens: 400000 },
    });
    const usage = {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
    };
    const source = {
      id: 'synthetic-bookkeeping-test',
      origin: 'observed',
      phase: 'measured',
      variant: 'pagination',
      seed: 1,
      arm: 'baseline',
      model: 'gemini-3.8-flash',
      settings: {
        temperature: 0,
        maxOutputTokens: 16384,
        maxModelCalls: 24,
        maxToolCalls: 100,
        maxTotalTokens: 400000,
      },
      events: [{ status: 'failed', latencyMs: 1, usage }],
      usage,
      passed: false,
      failure: 'Synthetic transport failure for bookkeeping test only.',
    } as unknown as BillingRun;
    workspace.restoreMeasuredStudy([source], 1064960);
    expect(workspace.runs[0].passed).toBe(false);
    expect(workspace.runs[0].usage.totalTokens).toBeNull();
    expect(workspace.summary()).toMatchObject({
      totalReportedTokens: 0,
      reservedUnknownTokens: 1064960,
      totalModelCalls: 1,
    });
    expect(() => workspace.restoreMeasuredStudy([source], 1064960)).toThrow();
  });
  it('keeps unknown prices/usage unknown and accounts for cache and reasoning-inclusive output', () => {
    const pricing = {
      model: 'gemini-3.8-flash' as const,
      inputPerMillion: 1,
      outputPerMillion: 2,
      cachedInputPerMillion: 0.1,
      maxInputTokens: 1000,
      source: 'https://example.test/synthetic-test-pricing',
      verifiedAt: '2026-11-07T00:00:00.000Z',
    };
    const event = {
      status: 'success' as const,
      latencyMs: 1,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        totalTokens: 150,
        reasoningTokens: 10,
      },
    };
    expect(estimateBillingCost([event], pricing)).toBeCloseTo(0.000182);
    expect(estimateBillingCost([event], null)).toBeNull();
    expect(
      estimateBillingCost([{ ...event, usage: { ...event.usage, inputTokens: null } }], pricing),
    ).toBeNull();
    expect(estimateBillingCost([event], { ...pricing, maxInputTokens: 50 })).toBeNull();
  });
  it('seeds coherent fixed obligations, three subscriptions, twelve invoices and eighteen payments', () => {
    const data = billingDataset();
    expect(data.subscriptions).toHaveLength(3);
    expect(data.invoices).toHaveLength(12);
    expect(data.payments).toHaveLength(18);
    for (const payment of data.payments) {
      const invoice = data.invoices.find((invoice) => invoice.id === payment.invoice_id)!;
      expect(invoice).toBeDefined();
      expect(payment.obligation_id).toBe(invoice.obligation_id);
      expect(payment.amount).toBe(invoice.amount);
    }
    expect(data.payments.find((p) => p.id === 'PAY-013')?.amount).toBe(120);
    expect(data.payments.find((p) => p.id === 'PAY-011')?.amount).toBe(80);
    expect(data.payments.find((p) => p.id === 'PAY-012')?.amount).toBe(200);
    expect(billingDataset()).toEqual(data);
  });
  it('denies legitimate and old refunds, missing scopes, forged approvals, and idempotency conflicts', async () => {
    const world = new BillingEnvironment();
    const args = {
      payment_id: 'PAY-013',
      amount: 120,
      reason: 'duplicate_payment',
      idempotency_key: 'test-duplicate-key',
      authorization_context: world.data.policy.authorization_context,
    };
    for (const payment_id of ['PAY-001', 'PAY-012'])
      await expect(
        world.call('create_refund', {
          ...args,
          payment_id,
          amount: payment_id === 'PAY-001' ? 60 : 200,
          authorization_context: { ...args.authorization_context, approval_id: 'forged-approval' },
        }),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      world.call('create_refund', args, { ...billingAccess(), scopes: [] }),
    ).rejects.toMatchObject({ status: 403 });
    const first: any = await world.call('create_refund', args);
    const repeated: any = await world.call('create_refund', args);
    expect(first.data.id).toBe(repeated.data.id);
    expect(world.refunds).toHaveLength(1);
    await expect(world.call('create_refund', { ...args, amount: 80 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      world.call('create_refund', { ...args, idempotency_key: 'different-key' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(assessBilling(world, null).passed).toBe(false);
  });
  it('compiles actual observed read regions through the SDK and passes all seven exact stress variants', async () => {
    const Client = process.env.FOUNDRY_BILLING_FIXTURE_REPORT
      ? ((await import(pathToFileURL(resolve('dist-sdk/integration/index.js')).href))
          .TaskClient as typeof TaskClient)
      : undefined;
    const workspace = new BillingWorkspace({
      Client,
      provider: fixtureProvider(),
      skipPreflightForFixtures: true,
    });
    workspaces.push(workspace);
    for (const seed of [9001, 9002]) {
      const run = await workspace.runArm('baseline', 'normal', seed, 'training');
      expect(run.checks).toEqual(
        expect.objectContaining({ exactlyTwoAuthorizedRefunds: true, finalResolution: true }),
      );
      expect(run.passed).toBe(true);
      expect(run.usage.totalTokens).toBeNull();
    }
    const artifact = await workspace.compile();
    expect(artifact.status).toBe('verified');
    expect(artifact.checks.every((check) => check.passed)).toBe(true);
    expect(workspace.compilation.shadowMatches).toBe(3);
    await workspace.deploy();
    expect(workspace.compilation.deploymentStatus).toBe('deployed');
    expect(
      artifact.plan.nodes.every(
        (node) => !['create_refund', 'update_ticket', 'create_audit_entry'].includes(node.tool),
      ),
    ).toBe(true);
    const repeats = process.env.FOUNDRY_BILLING_FIXTURE_REPORT ? 5 : 1;
    for (const variant of billingVariants)
      for (let seed = 0; seed < repeats; seed++)
        for (const arm of ['baseline', 'optimized'] as const) {
          const run = await workspace.runArm(arm, variant, seed);
          expect(run.checks, `${variant} ${arm}`).toEqual(
            expect.objectContaining({ stressExercised: true }),
          );
          expect(
            run.passed,
            `${variant} ${arm}: ${JSON.stringify(run.checks)} ${run.failure}`,
          ).toBe(true);
          expect(run.origin).toBe('fixture');
          expect(run.usage.totalTokens).toBeNull();
          expect(run.estimatedCostUsd).toBeNull();
        }
    expect(workspace.report().complete).toBe(repeats === 5);
    if (process.env.FOUNDRY_BILLING_FIXTURE_REPORT)
      writeFileSync(
        process.env.FOUNDRY_BILLING_FIXTURE_REPORT,
        JSON.stringify(workspace.report(), null, 2) + '\n',
      );
  }, 30000);
  it('does not fabricate a deployment without two correct distinct baseline traces', async () => {
    const workspace = new BillingWorkspace({
      provider: fixtureProvider(),
      skipPreflightForFixtures: true,
    });
    workspaces.push(workspace);
    await expect(workspace.deploy()).rejects.toThrow('verification');
    await expect(workspace.compile()).rejects.toThrow('Two correct baseline');
    expect(workspace.artifact).toBeNull();
  });
  it('does not capture private Gemini thoughts/signatures or credentials in public exchanges', () => {
    expect(
      publicGeminiExchange({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'PRIVATE CHAIN OF THOUGHT' },
                { text: 'Public answer', thoughtSignature: 'opaque-private-signature' },
              ],
            },
          },
        ],
      }),
    ).toEqual({ candidates: [{ content: { parts: [{ text: 'Public answer' }] } }] });
  });
  it('exposes the actual scenario through the existing protected local benchmark API', async () => {
    const store = new Store(':memory:');
    try {
      const { app } = createApp(store, false);
      const response = await request(app).get('/api/benchmarks/billing').expect(200);
      expect(response.body.catalog.model).toBe('gemini-3.8-flash');
      expect(response.body.catalog.tools).toHaveLength(15);
      await request(app)
        .post('/api/benchmarks/billing/baseline')
        .send({ variant: 'normal', seed: 0 })
        .expect(403);
      await request(app)
        .post('/api/benchmarks/billing/baseline')
        .set('X-Foundry-Client', 'local-ui')
        .send({ variant: 'invented', seed: 0 })
        .expect(400);
    } finally {
      store.close();
    }
  });
});
