import { it, expect } from 'vitest';
import {
  defineContextContract,
  selectExecution,
  type ContextContract,
} from '../../src/integration/selection.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import type { ReadOperation } from '../../src/compiler/ir.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
const reads: ReadOperation[] = ['crm.getCustomer', 'orders.list', 'payments.refundHistory'];
const input = { customerId: 'C-101' };
it('selects prefetch only for an application-registered known complete read contract', () => {
  const contract = defineContextContract({ requirement: 'known', reads });
  expect(selectExecution(contract, input, localContext())).toMatchObject({
    mode: 'compiled_prefetch',
    reason: 'trusted_contract_requires_complete_context',
  });
  expect(
    selectExecution(JSON.parse(JSON.stringify(contract)) as ContextContract, input, localContext())
      .mode,
  ).toBe('normal');
  expect(() =>
    defineContextContract({ requirement: 'known', reads: [...reads, reads[0]] }),
  ).toThrow();
});
it('offers a tool when the agent must decide and preserves normal partial/absent context execution', () => {
  expect(
    selectExecution(
      defineContextContract({ requirement: 'agent_decides', reads }),
      input,
      localContext(),
    ).mode,
  ).toBe('compiled_tool');
  for (const subset of [[], ['crm.getCustomer']] as ReadOperation[][]) {
    const selection = selectExecution(
      defineContextContract({ requirement: 'known', reads: subset }),
      input,
      localContext(),
    );
    expect(selection.mode).toBe('normal');
    expect(selection.durationMs).toBeGreaterThanOrEqual(0);
  }
});
it('denies required scope/record authorization without suggesting a fallback', () => {
  const contract = defineContextContract({ requirement: 'known', reads });
  expect(selectExecution(contract, input, { ...localContext(), scopes: ['crm:read'] }).mode).toBe(
    'denied',
  );
  expect(
    selectExecution(contract, input, { ...localContext(), allowedCustomerIds: ['C-202'] }).mode,
  ).toBe('denied');
});
it('does not require unrelated scopes for a partial task or account access for a public no-read task', () => {
  expect(
    selectExecution(
      defineContextContract({ requirement: 'known', reads: ['crm.getCustomer'] }),
      input,
      { ...localContext(), scopes: ['crm:read'] },
    ).mode,
  ).toBe('normal');
  expect(
    selectExecution(defineContextContract({ requirement: 'known', reads: [] }), input, {
      ...localContext(),
      scopes: [],
      allowedCustomerIds: [],
    }).mode,
  ).toBe('normal');
});
it('authorizes and observes partial reads, rejects undeclared reads, and retains strict default context authorization', async () => {
  const context = { ...localContext(), scopes: ['crm:read'] };
  const observer = new TrajectoryObserver({
    input,
    context,
    adapters: mockAdapters(),
    agentId: 'test',
    allowedOperations: ['crm.getCustomer'],
  });
  await expect(
    observer.read('crm.getCustomer', { source: 'task_input', key: 'customerId' }),
  ).resolves.toMatchObject({ value: { eligible: true } });
  await expect(
    observer.read('orders.list', { source: 'task_input', key: 'customerId' }),
  ).rejects.toThrow('contract');
  const strict = new TrajectoryObserver({
    input,
    context,
    adapters: mockAdapters(),
    agentId: 'test',
  });
  await expect(
    strict.read('crm.getCustomer', { source: 'task_input', key: 'customerId' }),
  ).rejects.toThrow('permission');
});
it('does not depend on benchmark IDs, wording, or expected answers', () => {
  const contract = defineContextContract({ requirement: 'known', reads: [...reads].reverse() });
  for (const customerId of ['C-404', 'C-505', 'C-999'])
    expect(
      selectExecution(
        contract,
        { customerId },
        { ...localContext(), allowedCustomerIds: [customerId] },
      ).mode,
    ).toBe('compiled_prefetch');
});
