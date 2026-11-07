import { it, expect, vi } from 'vitest';
import {
  defineContextContract,
  selectExecution,
  type ContextContract,
  type ExecutionSelectionOptions,
} from '../../src/integration/selection.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import type { IRArtifact, ReadOperation } from '../../src/compiler/ir.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { emitArtifact } from '../../src/compiler/emit.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
const reads: ReadOperation[] = ['crm.getCustomer', 'orders.list', 'payments.refundHistory'];
const input = { customerId: 'C-101' };

function candidate(): IRArtifact {
  const { ir, report } = compileIR(
    sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo')),
  );
  const artifact = emitArtifact(ir, report, { version: 1 });
  return {
    ...artifact,
    status: 'approved',
    verifiedDigest: artifact.digest,
    approvedDigest: artifact.digest,
    checks: [
      {
        name: 'Guard test fixture',
        category: 'schema',
        passed: true,
        detail: 'Synthetic verification evidence for routing tests only',
        durationMs: 0,
      },
    ],
  };
}
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

it.each([
  ['known', reads],
  ['subset', ['orders.list']],
] as const)('applies the opt-in measured-cost veto to %s prefetch', (requirement, resources) => {
  const contract = defineContextContract({ requirement, reads: [...resources] });
  const compare = (baselineMeanCostUsd: number, prefetchMeanCostUsd: number) =>
    selectExecution(contract, input, localContext(), {
      prefetchCostComparison: { pairedRequests: 8, baselineMeanCostUsd, prefetchMeanCostUsd },
    });
  expect(selectExecution(contract, input, localContext()).mode).toBe('compiled_prefetch');
  expect(compare(0.02, 0.01)).toMatchObject({
    mode: 'compiled_prefetch',
    resources: [...resources],
  });
  for (const [baseline, optimized] of [
    [0.01, 0.02],
    [0.01, 0.01],
    [0, 0],
  ]) {
    const decision = compare(baseline!, optimized!);
    expect(decision).toMatchObject({
      mode: 'normal',
      reason: 'measured_prefetch_cost_not_lower',
      resources: [],
    });
    expect(decision.durationMs).toBeGreaterThanOrEqual(0);
  }
});

it.each([NaN, Infinity, -1, null, undefined])(
  'does not interpret an invalid or unavailable cost (%s) as zero',
  (cost) => {
    const options = {
      prefetchCostComparison: {
        pairedRequests: 8,
        baselineMeanCostUsd: 0.02,
        prefetchMeanCostUsd: cost,
      },
    } as unknown as ExecutionSelectionOptions;
    expect(
      selectExecution(
        defineContextContract({ requirement: 'known', reads }),
        input,
        localContext(),
        options,
      ),
    ).toMatchObject({ mode: 'normal', reason: 'prefetch_cost_evidence_invalid', resources: [] });
  },
);

it('requires paired evidence and never lets cost evidence override authorization or task semantics', () => {
  const contract = defineContextContract({ requirement: 'known', reads });
  const options = {
    prefetchCostComparison: {
      pairedRequests: 0,
      baselineMeanCostUsd: 0.02,
      prefetchMeanCostUsd: 0.01,
    },
  };
  expect(selectExecution(contract, input, localContext(), options)).toMatchObject({
    mode: 'normal',
    reason: 'prefetch_cost_evidence_invalid',
  });
  options.prefetchCostComparison.pairedRequests = 8;
  expect(
    selectExecution(contract, input, { ...localContext(), scopes: [] }, options),
  ).toMatchObject({
    mode: 'denied',
    reason: 'task_authorization_denied',
    resources: [],
  });
  expect(
    selectExecution(
      JSON.parse(JSON.stringify(contract)) as ContextContract,
      input,
      localContext(),
      options,
    ),
  ).toMatchObject({
    mode: 'normal',
    reason: 'untrusted_task_metadata',
  });
  for (const [requirement, resources, mode] of [
    ['agent_decides', reads, 'compiled_tool'],
    ['known', ['crm.getCustomer'], 'normal'],
    ['known', [], 'normal'],
  ] as const) {
    expect(
      selectExecution(
        defineContextContract({ requirement, reads: [...resources] }),
        input,
        localContext(),
        options,
      ).mode,
    ).toBe(mode);
  }
});

