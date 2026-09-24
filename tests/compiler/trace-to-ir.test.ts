import { describe, expect, it } from 'vitest';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { irDigest, validateIR } from '../../src/compiler/ir.js';
import { buildProvenance } from '../../src/exploration/provenance.js';
import { sampleToolTraceA, sampleToolTraceB } from '../../src/exploration/sample-traces.js';
import { captureToolTrace, type ToolTrace } from '../../src/exploration/tool-events.js';

const capture = (trace: ToolTrace) => captureToolTrace(trace, 'demo');
const traces = () => [capture(sampleToolTraceA), capture(sampleToolTraceB)];

describe('trace to IR compilation', () => {
  it('derives a parameterized plan from two traces instead of loading a fixed workflow', () => {
    const { ir, report } = compileIR(traces());

    expect(ir.nodes.map((node) => node.id)).toEqual([
      'crm_get_customer',
      'orders_list',
      'payments_refund_history',
      'context',
    ]);
    const entry = ir.nodes.find((node) => node.id === 'crm_get_customer');
    expect(entry?.args.customerId).toEqual({ kind: 'input', key: 'customerId' });
    expect(report.parameters.find((p) => p.arg === 'crm_get_customer.customerId')).toMatchObject({
      binding: 'input',
    });
    expect(report.supportingTraceIds).toHaveLength(2);
    expect(validateIR(ir).name).toBe('load_customer_context');
  });

  it('reconstructs dataflow from value references, not span lineage or wall-clock order', () => {
    const graph = buildProvenance(capture(sampleToolTraceA));
    const orders = graph.nodes.find((node) => node.operation === 'orders.list')!;
    const customer = graph.nodes.find((node) => node.operation === 'crm.getCustomer')!;

    // The captured span parent of orders.list is the failed legacy search, not its data producer.
    expect(orders.dataDeps).toEqual([customer.eventId]);
    expect(graph.nodes.find((node) => node.operation === 'legacy_crm.search')?.supported).toBe(
      false,
    );
  });

  it('produces the same dependency graph when the traces record a different call order', () => {
    const forward = compileIR(traces());
    const reversed = compileIR([...traces()].reverse());

    expect(deps(reversed.ir)).toEqual(deps(forward.ir));
    expect(reversed.report.signature).toBe(forward.report.signature);
  });

  it('keeps failed and skipped branches as exception evidence rather than deleting them', () => {
    const { ir, report } = compileIR(traces());

    expect(ir.provenance.exceptionEventIds).toHaveLength(2);
    expect(report.prunedEvents.map((event) => event.operation).sort()).toEqual([
      'legacy_crm.search',
      'notes.draftSummary',
    ]);
    expect(
      ir.nodes.some((node) => node.opcode === 'adapter.read' && node.operation.includes('legacy')),
    ).toBe(false);
  });

  it('eliminates a duplicate read and parallelizes the independent reads', () => {
    const { ir } = compileIR(traces());

    expect(ir.nodes.filter((node) => node.opcode === 'adapter.read')).toHaveLength(3);
    expect(ir.concurrency).toBe(2);
    expect(ir.optimizations.join(' ')).toContain('eliminated 1 duplicate read');
    expect(ir.optimizations.join(' ')).toContain('parallelized 2 independent reads');
  });

  it('refuses to coalesce duplicate reads taken outside the freshness window', () => {
    expect(() => compileIR(traces(), { freshnessMs: 100 })).toThrowError(/freshness window/);
  });

  it('refuses to compile from a single trace', () => {
    expect(() => compileIR([capture(sampleToolTraceA)])).toThrowError(/at least two/);
  });

  it('refuses to compile when the traces share no normalized structure', () => {
    const divergent = capture({
      ...sampleToolTraceB,
      events: sampleToolTraceB.events.filter((event) => event.operation !== 'orders.list'),
      finalEventId: undefined,
      observableResult: { ...sampleToolTraceB.observableResult, orderCount: 0 },
    });

    expect(() => compileIR([capture(sampleToolTraceA), divergent])).toThrowError(
      /do not share a normalized structure/,
    );
  });

  it('rejects a customer id that claims task-input lineage but diverges from the task input', () => {
    const tampered = capture({
      ...sampleToolTraceB,
      events: sampleToolTraceB.events.map((event) =>
        event.operation === 'crm.getCustomer'
          ? {
              ...event,
              args: {
                customerId: {
                  source: 'task_input' as const,
                  key: 'customerId' as const,
                  value: 'C-303',
                },
              },
            }
          : event,
      ),
    });

    expect(() => compileIR([capture(sampleToolTraceA), tampered])).toThrowError(/diverged/);
  });

  it('pins adapter versions and derives scopes from the compiled reads', () => {
    const { ir } = compileIR(traces());

    expect(ir.adapterVersions).toEqual({
      'crm.getCustomer': '1',
      'orders.list': '1',
      'payments.refundHistory': '1',
    });
    expect(ir.requiredScopes).toEqual(['crm:read', 'orders:read', 'payments:read']);
    expect(ir.invariants).toEqual(['customer_id_matches', 'tenant_matches', 'snapshot_matches']);
  });

  it('gives the same IR a stable digest and a different one after any mutation', () => {
    const { ir } = compileIR(traces());
    const again = compileIR(traces()).ir;

    expect(irDigest(again)).toBe(irDigest(ir));
    expect(irDigest({ ...ir, concurrency: 1 })).not.toBe(irDigest(ir));
  });
});

function deps(ir: { nodes: { id: string; deps: string[] }[] }) {
  return ir.nodes.map((node) => `${node.id}<-${[...node.deps].sort().join(',')}`).sort();
}
