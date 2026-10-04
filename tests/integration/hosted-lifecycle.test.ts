import { expect, it } from 'vitest';
import { localIdentity, withIdentity } from '../../src/security/identity.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { replayTrace } from '../../src/exploration/tool-events.js';
import { Store } from '../../src/registry/store.js';
import { JitRegistry } from '../../src/registry/jit.js';

async function native(input: unknown) {
  const { customerId } = input as { customerId: string };
  const observer = new TrajectoryObserver({
    input: { customerId },
    context: localContext(),
    adapters: mockAdapters(),
    agentId: 'customer-agent',
  });
  const crm = await observer.read('crm.getCustomer', { source: 'task_input', key: 'customerId' });
  const binding = {
    source: 'event_output' as const,
    ref: { producerEventId: crm.eventId, outputPath: 'customerId' as const },
  };
  const orders = await observer.read('orders.list', binding);
  const refunds = await observer.read('payments.refundHistory', binding);
  const result = {
    customer_id: customerId,
    crm_get_customer: crm.value,
    orders_list: orders.value,
    payments_refund_history: refunds.value,
  };
  return { result, trace: observer.finish(result) };
}
it('enforces separate tenant promotion gates, zero-percent rollout and revalidation removal', async () => {
  const store = new Store(':memory:');
  try {
    await withIdentity(
      {
        ...localIdentity,
        tenantId: 'customer-a',
        principalId: 'customer-principal',
        agentId: 'customer-agent',
      },
      async () => {
        const registry = new JitRegistry(store, () => {}, {
          agent: async (task) => ({
            ...(await native(task.input)),
            resolved: true,
            summary: 'Fixture baseline',
            tokens: 0,
            llmInvocations: 0,
          }),
        });
        for (const customerId of ['C-101', 'C-202'])
          registry.ingest(replayTrace((await native({ customerId })).trace), 'import');
        const [pattern] = registry.analyze();
        expect(pattern.eligible).toBe(true);
        const candidate = await registry.verify(registry.compilePattern(pattern.id).id);
        expect(candidate.status).toBe('verified');
        registry.approve(candidate.id, 'Tenant sandbox review');
        expect(registry.active()).toEqual([]);
        expect(() => registry.deploy(candidate.id)).toThrow(/shadow coverage/);
        for (const customerId of ['C-101', 'C-202', 'C-303'])
          await registry.shadow(candidate.id, { customerId });
        registry.deploy(candidate.id);
        expect(
          (await registry.dispatch({ kind: 'customer_context', input: { customerId: 'C-101' } }))
            .mode,
        ).toBe('agent');
        registry.configureRouting({ mode: 'live', rolloutPercent: 0 });
        expect(
          (await registry.dispatch({ kind: 'customer_context', input: { customerId: 'C-101' } }))
            .mode,
        ).toBe('agent');
        registry.configureRouting({ mode: 'live', rolloutPercent: 100 });
        expect(
          (await registry.dispatch({ kind: 'customer_context', input: { customerId: 'C-101' } }))
            .mode,
        ).toBe('compiled');
        await registry.verify(candidate.id);
        expect(registry.get(candidate.id).status).toBe('verified');
        expect(registry.active()).toEqual([]);
        expect(registry.runtimeTicket().mode).toBe('observe');
        expect(registry.shadowStatus(candidate.id).ready).toBe(false);
      },
    );
  } finally {
    store.close();
  }
});
