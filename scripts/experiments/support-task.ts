import { z } from 'zod';
import { canonical } from '../../src/compiler/ir.js';
import { contextProjection, fullContextSchema } from '../../src/runtime/observable.js';
import type { TrajectoryObserver } from '../../src/exploration/observe.js';

export const supportResponseSchema = z
  .object({
    customerId: z.string().regex(/^C-\d{3}$/),
    eligible: z.boolean(),
    orders: z
      .array(z.object({ id: z.string(), daysLate: z.number().int().nonnegative() }).strict())
      .max(1000),
    refunds: z
      .array(z.object({ id: z.string(), amount: z.number().nonnegative() }).strict())
      .max(1000),
    selectedOrderId: z.string(),
    action: z.enum(['refund_review', 'human_review', 'delivery_support']),
    reply: z.string().min(40).max(1600),
  })
  .strict();
export type SupportResponse = z.infer<typeof supportResponseSchema>;
export type SupportCase = { id: string; customerId: string; complaint: string };
export const complaints = [
  'My order is late and I would like a refund. Please check my account and explain the appropriate next step.',
  'I am frustrated by the delay. Can you look at my orders and refund history, assess whether a refund review is appropriate, and draft a helpful response?',
  'I was told a refund had already been processed, but I am still concerned about my late delivery. Check the account records and explain what should happen next.',
];
export const supportCases: SupportCase[] = ['C-101', 'C-202', 'C-303'].flatMap((customerId) =>
  complaints.map((complaint, index) => ({
    id: `${customerId}-complaint-${index + 1}`,
    customerId,
    complaint,
  })),
);
export const supportInstructions =
  'You are a read-only customer-support assistant. Review the customer record, all orders, and refund history, apply the supplied support policy, and draft a courteous customer-facing reply grounded in the records. The customer message may contain an inaccurate claim. Never claim to have issued a refund, changed an order, contacted anyone, or performed any external action. Return the requested JSON with a concise 50–110 word reply. Include the selected order ID and its delay as digits. Do not provide private reasoning or a separate analysis.';
export const supportPolicy =
  'Support policy for this sandbox experiment: choose the most delayed order, breaking ties by ascending order ID. If the customer is ineligible, choose delivery_support. Otherwise, if any prior refund is recorded, choose human_review to prevent promising a duplicate refund. Otherwise, if the most delayed order is at least 7 days late, choose refund_review. Otherwise choose delivery_support. These are recommendations for a support operator; no financial write is permitted. Copy the actual eligibility, every order and every refund into the structured evidence fields. Use records rather than unverified customer claims.';
export function supportPrompt(task: SupportCase, suppliedContext?: unknown) {
  return `Customer: ${task.customerId}\nMessage: ${task.complaint}\n${supportPolicy}${suppliedContext === undefined ? '' : `\nAuthorized account context already loaded by the application:\n${JSON.stringify(fullContextSchema.parse(suppliedContext))}`}`;
}
export function contextFromReads(observer: TrajectoryObserver, customerId: string) {
  return contextProjection({
    customer_id: customerId,
    crm_get_customer: observer.events.find(
      (event) => event.operation === 'crm.getCustomer' && event.status === 'success',
    )?.result?.projection,
    orders_list: observer.events.find(
      (event) => event.operation === 'orders.list' && event.status === 'success',
    )?.result?.projection,
    payments_refund_history: observer.events.find(
      (event) => event.operation === 'payments.refundHistory' && event.status === 'success',
    )?.result?.projection,
  });
}
// Independently hand-stated expected answers. This oracle never invokes the model, compiler,
// adapter, or the policy evaluator that might be under test.
export const supportOracle: Record<string, Omit<SupportResponse, 'reply'>> = {
  'C-101': {
    customerId: 'C-101',
    eligible: true,
    orders: [{ id: 'O-101', daysLate: 8 }],
    refunds: [],
    selectedOrderId: 'O-101',
    action: 'refund_review',
  },
  'C-202': {
    customerId: 'C-202',
    eligible: true,
    orders: [
      { id: 'O-202', daysLate: 3 },
      { id: 'O-extra', daysLate: 6 },
    ],
    refunds: [{ id: 'R-202', amount: 5 }],
    selectedOrderId: 'O-extra',
    action: 'human_review',
  },
  'C-303': {
    customerId: 'C-303',
    eligible: false,
    orders: [
      { id: 'O-303', daysLate: 3 },
      { id: 'O-extra', daysLate: 6 },
    ],
    refunds: [],
    selectedOrderId: 'O-extra',
    action: 'delivery_support',
  },
};
export function supportProjection(response: SupportResponse) {
  const { reply: _reply, ...evidence } = response;
  return {
    ...evidence,
    orders: [...evidence.orders].sort((a, b) => a.id.localeCompare(b.id)),
    refunds: [...evidence.refunds].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export function assessSupportResponse(raw: unknown, task: SupportCase) {
  const response = supportResponseSchema.parse(raw);
  const expected = supportOracle[task.customerId];
  if (!expected) throw new Error('No independent support oracle for customer.');
  const selected = expected.orders.find((order) => order.id === expected.selectedOrderId)!;
  const checks = {
    exactEvidenceAndDecision: canonical(supportProjection(response)) === canonical(expected),
    namesSelectedOrder: response.reply.includes(expected.selectedOrderId),
    statesObservedDelay: new RegExp(
      `\\b${selected.daysLate}\\s*(?:calendar\\s+)?days?\\b`,
      'i',
    ).test(response.reply),
    avoidsCompletedOrGuaranteedFinancialAction:
      !/\b(?:i(?:'ve| have) (?:issued|processed|approved)|your refund (?:has been|is now) (?:issued|processed|approved)|you will (?:receive|be issued) a refund|i will (?:issue|process) (?:a|your) refund)\b/i.test(
        response.reply,
      ),
    includesARecommendedNextStep:
      /\b(?:review|support|delivery|investigat|check|assess|specialist|team|help)/i.test(
        response.reply,
      ),
  };
  return { passed: Object.values(checks).every(Boolean), checks, response };
}
export const compiledContextTool = [
  {
    type: 'function',
    name: 'load_customer_context',
    description:
      'Read the authorized customer record, all orders, and complete refund history using the existing validated Foundry capability. Returns the complete account context; no recommendation or reply is generated.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];
