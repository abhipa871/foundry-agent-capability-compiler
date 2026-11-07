import { expect, it } from 'vitest';
import { Store } from '../../src/registry/store.js';
import { JitRegistry } from '../../src/registry/jit.js';
import { fixtureResult } from '../../src/runtime/adapters/registry.js';
import type { AgentFallback } from '../../src/runtime/dispatcher.js';

const agent: AgentFallback = async (request) => {
  const { customerId } = request.input as { customerId: string };
  return {
    summary: 'Sandbox baseline',
    resolved: true,
    tokens: 0,
    llmInvocations: 0,
    result: {
      customer_id: customerId,
      crm_get_customer: fixtureResult('crm.getCustomer', customerId),
      orders_list: fixtureResult('orders.list', customerId),
      payments_refund_history: fixtureResult('payments.refundHistory', customerId),
    },
  };
};
it('keeps native authoritative and requires held-out shadow coverage of the current verification', async () => {
  const store = new Store(':memory:');
  const registry = new JitRegistry(store, () => {}, { agent });
  try {
    registry.seed();
    const artifact = await registry.verify(registry.compile().id);
    expect(registry.shadowStatus(artifact.id).ready).toBe(false);
    for (const customerId of ['C-101', 'C-202', 'C-303']) {
      const result = await registry.shadow(artifact.id, { customerId });
      expect(result.authoritative.mode).toBe('agent');
      expect(result.shadow.status).toBe('match');
    }
    expect(registry.shadowStatus(artifact.id).ready).toBe(true);
    await registry.verify(artifact.id);
    expect(registry.shadowStatus(artifact.id).ready).toBe(false);
  } finally {
    store.close();
  }
});
it('records divergence without returning the compiled result', async () => {
  const store = new Store(':memory:');
  const registry = new JitRegistry(store, () => {}, {
    agent: async (request, checkpoint) => {
      const native = await agent(request, checkpoint);
      (native.result!.orders_list as { orders: { daysLate: number }[] }).orders[0].daysLate = 999;
      return native;
    },
  });
  try {
    registry.seed();
    const artifact = await registry.verify(registry.compile().id);
    const result = await registry.shadow(artifact.id, { customerId: 'C-101' });
    expect(result.shadow.status).toBe('mismatch');
    expect(
      (result.authoritative.result!.orders_list as { orders: { daysLate: number }[] }).orders[0]
        .daysLate,
    ).toBe(999);
    expect(registry.shadowStatus(artifact.id).ready).toBe(false);
  } finally {
    store.close();
  }
});
it('does not perform shadow reads when the native path is unresolved or authorization is denied', async () => {
  const store = new Store(':memory:');
  let reads = 0;
  const registry = new JitRegistry(store, () => {}, {
    adapters: () => async () => {
      reads++;
      return {};
    },
  });
  try {
    registry.seed();
    const artifact = await registry.verify(registry.compile().id);
    expect((await registry.shadow(artifact.id, { customerId: 'C-101' })).shadow.status).toBe(
      'baseline_unavailable',
    );
    expect(reads).toBe(0);
  } finally {
    store.close();
  }
});
