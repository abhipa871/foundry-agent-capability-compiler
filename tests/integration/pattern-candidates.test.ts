import { expect, it } from 'vitest';
import { Store } from '../../src/registry/store.js';
import { JitRegistry } from '../../src/registry/jit.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import { replayTrace } from '../../src/exploration/tool-events.js';
import { localIdentity, withIdentity } from '../../src/security/identity.js';

async function observe(customerId: string) {
  const observer = new TrajectoryObserver({
    input: { customerId },
    context: localContext(),
    adapters: mockAdapters(),
    agentId: 'test',
  });
  const crm = await observer.read('crm.getCustomer', { source: 'task_input', key: 'customerId' });
  const binding = {
    source: 'event_output' as const,
    ref: { producerEventId: crm.eventId, outputPath: 'customerId' as const },
  };
  const order = await observer.read('orders.list', binding);
  const refund = await observer.read('payments.refundHistory', binding);
  return observer.finish({
    customer_id: customerId,
    crm_get_customer: crm.value,
    orders_list: order.value,
    payments_refund_history: refund.value,
  });
}

it('compiles actual observations as an untrusted candidate without changing routing', async () => {
  const store = new Store(':memory:');
  const registry = new JitRegistry(store, () => {});
  try {
    for (const customerId of ['C-101', 'C-202'])
      registry.ingest(replayTrace(await observe(customerId)), 'import');
    const [pattern] = registry.analyze();
    expect(pattern.measurementOrigin).toBe('observed');
    const candidate = registry.compilePattern(pattern.id);
    expect(candidate.status).toBe('draft');
    expect(candidate.patternId).toBe(pattern.id);
    expect(candidate.ir.nodes).toHaveLength(4);
    expect(registry.active()).toEqual([]);
    expect(registry.compilePattern(pattern.id).id).toBe(candidate.id);
    expect(
      (await registry.dispatch({ kind: 'customer_context', input: { customerId: 'C-101' } })).mode,
    ).toBe('agent');
    await withIdentity({ ...localIdentity, tenantId: 'other' }, async () => {
      expect(registry.patterns()).toEqual([]);
      expect(() => registry.compilePattern(pattern.id)).toThrow(/not found/);
    });
  } finally {
    store.close();
  }
});

it('rechecks effect evidence instead of trusting a persisted eligible report', async () => {
  const store = new Store(':memory:');
  const registry = new JitRegistry(store, () => {});
  try {
    for (const customerId of ['C-101', 'C-202'])
      registry.ingest(replayTrace(await observe(customerId)), 'import');
    const [pattern] = registry.analyze();
    const trace = registry.traces()[0];
    store.put('toolTrace', {
      ...trace,
      events: [
        ...trace.events,
        {
          ...trace.events[0],
          eventId: '33333333-3333-4333-8333-333333333333',
          effect: 'external_write',
          operation: 'payments.issue',
        },
      ],
    });
    expect(() => registry.compilePattern(pattern.id)).toThrow(/not eligible/);
    expect(registry.artifacts()).toEqual([]);
  } finally {
    store.close();
  }
});
