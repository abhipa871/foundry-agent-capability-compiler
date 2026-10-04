import { expect, it } from 'vitest';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { localContext, fixtureResult } from '../../src/runtime/adapters/registry.js';

it('enforces a concurrent observation budget on attempts, not completed calls', async () => {
  let unblock: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const observer = new TrajectoryObserver({
    input: { customerId: 'C-101' },
    context: localContext(),
    agentId: 'sandbox',
    adapters: async () => {
      await gate;
      return fixtureResult('crm.getCustomer', 'C-101');
    },
  });
  const calls = Array.from({ length: 100 }, () =>
    observer.read('crm.getCustomer', { source: 'task_input', key: 'customerId' }),
  );
  await expect(
    observer.read('crm.getCustomer', { source: 'task_input', key: 'customerId' }),
  ).rejects.toThrow(/budget/);
  unblock();
  await Promise.all(calls);
  expect(observer.events).toHaveLength(100);
  expect(observer.measurement.apiCalls).toBeNull();
});
