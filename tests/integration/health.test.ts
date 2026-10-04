import { expect, it } from 'vitest';
import { JitRegistry } from '../../src/registry/jit.js';
import { Store } from '../../src/registry/store.js';
import {
  fixtureResult,
  mockAdapters,
  type AdapterFault,
} from '../../src/runtime/adapters/registry.js';
import { initialHealth, observeHealth } from '../../src/telemetry/health.js';
import { localIdentity, withIdentity } from '../../src/security/identity.js';
import { FoundryClient } from '../../src/integration/client.js';
import { localContext } from '../../src/runtime/adapters/registry.js';

const agent = async (task: { input: unknown }) => {
  const { customerId } = task.input as { customerId: string };
  return {
    resolved: true,
    summary: 'Sandbox reference',
    llmInvocations: 0,
    tokens: 0,
    result: {
      customer_id: customerId,
      crm_get_customer: fixtureResult('crm.getCustomer', customerId),
      orders_list: fixtureResult('orders.list', customerId),
      payments_refund_history: fixtureResult('payments.refundHistory', customerId),
    },
  };
};
async function ready(registry: JitRegistry) {
  const candidate = await registry.verify(registry.compile().id);
  for (const customerId of ['C-101', 'C-202', 'C-303'])
    await registry.shadow(candidate.id, { customerId });
  return registry.approve(candidate.id, 'Sandbox read-only review');
}
it('quarantines repeated runtime failures, removes deployment, and requires renewed shadow evidence', async () => {
  const store = new Store(':memory:');
  let fault: AdapterFault = 'none';
  const registry = new JitRegistry(store, () => {}, {
    agent,
    adapters: () => mockAdapters({ fault }),
  });
  try {
    registry.seed();
    const artifact = await ready(registry);
    fault = 'malformed';
    for (let n = 0; n < 3; n++)
      expect(
        (await registry.dispatch({ kind: 'customer_context', input: { customerId: 'C-101' } }))
          .mode,
      ).toBe('agent');
    expect(registry.health(artifact.id).status).toBe('quarantined');
    expect(registry.active()).toEqual([]);
    expect(() => registry.deploy(artifact.id)).toThrow(/approved/);
    fault = 'none';
    await registry.verify(artifact.id);
    expect(registry.health(artifact.id).status).toBe('healthy');
    expect(registry.shadowStatus(artifact.id).ready).toBe(false);
  } finally {
    store.close();
  }
});
it('rolls back to an approved healthy prior version with current shadow coverage', async () => {
  const store = new Store(':memory:');
  const registry = new JitRegistry(store, () => {}, { agent });
  try {
    registry.seed();
    const previous = await ready(registry);
    const latest = await ready(registry);
    expect(registry.active()[0].id).toBe(latest.id);
    registry.quarantine(latest.id);
    expect(registry.rollback(previous.id).id).toBe(previous.id);
    expect(registry.active()[0].id).toBe(previous.id);
    expect(() => registry.rollback(latest.id)).toThrow();
  } finally {
    store.close();
  }
});
it('detects repeated latency regressions without allowing success to clear quarantine', () => {
  let health = initialHealth('tenant', 'artifact');
  for (let n = 0; n < 5; n++) health = observeHealth(health, { kind: 'success', durationMs: 10 });
  for (let n = 0; n < 3; n++) health = observeHealth(health, { kind: 'success', durationMs: 100 });
  expect(health.reason).toBe('latency_regression');
  health = observeHealth(health, { kind: 'success', durationMs: 10 });
  expect(health.status).toBe('quarantined');
});
it('expires validation and telemetry within one tenant while preserving other tenant records', async () => {
  const store = new Store(':memory:');
  const registry = new JitRegistry(store, () => {}, { agent });
  try {
    registry.seed();
    const artifact = await ready(registry);
    withIdentity({ ...localIdentity, tenantId: 'other' }, () => store.setSetting('marker', true));
    const result = registry.maintenance(Date.now() + 8 * 86400000);
    expect(result.purged).toBe(5);
    expect(registry.traces()).toEqual([]);
    expect(registry.health(artifact.id).reason).toBe('validation_expired');
    withIdentity({ ...localIdentity, tenantId: 'other' }, () =>
      expect(store.setting('marker', false)).toBe(true),
    );
  } finally {
    store.close();
  }
});
it('preserves failed wrapped tool counts without inventing unknown model usage', async () => {
  const client = new FoundryClient({
    ...localIdentity,
    context: localContext,
    adapters: mockAdapters({ fault: 'malformed' }),
    native: async (_task, _checkpoint, observer) => {
      await observer!.read('crm.getCustomer', { source: 'task_input', key: 'customerId' });
      throw new Error('provider failure');
    },
  });
  const result = await client.execute({ kind: 'customer_context', input: { customerId: 'C-101' } });
  expect(result.outcome).toBe('failed');
  expect(result.measurement.toolCalls).toBe(1);
  expect(result.measurement.totalTokens).toBeNull();
  expect(result.measurement.modelCalls).toBeNull();
});

it('prevents in-flight verification from resurrecting a revoked artifact', async () => {
  const store = new Store(':memory:');
  const registry = new JitRegistry(store, () => {});
  try {
    registry.seed();
    const candidate = registry.compile();
    const pending = registry.verify(candidate.id);
    registry.revoke(candidate.id);
    await expect(pending).rejects.toThrow(/changed during verification/);
    expect(registry.get(candidate.id).status).toBe('revoked');
    expect(registry.active()).toEqual([]);
  } finally {
    store.close();
  }
});
