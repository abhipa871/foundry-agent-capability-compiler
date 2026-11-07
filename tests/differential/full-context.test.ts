import { expect, it } from 'vitest';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { emitArtifact } from '../../src/compiler/emit.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import { fixtureResult, localContext } from '../../src/runtime/adapters/registry.js';
import { sameContext } from '../../src/runtime/observable.js';
import { interpret, DeoptimizationError } from '../../src/runtime/interpret.js';
import { verifyIR } from '../../src/verification/verify-ir.js';

const traces = () => sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo'));
it('detects wrong resource identities and values even when aggregate counts and totals match', () => {
  const context = {
    customer_id: 'C-202',
    crm_get_customer: fixtureResult('crm.getCustomer', 'C-202'),
    orders_list: fixtureResult('orders.list', 'C-202'),
    payments_refund_history: fixtureResult('payments.refundHistory', 'C-202'),
  };
  const changed = structuredClone(context) as typeof context & {
    orders_list: { orders: { id: string; daysLate: number }[] };
  };
  changed.orders_list.orders[0].id = 'wrong';
  expect(sameContext(context, changed)).toBe(false);
  changed.orders_list.orders[0].id = 'O-202';
  changed.orders_list.orders[0].daysLate = 9;
  expect(sameContext(context, changed)).toBe(false);
  changed.orders_list.orders[0].daysLate = 3;
  changed.orders_list.orders.reverse();
  expect(sameContext(context, changed)).toBe(true);
});
it('fails validation when supporting evidence was deleted', async () => {
  const stored = traces();
  const { ir, report } = compileIR(stored);
  const checks = await verifyIR(emitArtifact(ir, report, { version: 1 }), [stored[0]]);
  expect(checks.find((check) => check.name.startsWith('Complete supporting'))?.passed).toBe(false);
});
it('rejects inaccurate reference lineage before compilation', () => {
  const stored = traces();
  stored[1].events.find((event) => event.operation === 'orders.list')!.args.customerId.value =
    'C-303';
  expect(() => compileIR(stored)).toThrow(/diverged/);
});
it('bounds waiting on adapters that ignore cancellation, retaining attempted calls', async () => {
  const { ir } = compileIR(traces(), { timeoutMs: 15 });
  const error = await interpret(
    ir,
    { customerId: 'C-101' },
    {
      context: localContext(),
      adapters: () => new Promise(() => {}),
    },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DeoptimizationError);
  const detail = (error as DeoptimizationError).detail;
  expect(detail.status).toBe(504);
  expect(detail.adapterCalls).toBe(1);
  expect(detail.completedNodeIds).toEqual([]);
});