it('offers prefetch or a tool only when a supplied candidate passes existing guards', () => {
  for (const requirement of ['known', 'agent_decides'] as const) {
    const contract = defineContextContract({ requirement, reads });
    expect(selectExecution(contract, input, localContext(), { candidate: candidate() }).mode).toBe(
      requirement === 'known' ? 'compiled_prefetch' : 'compiled_tool',
    );
    expect(selectExecution(contract, input, localContext(), { candidate: null })).toMatchObject({
      mode: 'normal',
      reason: 'no_available_capability',
      resources: [],
    });
  }
});

it.each(['revoked', 'digest', 'validation', 'freshness', 'adapter'] as const)(
  'declines a known %s guard miss before compiled execution and agrees with dispatch',
  async (fault) => {
    const artifact = candidate();
    const context = localContext();
    const expected = {
      revoked: 'artifact_status',
      digest: 'artifact_digest',
      validation: 'validation',
      freshness: 'data_freshness',
      adapter: 'adapter_versions',
    }[fault];
    if (fault === 'revoked') artifact.status = 'revoked';
    if (fault === 'digest') artifact.digest = 'tampered';
    if (fault === 'validation') artifact.verifiedDigest = undefined;
    if (fault === 'freshness') context.observedAt = 0;
    if (fault === 'adapter')
      context.adapterVersions = { ...context.adapterVersions, 'orders.list': 'incompatible' };
    const contract = defineContextContract({ requirement: 'known', reads });
    expect(selectExecution(contract, input, context, { candidate: artifact })).toMatchObject({
      mode: 'normal',
      reason: `capability_guard_miss:${expected}`,
      resources: [],
    });
    const adapters = vi.fn(mockAdapters());
    const outcome = await dispatch({ kind: 'customer_context', input }, [artifact], {
      context,
      adapters,
    });
    expect(outcome.outcome).toBe('unresolved');
    expect(adapters).not.toHaveBeenCalled();
  },
);

it('checks candidate security before an economic veto, and never grants access through readiness', () => {
  const artifact = candidate();
  const contract = defineContextContract({ requirement: 'known', reads });
  const context = { ...localContext(), tenantId: 'different-tenant' };
  expect(
    selectExecution(contract, input, context, {
      candidate: artifact,
      prefetchCostComparison: { pairedRequests: 2, baselineMeanCostUsd: 1, prefetchMeanCostUsd: 2 },
    }),
  ).toMatchObject({ mode: 'denied', reason: 'capability_authorization_denied' });
  expect(
    selectExecution(contract, input, { ...localContext(), scopes: [] }, { candidate: null }).mode,
  ).toBe('denied');
});

it('checks selective readiness without requiring unrelated scopes, then rechecks at execution', async () => {
  const artifact = candidate();
  const contract = defineContextContract({ requirement: 'subset', reads: ['crm.getCustomer'] });
  const context = { ...localContext(), scopes: ['crm:read'] };
  const selection = selectExecution(contract, input, context, { candidate: artifact });
  expect(selection).toMatchObject({ mode: 'compiled_prefetch', resources: ['crm.getCustomer'] });
  artifact.status = 'revoked';
  const adapters = vi.fn(mockAdapters());
  const outcome = await dispatch({ kind: 'customer_context', input }, [artifact], {
    context,
    adapters,
    resources: selection.resources,
  });
  expect(outcome.outcome).toBe('unresolved');
  expect(adapters).not.toHaveBeenCalled();
});

it('does not prefetch a subset whose approved dependency requires an unauthorized read', () => {
  // The sample order plan depends on the customer lookup, despite requesting only orders.
  const contract = defineContextContract({ requirement: 'subset', reads: ['orders.list'] });
  expect(
    selectExecution(
      contract,
      input,
      { ...localContext(), scopes: ['orders:read'] },
      {
        candidate: candidate(),
      },
    ),
  ).toMatchObject({
    mode: 'normal',
    reason: 'capability_guard_miss:resource_selection',
    resources: [],
  });
});
