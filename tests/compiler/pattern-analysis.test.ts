import { describe, expect, it } from 'vitest';
import { analyzePatterns } from '../../src/compiler/analyze.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';

describe('offline structural analysis', () => {
  const traces = () => sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo'));
  it('groups different wording and call orders with the existing structural matcher', () => {
    const [pattern] = analyzePatterns(traces(), 'local-demo');
    expect(pattern.occurrences).toBe(2);
    expect(pattern.eligible).toBe(true);
    expect(pattern.toolSequence).toEqual([
      'crm.getCustomer',
      'orders.list',
      'payments.refundHistory',
    ]);
    expect(pattern.averageToolCalls).toBe(4); // includes the captured failed legacy read
    expect(pattern.potentialToolCallReduction).toBe(1);
    expect(pattern.measurementOrigin).toBe('fixture');
    expect(pattern.averageCostUsd).toBeNull();
    expect(analyzePatterns(traces().reverse(), 'local-demo')[0].id).toBe(pattern.id);
  });
  it('does not cross tenants, equate different topology, or promote one observation', () => {
    expect(() => analyzePatterns(traces(), 'other')).toThrow(/tenant/);
    expect(analyzePatterns(traces().slice(0, 1), 'local-demo')[0].eligible).toBe(false);
    const changed = traces();
    changed[1].events = changed[1].events.map((event) =>
      event.operation === 'orders.list'
        ? {
            ...event,
            args: { customerId: { source: 'task_input', key: 'customerId', value: 'C-202' } },
          }
        : event,
    );
    expect(analyzePatterns(changed, 'local-demo')).toHaveLength(2);
    expect(analyzePatterns(changed, 'local-demo').every((pattern) => !pattern.eligible)).toBe(true);
  });
  it('rejects effectful work and never treats missing usage as measured zero', () => {
    const changed = traces().map((trace) => ({ ...trace, source: 'import' as const }));
    changed[0].events[0].effect = 'external_write';
    const [pattern] = analyzePatterns(changed, 'local-demo');
    expect(pattern.eligible).toBe(false);
    expect(pattern.averageTokens).toBeNull();
    expect(pattern.averageModelCalls).toBeNull();
  });
});
