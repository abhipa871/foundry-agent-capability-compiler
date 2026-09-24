import { describe, expect, it } from 'vitest';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { validateIR, type CapabilityIR } from '../../src/compiler/ir.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import { DeoptimizationError, interpret } from '../../src/runtime/interpret.js';

const traces = () => sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo'));
const plan = () => compileIR(traces()).ir;
const run = (
  ir: CapabilityIR,
  customerId: string,
  options: Parameters<typeof mockAdapters>[0] = {},
  context: Partial<ReturnType<typeof localContext>> = {},
) =>
  interpret(
    ir,
    { customerId },
    {
      adapters: mockAdapters(options),
      context: { ...localContext(), ...context },
    },
  );

describe('compiled IR interpreter', () => {
  it('executes the same artifact for two customers with no model invocation', async () => {
    const ir = plan();
    const first = await run(ir, 'C-101');
    const second = await run(ir, 'C-202');

    expect(first.llmInvocations).toBe(0);
    expect(second.llmInvocations).toBe(0);
    expect(first.observable).toEqual({
      customerId: 'C-101',
      eligible: true,
      orderCount: 1,
      refundCount: 0,
      refundTotal: 0,
    });
    expect(second.observable).toEqual({
      customerId: 'C-202',
      eligible: true,
      orderCount: 2,
      refundCount: 1,
      refundTotal: 5,
    });
    expect(first.executedNodeIds).toContain('context');
  });

  it('runs two different IR plans to two different results', async () => {
    const full = plan();
    const reduced = validateIR({
      ...full,
      nodes: full.nodes
        .filter((node) => node.id !== 'payments_refund_history')
        .map((node) =>
          node.id === 'context'
            ? {
                ...node,
                args: Object.fromEntries(
                  Object.entries(node.args).filter(([key]) => key !== 'payments_refund_history'),
                ),
                deps: node.deps.filter((dep) => dep !== 'payments_refund_history'),
              }
            : node,
        ),
      adapterVersions: { 'crm.getCustomer': '1', 'orders.list': '1' },
      requiredScopes: ['crm:read', 'orders:read'],
    });

    const complete = await run(full, 'C-202');
    await expect(run(reduced, 'C-202')).rejects.toThrow(/context\.v1/);
    expect(complete.adapterCalls).toBe(3);
    expect(reduced.nodes).toHaveLength(3);
  });

  it('executes independent reads concurrently under the compiled limit', async () => {
    const ir = plan();
    const parallel = await run(ir, 'C-101', { delayMs: 40 });
    const sequential = await run({ ...ir, concurrency: 1 }, 'C-101', { delayMs: 40 });

    expect(parallel.peakParallel).toBe(2);
    expect(sequential.peakParallel).toBe(1);
    expect(parallel.durationMs).toBeLessThan(sequential.durationMs);
    expect(parallel.observable).toEqual(sequential.observable);
  });

  it('calls each compiled read exactly once', async () => {
    const calls: string[] = [];
    await interpret(
      plan(),
      { customerId: 'C-101' },
      {
        adapters: mockAdapters({ onCall: (operation) => calls.push(operation) }),
        context: localContext(),
      },
    );

    expect(calls.sort()).toEqual(['crm.getCustomer', 'orders.list', 'payments.refundHistory']);
  });

  it('rejects input outside the compiled schema', async () => {
    await expect(
      interpret(
        plan(),
        { customerId: 'C-1' },
        {
          adapters: mockAdapters(),
          context: localContext(),
        },
      ),
    ).rejects.toThrow();
  });

  it('denies execution when the caller is missing a required scope', async () => {
    await expect(run(plan(), 'C-101', {}, { scopes: ['crm:read'] })).rejects.toThrow(
      /Missing scope/,
    );
  });

  it('fails closed on adapter drift', async () => {
    const context = localContext();
    await expect(
      run(
        plan(),
        'C-101',
        {},
        {
          adapterVersions: { ...context.adapterVersions, 'orders.list': '2' },
        },
      ),
    ).rejects.toThrow(/drift/i);
  });

  it('fails closed on a read timeout', async () => {
    await expect(
      run({ ...plan(), timeoutMs: 40 }, 'C-101', {
        fault: 'timeout',
        faultOperation: 'orders.list',
      }),
    ).rejects.toThrow(/abort/i);
  });

  it('rejects a response for a different customer', async () => {
    await expect(run(plan(), 'C-101', { fault: 'wrong_customer' })).rejects.toThrow(
      /customer_id_matches/,
    );
  });

  it('deoptimizes with a checkpoint instead of a partial result on an unsupported customer', async () => {
    const error = await run(plan(), 'C-404').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeoptimizationError);
    const deopt = error as DeoptimizationError;
    expect(deopt.detail.reason).toBe('unsupported_state');
    expect(deopt.detail.completedNodeIds).toEqual([]);
    expect(deopt.detail.nextNodeIds).toContain('context');
  });

  it('carries completed node values into the checkpoint when a later read fails', async () => {
    const error = await run(plan(), 'C-101', {
      fault: 'malformed',
      faultOperation: 'payments.refundHistory',
    }).catch((caught: unknown) => caught);

    const deopt = error as DeoptimizationError;
    expect(deopt.detail.completedNodeIds).toContain('crm_get_customer');
    expect(deopt.detail.completedNodeIds).not.toContain('payments_refund_history');
    expect(deopt.detail.liveValues.crm_get_customer).toMatchObject({ customerId: 'C-101' });
  });
});
