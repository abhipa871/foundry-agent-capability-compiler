import { describe, expect, it, vi } from 'vitest';
import {
  createReadWorkflowSelector,
  type ReadWorkflowContract,
  type ReadWorkflowReadiness,
} from '../../src/integration/client.js';

type Context = { tenant: string; scopes: readonly string[] };
function workflow<const Operation extends string>(
  operations: readonly Operation[],
  supportsSubsets = true,
) {
  return createReadWorkflowSelector<Operation, Context>({
    operations: operations.map((name) => ({ name, effect: 'read' })),
    supportsSubsets,
    authorize: (input, context, reads) => {
      if (
        !input ||
        typeof input !== 'object' ||
        !('tenant' in input) ||
        input.tenant !== context.tenant
      )
        throw new Error('Wrong tenant.');
      if (reads.some((read) => !context.scopes.includes(read))) throw new Error('Missing scope.');
    },
  });
}
const ready = () => ({ status: 'ready' as const });

describe('application-registered read workflow selection', () => {
  it.each([
    ['inventory.stock', 'catalog.price'],
    ['documents.metadata', 'documents.permissions'],
  ] as const)(
    'selects read-only %s workflows without customer-specific identifiers',
    (...operations) => {
      const selector = workflow(operations);
      const context = { tenant: 'example', scopes: operations };
      const input = { tenant: context.tenant, arbitraryResourceId: 'resource-42' };
      const contract = selector.defineContract({
        requirement: 'known',
        reads: [...operations].reverse(),
      });
      expect(selector.select(contract, input, context, { readiness: ready })).toMatchObject({
        mode: 'compiled_prefetch',
        resources: operations,
      });
      const agentDecides = selector.defineContract({
        requirement: 'agent_decides',
        reads: operations,
      });
      expect(selector.select(agentDecides, input, context, { readiness: ready })).toMatchObject({
        mode: 'compiled_tool',
        resources: [],
      });
      const subset = selector.defineContract({ requirement: 'subset', reads: [operations[0]] });
      expect(
        selector.select(
          subset,
          input,
          { ...context, scopes: [operations[0]] },
          { readiness: ready },
        ),
      ).toMatchObject({
        mode: 'compiled_prefetch',
        resources: [operations[0]],
      });
    },
  );

  it('does not accept copied, cross-workflow, duplicate or undeclared contracts', () => {
    const selector = workflow(['inventory.stock'] as const);
    const other = workflow(['inventory.stock'] as const);
    const contract = selector.defineContract({ requirement: 'known', reads: ['inventory.stock'] });
    const context = { tenant: 'example', scopes: ['inventory.stock'] };
    for (const untrusted of [
      JSON.parse(JSON.stringify(contract)),
      other.defineContract({ requirement: 'known', reads: ['inventory.stock'] }),
    ])
      expect(
        selector.select(untrusted as ReadWorkflowContract<'inventory.stock'>, context, context, {
          readiness: ready,
        }).reason,
      ).toBe('untrusted_task_metadata');
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.reads)).toBe(true);
    expect(() =>
      selector.defineContract({
        requirement: 'known',
        reads: ['inventory.stock', 'inventory.stock'],
      }),
    ).toThrow();
    expect(() =>
      selector.defineContract({
        requirement: 'known',
        reads: ['payments.write' as 'inventory.stock'],
      }),
    ).toThrow();
  });

  it('never converts a denied task into ordinary fallback, regardless of apparent savings', () => {
    const selector = workflow(['inventory.stock'] as const);
    const contract = selector.defineContract({ requirement: 'known', reads: ['inventory.stock'] });
    const readiness = vi.fn(ready);
    expect(
      selector.select(
        contract,
        { tenant: 'other' },
        { tenant: 'example', scopes: ['inventory.stock'] },
        {
          readiness,
          prefetchCostComparison: {
            pairedRequests: 4,
            baselineMeanCostUsd: 2,
            prefetchMeanCostUsd: 1,
          },
        },
      ).mode,
    ).toBe('denied');
    expect(readiness).not.toHaveBeenCalled();
  });

  it('requires explicit subset support and performs no readiness work for no-read tasks', () => {
    const selector = workflow(['inventory.stock', 'catalog.price'] as const, false);
    const context = { tenant: 'example', scopes: ['inventory.stock', 'catalog.price'] };
    const readiness = vi.fn(ready);
    const contract = selector.defineContract({ requirement: 'subset', reads: ['inventory.stock'] });
    expect(selector.select(contract, context, context, { readiness }).reason).toBe(
      'resource_subsets_not_supported',
    );
    const noReads = selector.defineContract({ requirement: 'known', reads: [] });
    expect(selector.select(noReads, context, context, { readiness }).reason).toBe(
      'contract_requires_no_reads',
    );
    expect(readiness).not.toHaveBeenCalled();
  });

  it('preserves readiness denials, skips unavailable capabilities and fails closed on broken checks', () => {
    const selector = workflow(['inventory.stock'] as const);
    const contract = selector.defineContract({ requirement: 'known', reads: ['inventory.stock'] });
    const context = { tenant: 'example', scopes: ['inventory.stock'] };
    for (const [status, mode] of [
      ['denied', 'denied'],
      ['unavailable', 'normal'],
    ] as const)
      expect(
        selector.select(contract, context, context, {
          readiness: () => ({ status, reason: 'application_guard' }),
        }),
      ).toMatchObject({ mode, reason: 'application_guard' });
    for (const readiness of [
      () => {
        throw new Error('Broken guard');
      },
      () => ({ status: 'unknown' }) as unknown as ReadWorkflowReadiness,
    ])
      expect(selector.select(contract, context, context, { readiness })).toMatchObject({
        mode: 'denied',
        reason: 'capability_readiness_failed_closed',
      });
  });

  it('applies measured-cost vetoes to other domains and does not treat unknown cost as zero', () => {
    const selector = workflow(['inventory.stock'] as const);
    const contract = selector.defineContract({ requirement: 'known', reads: ['inventory.stock'] });
    const context = { tenant: 'example', scopes: ['inventory.stock'] };
    for (const [baselineMeanCostUsd, prefetchMeanCostUsd, mode] of [
      [2, 1, 'compiled_prefetch'],
      [1, 2, 'normal'],
      [1, NaN, 'normal'],
    ] as const)
      expect(
        selector.select(contract, context, context, {
          readiness: ready,
          prefetchCostComparison: { pairedRequests: 4, baselineMeanCostUsd, prefetchMeanCostUsd },
        }).mode,
      ).toBe(mode);
  });

  it('rejects write declarations, duplicate operation registrations and asynchronous authorization', () => {
    expect(() =>
      createReadWorkflowSelector({
        operations: [{ name: 'inventory.update', effect: 'write' as 'read' }],
        supportsSubsets: false,
        authorize: () => {},
      }),
    ).toThrow();
    expect(() => workflow(['inventory.stock', 'inventory.stock'])).toThrow();
    const selector = createReadWorkflowSelector({
      operations: [{ name: 'inventory.stock', effect: 'read' }],
      supportsSubsets: false,
      authorize: (() => Promise.resolve()) as unknown as () => undefined,
    });
    const contract = selector.defineContract({ requirement: 'known', reads: ['inventory.stock'] });
    expect(selector.select(contract, {}, {}, { readiness: ready }).mode).toBe('denied');
  });
});
