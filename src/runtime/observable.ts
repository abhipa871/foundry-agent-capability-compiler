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
