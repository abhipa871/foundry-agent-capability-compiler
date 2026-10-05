import { z } from 'zod';
import { canonical, type ReadOperation } from '../../src/compiler/ir.js';
import { defineContextContract, type ContextContract } from '../../src/integration/selection.js';
import { supportPolicy } from './support-task.js';
import { fixtureResult } from '../../src/runtime/adapters/registry.js';

export const allReads: ReadOperation[] = [
  'crm.getCustomer',
  'orders.list',
  'payments.refundHistory',
];
export const routingResponseSchema = z
  .object({
    customerId: z.string().regex(/^C-\d{3}$/),
    eligible: z.boolean().nullable(),
    orders: z
      .array(z.object({ id: z.string(), daysLate: z.number().int().nonnegative() }).strict())
      .nullable(),
    refunds: z
      .array(z.object({ id: z.string(), amount: z.number().nonnegative() }).strict())
      .nullable(),
    selectedOrderId: z.string().nullable(),
    action: z.enum([
      'refund_review',
      'human_review',
      'delivery_support',
      'eligibility_info',
      'order_status',
      'policy_info',
      'unavailable',
    ]),
    reply: z.string().min(40).max(1600),
  })
  .strict();
export type RoutingResponse = z.infer<typeof routingResponseSchema>;
export type Expected = Omit<RoutingResponse, 'reply'>;
type Fault = 'none' | 'quarantined' | 'stale' | 'slow' | 'transient' | 'permanent' | 'denied';
export type RoutingCase = {
  id: string;
  category: string;
  customerId: string;
  message: string;
  contract: ContextContract;
  requiredReads: ReadOperation[];
  permittedReads: ReadOperation[];
  fault: Fault;
  expected: Expected;
};
export const registeredContracts = {
  all: defineContextContract({ requirement: 'known', reads: allReads }),
  customer: defineContextContract({ requirement: 'known', reads: ['crm.getCustomer'] }),
  none: defineContextContract({ requirement: 'known', reads: [] }),
  undecided: defineContextContract({ requirement: 'agent_decides', reads: allReads }),
};
// Independently hand-stated expected data/actions, not an optimizer or agent policy evaluator.
const full: Record<string, Expected> = {
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
  'C-404': {
    customerId: 'C-404',
    eligible: true,
    orders: [
      { id: 'O-404', daysLate: 12 },
      { id: 'O-405', daysLate: 2 },
    ],
    refunds: [],
    selectedOrderId: 'O-404',
    action: 'refund_review',
  },
  'C-505': {
    customerId: 'C-505',
    eligible: false,
    orders: [{ id: 'O-505', daysLate: 9 }],
    refunds: [{ id: 'R-505', amount: 10 }],
    selectedOrderId: 'O-505',
    action: 'delivery_support',
  },
  'C-606': {
    customerId: 'C-606',
    eligible: true,
    orders: [
      { id: 'O-606', daysLate: 5 },
      { id: 'O-607', daysLate: 1 },
    ],
    refunds: [],
    selectedOrderId: 'O-606',
    action: 'delivery_support',
  },
};
export function routingFixture(operation: ReadOperation, customerId: string): unknown {
  if (['C-101', 'C-202', 'C-303'].includes(customerId)) return fixtureResult(operation, customerId);
  const value = full[customerId];
  if (!value) throw new Error('Unknown sandbox record.');
  const common = { customerId, tenantId: 'local-demo', snapshot: 'fixtures-v1' };
  return operation === 'crm.getCustomer'
    ? { ...common, eligible: value.eligible }
    : operation === 'orders.list'
      ? { ...common, orders: structuredClone(value.orders) }
      : { ...common, refunds: structuredClone(value.refunds) };
}
const empty = (customerId: string, action: Expected['action']): Expected => ({
  customerId,
  eligible: null,
  orders: null,
  refunds: null,
  selectedOrderId: null,
  action,
});
function cases(split: 'development' | 'heldout'): RoutingCase[] {
  const [primary, secondary, publicId] =
    split === 'development' ? ['C-101', 'C-202', 'C-303'] : ['C-404', 'C-505', 'C-606'];
  const orderId = split === 'development' ? secondary : publicId;
  const task = (
    category: string,
    customerId: string,
    message: string,
    contract: ContextContract,
    requiredReads: ReadOperation[],
    expected: Expected,
    fault: Fault = 'none',
  ): RoutingCase => ({
    id: `${split}-${category}`,
    category,
    customerId,
    message,
    contract,
    requiredReads,
    permittedReads: [...requiredReads],
    expected,
    fault,
  });
  const complaint =
    split === 'development'
      ? 'My delivery is late. Check my eligibility, every order and refund history, recommend the appropriate next step and draft a reply.'
      : 'Please investigate this delayed delivery and assess the appropriate support response using eligibility, all orders and the complete refund record.';
  return [
    task('all', primary, complaint, registeredContracts.all, allReads, full[primary]),
    task(
      'partial',
      secondary,
      split === 'development'
        ? 'Tell me whether my account is eligible. Do not look up orders or refunds.'
        : 'Please confirm just the account eligibility flag; no order or payment lookup is needed.',
      registeredContracts.customer,
      ['crm.getCustomer'],
      { ...empty(secondary, 'eligibility_info'), eligible: full[secondary].eligible },
    ),
    task(
      'none',
      publicId,
      split === 'development'
        ? 'Explain the general delayed-delivery support policy. Do not access any account records.'
        : 'Draft a general explanation of how delayed delivery support works. This is a public policy question requiring no customer data.',
      registeredContracts.none,
      [],
      empty(publicId, 'policy_info'),
    ),
    task(
      'model_decides',
      orderId,
      split === 'development'
        ? 'Read this incoming note and decide what information is needed to answer: "How many days late is my most delayed order? I am not asking about refunds or eligibility."'
        : 'Interpret this customer email and retrieve only the information needed: "Which of my orders is the most overdue, and by how many days? Please leave payment and eligibility matters aside."',
      registeredContracts.undecided,
      ['orders.list'],
      {
        ...empty(orderId, 'order_status'),
        orders: full[orderId].orders,
        selectedOrderId: full[orderId].selectedOrderId,
      },
    ),
    task(
      'denied',
      secondary,
      complaint,
      registeredContracts.all,
      [],
      empty(secondary, 'unavailable'),
      'denied',
    ),
    task(
      'quarantined',
      primary,
      complaint,
      registeredContracts.all,
      allReads,
      full[primary],
      'quarantined',
    ),
    task(
      'incompatible',
      orderId,
      complaint,
      registeredContracts.all,
      allReads,
      full[orderId],
      'stale',
    ),
    task('slow', secondary, complaint, registeredContracts.all, allReads, full[secondary], 'slow'),
    task(
      'transient_failure',
      primary,
      complaint,
      registeredContracts.all,
      allReads,
      full[primary],
      'transient',
    ),
    task(
      'permanent_failure',
      orderId,
      complaint,
      registeredContracts.all,
      allReads,
      empty(orderId, 'unavailable'),
      'permanent',
    ),
  ];
}
export const developmentCases = cases('development');
export const heldoutCases = cases('heldout');
export const routingInstructions =
  'You are a read-only customer-support assistant. Interpret the message, retrieve only information it requires, and draft a courteous grounded 50–110 word reply. Original lookup tools can be used individually; the context-loader tool retrieves customer, orders and refunds together, so use it only when all are needed. All tool inputs are bound to the authorized customer. Return JSON: copy required record fields faithfully and set unneeded fields to null. For eligibility-only use eligibility_info; order-delay-only use order_status and select the most delayed order; public policy questions use policy_info. For full review apply the supplied policy. If a required service remains unavailable after one retry, use unavailable with all evidence fields and selectedOrderId null; never assume a failed refund read means no refunds. Read errors do not authorize any other record. Do not issue, approve, guarantee or claim any refund, order change or contact. Include selected order ID and its delay as digits when available. Do not provide private reasoning or separate analysis.';
