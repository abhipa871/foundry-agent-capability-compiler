import { it, expect } from 'vitest';
import {
  developmentCases,
  heldoutCases,
  balancedSchedule,
  experimentArms,
  assessRouting,
  routingFixture,
  allReads,
  type RoutingResponse,
} from '../../scripts/experiments/routing-task.js';
import { pairedRouting } from '../../scripts/experiments/routing-statistics.js';
import { emptyMeasurement } from '../../src/telemetry/measurement.js';
import { contracts, localContext } from '../../src/runtime/adapters/registry.js';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import { interpret } from '../../src/runtime/interpret.js';
import { sameContext } from '../../src/runtime/observable.js';
import { Store } from '../../src/registry/store.js';
import { JitRegistry } from '../../src/registry/jit.js';

it('separates development and final IDs/messages and includes every required scenario', () => {
  expect(developmentCases).toHaveLength(10);
  expect(heldoutCases).toHaveLength(10);
  const training = new Set(developmentCases.map((task) => task.customerId));
  expect(heldoutCases.every((task) => !training.has(task.customerId))).toBe(true);
  expect(
    heldoutCases.every((task) => !developmentCases.some((dev) => dev.message === task.message)),
  ).toBe(true);
  expect(new Set(developmentCases.map((task) => task.category)).size).toBe(10);
  expect(developmentCases.find((task) => task.category === 'none')!.permittedReads).toEqual([]);
  expect(developmentCases.find((task) => task.category === 'partial')!.permittedReads).toEqual([
    'crm.getCustomer',
  ]);
  expect(
    developmentCases.find((task) => task.category === 'model_decides')!.contract.requirement,
  ).toBe('agent_decides');
});
it('balances all arm positions and changes repeat order independently of outcomes', () => {
  const rows = balancedSchedule(heldoutCases, 2, 71109);
  expect(rows).toHaveLength(20);
  expect(rows).toEqual(balancedSchedule(heldoutCases, 2, 71109));
  for (const arm of experimentArms) {
    const counts = experimentArms.map(
      (_, position) => rows.filter((row) => row.order[position] === arm).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  }
  for (const task of heldoutCases) {
    const repeats = rows.filter((row) => row.task.id === task.id);
    expect(repeats[0].order).not.toEqual(repeats[1].order);
    expect(new Set(repeats[0].order).size).toBe(6);
  }
});
it('rejects wrong normal-agent answers and unnecessary reads without making a baseline into the oracle', () => {
  const task = developmentCases.find((task) => task.category === 'partial')!;
  const response: RoutingResponse = {
    ...task.expected,
    reply:
      'Your account is marked eligible in the customer record. The support team can explain eligibility, and no order or refund has been changed.',
  };
  expect(assessRouting(response, task, [{ operation: 'crm.getCustomer' }]).passed).toBe(true);
  expect(
    assessRouting({ ...response, eligible: false }, task, [{ operation: 'crm.getCustomer' }])
      .passed,
  ).toBe(false);
  expect(
    assessRouting(
      response,
      task,
      allReads.map((operation) => ({ operation })),
    ).checks.permittedReads,
  ).toBe(false);
  expect(assessRouting(response, task, []).checks.requiredReadsAttempted).toBe(false);
});
it('requires an unavailable answer rather than guessing missing evidence after a service failure', () => {
  const task = developmentCases.find((task) => task.category === 'permanent_failure')!;
  const response: RoutingResponse = {
    ...task.expected,
    reply:
      'I am unable to verify the complete account context because a required service is unavailable. Please ask the support team to try again; no refund has been issued.',
  };
  expect(
    assessRouting(
      response,
      task,
      allReads.map((operation) => ({ operation })),
    ).passed,
  ).toBe(true);
  expect(
    assessRouting(
      { ...response, refunds: [] },
      task,
      allReads.map((operation) => ({ operation })),
    ).passed,
  ).toBe(false);
});
it('retains handwritten/compiled output-contract equivalence on expanded snapshots', async () => {
  const { ir } = compileIR(sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo')));
  for (const customerId of ['C-404', 'C-505', 'C-606']) {
    const context = { ...localContext(), allowedCustomerIds: [customerId] };
    const adapters = async (operation: (typeof allReads)[number]) =>
      contracts[operation].output.parse(routingFixture(operation, customerId));
    const compiled = await interpret(ir, { customerId }, { context, adapters });
    const handwritten = {
      customer_id: customerId,
      crm_get_customer: await adapters('crm.getCustomer'),
      orders_list: await adapters('orders.list'),
      payments_refund_history: await adapters('payments.refundHistory'),
    };
    expect(sameContext(compiled.result, handwritten)).toBe(true);
  }
});
it('computes paired differences and case-block uncertainty, preserving unknown costs and losses', () => {
  const row = (tokens: number, cost: number | null) => ({
    measurement: {
      ...emptyMeasurement(),
      inputTokens: tokens,
      outputTokens: 0,
      totalTokens: tokens,
      durationMs: 10,
    },
    apiEquivalentCostUsd: cost,
    assessment: { passed: true },
    usedFallback: false,
    unnecessaryReads: 0,
    duplicateSuccessfulReads: 0,
    selectorMs: 0,
  });
  const paired = Array.from({ length: 6 }, (_, i) => ({
    caseId: String(i),
    baseline: row(100, 0.01),
    optimized: row(110, null),
  }));
  const result = pairedRouting(paired) as Record<
    string,
    { absoluteSaving: number | null; descriptiveCaseBlockBootstrap95: number[] | null }
  >;
  expect(result.totalTokens.absoluteSaving).toBe(-10);
  expect(result.totalTokens.descriptiveCaseBlockBootstrap95).toEqual([-10, -10]);
  expect(result.apiEquivalentCostUsd.absoluteSaving).toBeNull();
  expect(result.apiEquivalentCostUsd.descriptiveCaseBlockBootstrap95).toBeNull();
});

it('keeps freshness guards intact and starts each new shadow request with a fresh runtime observation', async () => {
  const store = new Store(':memory:');
  let context = localContext();
  const registry = new JitRegistry(store, () => {}, {
    context: () => context,
    agent: async (request) => {
      const { customerId } = request.input as { customerId: string };
      return {
        resolved: true,
        summary: 'Fixture context',
        tokens: 0,
        llmInvocations: 0,
        result: {
          customer_id: customerId,
          crm_get_customer: routingFixture('crm.getCustomer', customerId),
          orders_list: routingFixture('orders.list', customerId),
          payments_refund_history: routingFixture('payments.refundHistory', customerId),
        },
      };
    },
  });
  try {
    registry.seed();
    const artifact = await registry.verify(registry.compile().id);
    context = { ...context, observedAt: Date.now() - artifact.ir.guards.maxAgeMs - 1 };
    expect((await registry.shadow(artifact.id, { customerId: 'C-101' })).shadow.status).toBe(
      'guard_miss',
    );
    context = localContext();
    expect((await registry.shadow(artifact.id, { customerId: 'C-101' })).shadow.status).toBe(
      'match',
    );
  } finally {
    store.close();
  }
});
