import { expect, it } from 'vitest';
import {
  supportCases,
  supportOracle,
  assessSupportResponse,
  supportProjection,
  contextFromReads,
  supportPrompt,
} from '../../scripts/experiments/support-task.js';
import { sumMeasurements } from '../../scripts/experiments/statistics.js';
import { emptyMeasurement } from '../../src/telemetry/measurement.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import { executeTool } from '../../scripts/experiments/customer-agent.js';
const correct = () => ({
  ...supportOracle['C-101'],
  reply:
    'I am sorry order O-101 is 8 days late. The records show no prior refund. We can request a refund review and check the next steps, but this message does not issue or guarantee a refund.',
});
it('covers nine distinct complaints and keeps C-303 out of compilation customer IDs', () => {
  expect(supportCases).toHaveLength(9);
  expect(new Set(supportCases.map((task) => task.id)).size).toBe(9);
  expect(supportCases.filter((task) => task.customerId === 'C-303')).toHaveLength(3);
});
it('checks hand-stated evidence and decisions without scoring reply wording equality', () => {
  expect(assessSupportResponse(correct(), supportCases[0]).passed).toBe(true);
  const variation = {
    ...correct(),
    reply:
      'Order O-101 is 8 days late, and I understand the frustration. I can suggest a refund review based on the account records. The support team will need to assess it; no refund has been issued here.',
  };
  expect(assessSupportResponse(variation, supportCases[0]).passed).toBe(true);
  expect(supportProjection(correct())).toEqual(supportProjection(variation));
});
it('rejects wrong policy actions, incorrect evidence, omitted orders and ignored refund history', () => {
  expect(
    assessSupportResponse({ ...correct(), action: 'delivery_support' }, supportCases[0]).passed,
  ).toBe(false);
  expect(
    assessSupportResponse({ ...correct(), orders: [{ id: 'O-101', daysLate: 7 }] }, supportCases[0])
      .passed,
  ).toBe(false);
  const c202 = {
    ...supportOracle['C-202'],
    reply:
      'Order O-extra is 6 days late. A prior refund is recorded, so the support team should perform a human review before discussing further refund options.',
  };
  expect(assessSupportResponse(c202, supportCases[3]).passed).toBe(true);
  expect(
    assessSupportResponse({ ...c202, orders: c202.orders.slice(0, 1) }, supportCases[3]).passed,
  ).toBe(false);
  expect(
    assessSupportResponse({ ...c202, refunds: [], action: 'refund_review' }, supportCases[3])
      .passed,
  ).toBe(false);
});
it('checks order/delay grounding and rejects claiming a completed financial action', () => {
  expect(
    assessSupportResponse(
      { ...correct(), reply: correct().reply.replace('O-101', 'O-wrong') },
      supportCases[0],
    ).passed,
  ).toBe(false);
  expect(
    assessSupportResponse(
      { ...correct(), reply: correct().reply.replace('8 days', '9 days') },
      supportCases[0],
    ).passed,
  ).toBe(false);
  expect(
    assessSupportResponse(
      {
        ...correct(),
        reply:
          'Order O-101 is 8 days late. I have issued a refund and the support team will check delivery.',
      },
      supportCases[0],
    ).passed,
  ).toBe(false);
});
it('canonicalizes evidence order while retaining every fact', () => {
  const expected = supportOracle['C-202'];
  expect(
    supportProjection({
      ...expected,
      orders: [...expected.orders].reverse(),
      reply: correct().reply,
    }),
  ).toEqual(expected);
});
it('reconstructs actual typed read evidence and rejects missing tool results', async () => {
  const observer = new TrajectoryObserver({
    input: { customerId: 'C-101' },
    context: localContext(),
    adapters: mockAdapters(),
    agentId: 'support-test',
  });
  expect(() => contextFromReads(observer, 'C-101')).toThrow();
  await Promise.all(
    ['lookup_customer', 'lookup_orders', 'lookup_refund_history'].map((name) =>
      executeTool(observer, name, {}),
    ),
  );
  const context = contextFromReads(observer, 'C-101');
  expect(context.orders_list.orders).toEqual(supportOracle['C-101'].orders);
  expect(supportPrompt(supportCases[0], context)).toContain(
    'Authorized account context already loaded',
  );
});
it('adds retained model and fallback work, with complete wall latency rather than summed overlapping timers', () => {
  const model = {
    ...emptyMeasurement(),
    outcome: 'success' as const,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 20,
  };
  const fallback = {
    ...emptyMeasurement(),
    outcome: 'success' as const,
    inputTokens: 200,
    outputTokens: 20,
    totalTokens: 220,
    modelCalls: 2,
    toolCalls: 3,
    durationMs: 30,
  };
  expect(sumMeasurements([model, fallback], 55)).toMatchObject({
    inputTokens: 300,
    outputTokens: 30,
    totalTokens: 330,
    modelCalls: 3,
    toolCalls: 3,
    durationMs: 55,
    costUsd: null,
  });
  expect(
    sumMeasurements([model, { ...fallback, inputTokens: null, totalTokens: null }], 55).inputTokens,
  ).toBeNull();
  expect(sumMeasurements([model, { ...fallback, outcome: 'failed' }], 55).outcome).toBe('failed');
  expect(sumMeasurements([model, { ...fallback, origin: 'fixture' }], 55).origin).toBe('estimated');
});