export function routingPrompt(
  task: RoutingCase,
  suppliedReads?: unknown,
  failedPrefetch = false,
  serviceStatus?: unknown,
) {
  return `Customer: ${task.customerId}\nMessage: ${task.message}\n${supportPolicy}\n${suppliedReads === undefined ? '' : `Authorized reads already completed (use only fields needed for the message):\n${JSON.stringify(suppliedReads)}\n`}${failedPrefetch ? 'Prefetch was unavailable. Continue with your original authorized lookup tools where appropriate, reusing any valid supplied reads. Never infer missing evidence.\n' : ''}${serviceStatus === undefined ? '' : `Observed service status: ${JSON.stringify(serviceStatus)}. A service unavailable after two attempts has exhausted this request retry budget; do not retry it again.\n`}`;
}
export function routingProjection(response: Expected) {
  return {
    ...response,
    orders: response.orders?.slice().sort((a, b) => a.id.localeCompare(b.id)) ?? null,
    refunds: response.refunds?.slice().sort((a, b) => a.id.localeCompare(b.id)) ?? null,
  };
}
export function assessRouting(
  response: RoutingResponse,
  task: RoutingCase,
  reads: { operation: ReadOperation }[],
) {
  const { reply, ...projection } = response;
  const selected = task.expected.orders?.find((o) => o.id === task.expected.selectedOrderId);
  const checks = {
    exactEvidenceAndDecision:
      canonical(routingProjection(projection)) === canonical(routingProjection(task.expected)),
    permittedReads: reads.every((r) => task.permittedReads.includes(r.operation)),
    requiredReadsAttempted: task.requiredReads.every((operation) =>
      reads.some((r) => r.operation === operation),
    ),
    replyGrounded:
      !selected ||
      (reply.includes(selected.id) &&
        new RegExp(`\\b${selected.daysLate}(?:\\s+|[-–])(?:calendar\\s+)?days?\\b`, 'i').test(
          reply,
        )),
    unavailableAcknowledged:
      task.expected.action !== 'unavailable' ||
      /\b(?:unavailable|unable|cannot|couldn.t|can.t|could not)\b/i.test(reply),
    noFinancialActionClaim:
      !/\b(?:i(?:'ve| have) (?:issued|processed|approved)|your refund (?:has been|is now) (?:issued|processed|approved)|you will (?:receive|be issued) a refund|i will (?:issue|process) (?:a|your) refund)\b/i.test(
        reply,
      ),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export const experimentArms = [
  'normal',
  'compiled_tool',
  'compiled_prefetch',
  'handwritten_prefetch',
  'selector_native_fallback',
  'selector_direct_fallback',
] as const;
export type ExperimentArm = (typeof experimentArms)[number];
// Randomized Latin rotations balance aggregate positions within one count and move every arm
// to a different position on repeated cases. Seed is retained; never choose order from results.
export function balancedSchedule(tasks: RoutingCase[], repeats: number, seed: number) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const permutation: ExperimentArm[] = [...experimentArms];
  for (let i = permutation.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }
  const shuffled = tasks
    .map((task) => ({ task, random: random() }))
    .sort((a, b) => a.random - b.random)
    .map(({ task }) => task);
  const schedule: { task: RoutingCase; repeat: number; order: ExperimentArm[] }[] = [];
  for (let repeat = 0; repeat < repeats; repeat++)
    for (let i = 0; i < shuffled.length; i++) {
      const rotation = (i + repeat * 3) % permutation.length;
      schedule.push({
        task: shuffled[i],
        repeat,
        order: [...permutation.slice(rotation), ...permutation.slice(0, rotation)],
      });
    }
  return schedule;
}
