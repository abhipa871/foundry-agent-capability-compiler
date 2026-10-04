import { canonical } from '../compiler/ir.js';
import { contracts } from './adapters/registry.js';
import { z } from 'zod';
import { DomainError } from '../domain.js';
import { observableResultSchema, type ObservableResult } from '../exploration/tool-events.js';

const contextSchema = z
  .object({
    customer_id: z.string(),
    crm_get_customer: z.object({ customerId: z.string(), eligible: z.boolean() }).loose(),
    orders_list: z.object({ orders: z.array(z.object({ id: z.string() }).loose()) }).loose(),
    payments_refund_history: z
      .object({ refunds: z.array(z.object({ amount: z.number() }).loose()) })
      .loose(),
  })
  .loose();

// The comparable projection of a run: what a reviewer can hold the compiled path and the agent
// path to. Call order, adapter latency and wording are deliberately not part of it.
export function normalizeObservable(result: unknown): ObservableResult {
  const parsed = contextSchema.safeParse(result);
  if (!parsed.success) throw new DomainError('Compiled output does not satisfy context.v1.', 409);
  const context = parsed.data;
  return observableResultSchema.parse({
    customerId: context.customer_id,
    eligible: context.crm_get_customer.eligible,
    orderCount: context.orders_list.orders.length,
    refundCount: context.payments_refund_history.refunds.length,
    refundTotal:
      Math.round(
        context.payments_refund_history.refunds.reduce((sum, refund) => sum + refund.amount, 0) *
          100,
      ) / 100,
  });
}

export const fullContextSchema = z
  .object({
    customer_id: z.string().regex(/^C-\d{3}$/),
    crm_get_customer: contracts['crm.getCustomer'].output,
    orders_list: contracts['orders.list'].output,
    payments_refund_history: contracts['payments.refundHistory'].output,
  })
  .strict();

export function contextProjection(raw: unknown) {
  const parsed = fullContextSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError('Output does not satisfy full context.v1.', 409);
  const value = parsed.data;
  const components = [value.crm_get_customer, value.orders_list, value.payments_refund_history];
  if (
    components.some(
      (part) =>
        part.customerId !== value.customer_id ||
        part.tenantId !== value.crm_get_customer.tenantId ||
        part.snapshot !== value.crm_get_customer.snapshot,
    )
  )
    throw new DomainError('Context identity mismatch.', 409);
  const orders = [...value.orders_list.orders].sort((a, b) => a.id.localeCompare(b.id));
  const refunds = [...value.payments_refund_history.refunds].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (
    new Set(orders.map((entry) => entry.id)).size !== orders.length ||
    new Set(refunds.map((entry) => entry.id)).size !== refunds.length
  )
    throw new DomainError('Duplicate context resource identity.', 409);
  return {
    ...value,
    orders_list: { ...value.orders_list, orders },
    payments_refund_history: { ...value.payments_refund_history, refunds },
  };
}
export function sameContext(a: unknown, b: unknown): boolean {
  return canonical(contextProjection(a)) === canonical(contextProjection(b));
}
