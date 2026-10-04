import { expect, it } from 'vitest';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import {
  UsageLedger,
  apiEquivalentCost,
  incompleteProviderMeasurement,
  executeTool,
  provider,
  model,
} from '../../scripts/experiments/customer-agent.js';
import { ProviderRequestCounters } from '../../scripts/experiments/metrics.js';
import { breakEven, comparison, mean } from '../../scripts/experiments/statistics.js';
import { emptyMeasurement } from '../../src/telemetry/measurement.js';
const capture = (context = localContext()) =>
  new TrajectoryObserver({
    input: { customerId: 'C-101' },
    context,
    adapters: mockAdapters(),
    agentId: 'experiment',
    provider,
    model,
  });
const usage = (input: number, output: number, cached: number) => ({
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: cached,
  totalTokens: input + output,
});
it('never presents an incomplete provider stream as zero-cost or fully metered inference', () => {
  expect(
    incompleteProviderMeasurement({ ...emptyMeasurement(), outcome: 'failed', toolCalls: 2 }),
  ).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
    modelCalls: null,
    costUsd: null,
    outcome: 'failed',
    toolCalls: 2,
  });
});
it('records additive provider responses exactly once, with correct identity and no raw reasoning', () => {
  const observer = capture();
  const ledger = new UsageLedger(observer);
  const first = usage(100, 20, 40);
  const second = usage(140, 30, 80);
  ledger.accept({ total: first, last: first }, 0, 2);
  ledger.accept({ total: first, last: first }, 0, 2);
  ledger.accept({ total: usage(240, 50, 120), last: second }, 2, 6);
  expect(ledger.responses).toBe(2);
  expect(observer.measurement).toMatchObject({
    modelCalls: 2,
    inputTokens: 240,
    outputTokens: 50,
    cachedInputTokens: 120,
    totalTokens: 290,
    costUsd: null,
    origin: 'observed',
  });
  expect(
    observer.modelEvents.every((event) => event.provider === provider && event.model === model),
  ).toBe(true);
  expect(JSON.stringify(observer.exportStructural())).not.toContain('customerId');
  expect(Object.keys(observer.modelEvents[0])).not.toContain('text');
});
it('rejects inconsistent provider totals and impossible cache counts rather than estimating', () => {
  const ledger = new UsageLedger(capture());
  expect(() => ledger.accept({ total: usage(110, 20, 0), last: usage(100, 20, 0) }, 0, 1)).toThrow(
    'additive',
  );
  expect(() =>
    new UsageLedger(capture()).accept(
      { total: usage(100, 20, 101), last: usage(100, 20, 101) },
      0,
      1,
    ),
  ).toThrow('Cached');
  expect(() => new UsageLedger(capture()).accept({}, 0, 1)).toThrow();
});
it('uses explicit application-bound lineage and permits only three empty-argument read tools', async () => {
  const observer = capture();
  const result = await executeTool(observer, 'lookup_customer', {});
  expect(result).toMatchObject({ customerId: 'C-101' });
  expect(observer.events[0].args.customerId).toEqual({
    source: 'task_input',
    key: 'customerId',
    value: 'C-101',
  });
  await expect(executeTool(observer, 'refund_write', {})).rejects.toThrow('allowlist');
  await expect(executeTool(observer, 'lookup_customer', { customerId: 'C-202' })).rejects.toThrow();
  await expect(executeTool(observer, '__proto__', {})).rejects.toThrow('allowlist');
  expect(observer.events).toHaveLength(1);
});
it('denies record and scope violations before the read adapter executes', async () => {
  for (const ctx of [
    { ...localContext(), allowedCustomerIds: ['C-202'] },
    { ...localContext(), scopes: ['crm:read'] },
  ]) {
    const observer = capture(ctx);
    await expect(executeTool(observer, 'lookup_customer', {})).rejects.toThrow();
    expect(observer.events).toHaveLength(0);
    expect(observer.measurement.toolCalls).toBe(0);
  }
});
it('keeps unknown usage unknown when mixing streaming and wrapped model responses', async () => {
  const observer = capture();
  await observer.modelCall(async () => ({ value: 'unmetered' }));
  observer.recordModelResponse({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 }, 0, 1);
  expect(observer.measurement).toMatchObject({
    modelCalls: 2,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
  });
  expect(() => observer.recordModelResponse({ inputTokens: 1, outputTokens: 0 }, 2, 1)).toThrow(
    'timing',
  );
});
it('applies published cache discount without double-counting cached input, labeled separately from billing', () => {
  expect(apiEquivalentCost(1_000_000, 200_000, 100_000)).toBe(7.1);
  expect(() => apiEquivalentCost(1, 2, 0)).toThrow();
  expect(apiEquivalentCost(0, 0, 0)).toBe(0);
});
it('propagates unknown measurements and never reports profitable break-even with nonpositive savings', () => {
  expect(
    mean([
      { ...emptyMeasurement(), inputTokens: null },
      { ...emptyMeasurement(), inputTokens: 10 },
    ]).inputTokens,
  ).toBeNull();
  expect(comparison(100, 20)).toEqual({
    baseline: 100,
    optimized: 20,
    absoluteSaving: 80,
    percentSaving: 80,
  });
  expect(comparison(0, 0).percentSaving).toBeNull();
  expect(breakEven(10, 3)).toBe(4);
  expect(breakEven(10, 0)).toBeNull();
  expect(breakEven(10, -1)).toBeNull();
  expect(breakEven(null, 1)).toBeNull();
});
it('counts repeated cumulative transport metrics once and keeps only allowlisted numeric counters', () => {
  const counters = new ProviderRequestCounters();
  const packet = (count: number) => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'codex.api_request',
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [{ startTimeUnixNano: '1', attributes: [], asInt: String(count) }],
                },
              },
              { name: 'private.unrelated', sum: {} },
            ],
          },
        ],
      },
    ],
  });
  counters.accept(packet(2));
  counters.accept(packet(2));
  counters.accept(packet(3));
  expect(counters.result()['codex.api_request']).toBe(3);
  expect(counters.result()).not.toHaveProperty('private.unrelated');
});
