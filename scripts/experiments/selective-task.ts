import { z } from 'zod';
import { canonical, type ReadOperation } from '../../src/compiler/ir.js';
import { defineContextContract, type ContextContract } from '../../src/integration/selection.js';
import { supportPolicy } from './support-task.js';

// Selective-context benchmark (plan selective-v1). Cases, contracts and expected answers are
// frozen here before any run; nothing in this file is derived from measured results.
export const allReads: ReadOperation[] = [
  'crm.getCustomer',
  'orders.list',
  'payments.refundHistory',
];
export const selectiveResponseSchema = z
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
      'refund_status',
      'records_summary',
      'policy_info',
      'unavailable',
    ]),
    reply: z.string().min(40).max(1600),
  })
  .strict();
export type SelectiveResponse = z.infer<typeof selectiveResponseSchema>;
export type Expected = Omit<SelectiveResponse, 'reply'>;
export type Fault =
  | { kind: 'none' | 'quarantined' | 'stale' | 'denied' }
  | { kind: 'transient' | 'permanent'; operation: ReadOperation };
// Metric groups required by the plan. Fallback rows include every injected compiled-path fault.
export type CaseGroup =
  'healthy_complete' | 'healthy_selective' | 'agent_decided' | 'no_context' | 'fallback' | 'denied';
// `observed` is compiled from the support agent's own traces (independent reads). `dependency`
// is compiled from the repository demo traces, where orders and refunds are read through the
// customer record; it is the only real prerequisite available in this sandbox.
export type ArtifactSource = 'observed' | 'dependency';
export type SelectiveCase = {
  id: string;
  category: string;
  group: CaseGroup;
  customerId: string;
  message: string;
  // The application-registered contract used by the new selector (arm C).
  contract: ContextContract;
  // The same reads under the existing contract vocabulary (arm B; existing SDK behaviour).
  existingContract: ContextContract;
  requiredReads: ReadOperation[];
  permittedReads: ReadOperation[];
  // Reads the approved plan must execute before a requested read; never returned to the agent.
  approvedPrerequisites: ReadOperation[];
  artifact: ArtifactSource;
  fault: Fault;
  expected: Expected;
};

type Record_ = {
  eligible: boolean;
  orders: { id: string; daysLate: number }[];
  refunds: { id: string; amount: number }[];
  selectedOrderId: string;
  reviewAction: 'refund_review' | 'human_review' | 'delivery_support';
};
// Independently hand-stated records and policy outcomes (same synthetic snapshot as the
// support-agent experiment). The oracle never reads adapters or agent output.
const records: Record<string, Record_> = {
  'C-101': {
    eligible: true,
    orders: [{ id: 'O-101', daysLate: 8 }],
    refunds: [],
    selectedOrderId: 'O-101',
    reviewAction: 'refund_review',
  },
  'C-202': {
    eligible: true,
    orders: [
      { id: 'O-202', daysLate: 3 },
      { id: 'O-extra', daysLate: 6 },
    ],
    refunds: [{ id: 'R-202', amount: 5 }],
    selectedOrderId: 'O-extra',
    reviewAction: 'human_review',
  },
  'C-303': {
    eligible: false,
    orders: [
      { id: 'O-303', daysLate: 3 },
      { id: 'O-extra', daysLate: 6 },
    ],
    refunds: [],
    selectedOrderId: 'O-extra',
    reviewAction: 'delivery_support',
  },
  'C-111': {
    eligible: true,
    orders: [
      { id: 'O-111', daysLate: 4 },
      { id: 'O-112', daysLate: 10 },
    ],
    refunds: [],
    selectedOrderId: 'O-112',
    reviewAction: 'refund_review',
  },
  'C-212': {
    eligible: true,
    orders: [{ id: 'O-212', daysLate: 9 }],
    refunds: [{ id: 'R-212', amount: 15 }],
    selectedOrderId: 'O-212',
    reviewAction: 'human_review',
  },
  'C-404': {
    eligible: true,
    orders: [
      { id: 'O-404', daysLate: 12 },
      { id: 'O-405', daysLate: 2 },
    ],
    refunds: [],
    selectedOrderId: 'O-404',
    reviewAction: 'refund_review',
  },
  'C-505': {
    eligible: false,
    orders: [{ id: 'O-505', daysLate: 9 }],
    refunds: [{ id: 'R-505', amount: 10 }],
    selectedOrderId: 'O-505',
    reviewAction: 'delivery_support',
  },
  'C-606': {
    eligible: true,
    orders: [
      { id: 'O-606', daysLate: 5 },
      { id: 'O-607', daysLate: 1 },
    ],
    refunds: [],
    selectedOrderId: 'O-606',
    reviewAction: 'delivery_support',
  },
  'C-414': {
    eligible: false,
    orders: [{ id: 'O-414', daysLate: 7 }],
    refunds: [{ id: 'R-414', amount: 12 }],
    selectedOrderId: 'O-414',
    reviewAction: 'delivery_support',
  },
  'C-515': {
    eligible: true,
    orders: [
      { id: 'O-515', daysLate: 2 },
      { id: 'O-516', daysLate: 11 },
    ],
    refunds: [{ id: 'R-515', amount: 20 }],
    selectedOrderId: 'O-516',
    reviewAction: 'human_review',
  },
};
export const sandboxCustomerIds = Object.keys(records);

const contractCache = new Map<string, ContextContract>();
// Contracts are registered once, in code, by the application; never derived from a prompt.
function registered(requirement: 'known' | 'subset' | 'agent_decides', reads: ReadOperation[]) {
  const key = `${requirement}:${reads.join()}`;
  if (!contractCache.has(key))
    contractCache.set(key, defineContextContract({ requirement, reads }));
  return contractCache.get(key)!;
}
function expectedFor(
  customerId: string,
  reads: ReadOperation[],
  action: Expected['action'],
): Expected {
  const record = records[customerId];
  if (action === 'unavailable' || action === 'policy_info')
    return {
      customerId,
      eligible: null,
      orders: null,
      refunds: null,
      selectedOrderId: null,
      action,
    };
  return {
    customerId,
    eligible: reads.includes('crm.getCustomer') ? record.eligible : null,
    orders: reads.includes('orders.list') ? structuredClone(record.orders) : null,
    refunds: reads.includes('payments.refundHistory') ? structuredClone(record.refunds) : null,
    selectedOrderId: reads.includes('orders.list') ? record.selectedOrderId : null,
    action,
  };
}
const answerAction = (reads: ReadOperation[], customerId: string): Expected['action'] =>
  reads.length === 3
    ? records[customerId].reviewAction
    : reads.length === 2
      ? 'records_summary'
      : reads[0] === 'crm.getCustomer'
        ? 'eligibility_info'
        : reads[0] === 'orders.list'
          ? 'order_status'
          : 'refund_status';

const messages: Record<string, [string, string]> = {
  customer_only: [
    'Tell me only whether my account is currently eligible for delay support.',
    'Please confirm just my account eligibility status; nothing else is needed.',
  ],
  orders_only: [
    'Which of my orders is the most delayed, and by how many days?',
    'Please tell me which order is furthest behind schedule and how many days late it is.',
  ],
  refunds_only: [
    'List every refund already paid on my account, with amounts.',
    'Please show me the complete history of refunds issued to me and their amounts.',
  ],
  customer_orders: [
    'Am I eligible for delay support, and which of my orders is the most delayed?',
    'Please confirm my eligibility and identify my most overdue order with its delay.',
  ],
  customer_refunds: [
    'Am I eligible for delay support, and what refunds have I already received?',
    'Please check my eligibility and list any refunds already paid to me.',
  ],
  orders_refunds: [
    'Show my most delayed order and every refund I have received.',
    'Please identify my most overdue order and list all refunds on my account.',
  ],
  complete: [
    'My delivery is late. Check my eligibility, every order and refund history, recommend the appropriate next step and draft a reply.',
    'Please investigate this delayed delivery and assess the appropriate support response using eligibility, all orders and the complete refund record.',
  ],
  agent_decides: [
    'Read this incoming note and decide what information is needed to answer: "How many days late is my most delayed order? I am not asking about refunds or eligibility."',
    'Interpret this customer email and retrieve only the information needed: "Which of my orders is the most overdue, and by how many days? Please leave payment and eligibility matters aside."',
  ],
  no_resource: [
    'Explain the general delayed-delivery support policy. Do not access any account records.',
    'Draft a general explanation of how delayed delivery support works. This is a public policy question requiring no customer data.',
  ],
};

function cases(split: 'development' | 'heldout'): SelectiveCase[] {
  const ids =
    split === 'development'
      ? { a: 'C-101', b: 'C-202', c: 'C-303', d: 'C-111', e: 'C-212' }
      : { a: 'C-404', b: 'C-505', c: 'C-606', d: 'C-414', e: 'C-515' };
  const wording = split === 'development' ? 0 : 1;
  const C: ReadOperation = 'crm.getCustomer';
  const O: ReadOperation = 'orders.list';
  const R: ReadOperation = 'payments.refundHistory';
  const subset = (
    category: string,
    group: CaseGroup,
    customerId: string,
    message: keyof typeof messages,
    reads: ReadOperation[],
    fault: Fault = { kind: 'none' },
    artifact: ArtifactSource = 'observed',
  ): SelectiveCase => {
    const denied = fault.kind === 'denied';
    const permanent = fault.kind === 'permanent';
    return {
      id: `${split}-${category}`,
      category,
      group,
      customerId,
      message: messages[message][wording],
      contract: registered('subset', reads),
      existingContract: registered('known', reads),
      requiredReads: denied ? [] : [...reads],
      permittedReads: denied ? [] : [...reads],
      approvedPrerequisites: artifact === 'dependency' && !reads.includes(C) ? [C] : [],
      artifact,
      fault,
      expected: expectedFor(
        customerId,
        reads,
        denied || permanent ? 'unavailable' : answerAction(reads, customerId),
      ),
    };
  };
  return [
    subset('customer_only', 'healthy_selective', ids.c, 'customer_only', [C]),
    subset('orders_only', 'healthy_selective', ids.b, 'orders_only', [O]),
    subset('refunds_only', 'healthy_selective', ids.e, 'refunds_only', [R]),
    subset('customer_orders', 'healthy_selective', ids.d, 'customer_orders', [C, O]),
    subset('customer_refunds', 'healthy_selective', ids.b, 'customer_refunds', [C, R]),
    subset('orders_refunds', 'healthy_selective', ids.a, 'orders_refunds', [O, R]),
    subset('complete', 'healthy_complete', ids.e, 'complete', allReads),
    {
      id: `${split}-agent_decides`,
      category: 'agent_decides',
      group: 'agent_decided',
      customerId: ids.c,
      message: messages.agent_decides[wording],
      contract: registered('agent_decides', allReads),
      existingContract: registered('agent_decides', allReads),
      requiredReads: [O],
      permittedReads: [O],
      approvedPrerequisites: [],
      artifact: 'observed',
      fault: { kind: 'none' },
      expected: expectedFor(ids.c, [O], 'order_status'),
    },
    {
      id: `${split}-no_resource`,
      category: 'no_resource',
      group: 'no_context',
      customerId: ids.a,
      message: messages.no_resource[wording],
      contract: registered('known', []),
      existingContract: registered('known', []),
      requiredReads: [],
      permittedReads: [],
      approvedPrerequisites: [],
      artifact: 'observed',
      fault: { kind: 'none' },
      expected: expectedFor(ids.a, [], 'policy_info'),
    },
    subset('partial_compiled_failure', 'fallback', ids.d, 'orders_refunds', [O, R], {
      kind: 'transient',
      operation: R,
    }),
    subset('quarantined_selective', 'fallback', ids.a, 'customer_orders', [C, O], {
      kind: 'quarantined',
    }),
    subset('incompatible_selective', 'fallback', ids.c, 'customer_refunds', [C, R], {
      kind: 'stale',
    }),
    subset('denied', 'denied', ids.b, 'orders_only', [O], { kind: 'denied' }),
    subset('transient_failure', 'fallback', ids.b, 'refunds_only', [R], {
      kind: 'transient',
      operation: R,
    }),
    subset('permanent_failure', 'fallback', ids.e, 'orders_refunds', [O, R], {
      kind: 'permanent',
      operation: R,
    }),
    subset(
      'dependency',
      'healthy_selective',
      ids.d,
      'orders_only',
      [O],
      { kind: 'none' },
      'dependency',
    ),
  ];
}
export const developmentCases = cases('development');
export const heldoutCases = cases('heldout');

export const selectiveInstructions =
  'You are a read-only customer-support assistant. Interpret the message, retrieve only information it requires, and draft a courteous grounded 50–110 word reply. Original lookup tools can be used individually; the context-loader tool retrieves customer, orders and refunds together, so use it only when all are needed. All tool inputs are bound to the authorized customer. Return JSON: copy required record fields faithfully and set unneeded fields to null. Actions: eligibility only uses eligibility_info; most-delayed-order only uses order_status and selects the most delayed order; refund history only uses refund_status; any two of eligibility, orders and refunds uses records_summary (select the most delayed order when orders are included); public policy questions use policy_info; a full review applies the supplied policy. If a required service remains unavailable after one retry, use unavailable and set eligible, orders, refunds and selectedOrderId all to null; never assume a failed refund read means no refunds. Read errors do not authorize any other record. Do not issue, approve, guarantee or claim any refund, order change or contact. Include selected order ID and its delay as digits when available. Do not provide private reasoning or separate analysis.';
export const readAttemptsPerRequest = 2;
export function failedReadStatus(reads: { operation: ReadOperation; status: string }[]) {
  return Object.fromEntries(
    allReads.flatMap((operation) => {
      const attempts = reads.filter((read) => read.operation === operation);
      return attempts.length && attempts[attempts.length - 1].status === 'failed'
        ? [
            [
              operation,
              {
                status: 'failed',
                failedAttempts: attempts.length,
                retriesRemaining: Math.max(0, readAttemptsPerRequest - attempts.length),
              },
            ],
          ]
        : [];
    }),
  );
}
// Marker lines are fixed so the labeled fixture provider can parse supplied reads; live prompts
// use the identical text.
export const suppliedMarker =
  'Authorized reads already completed (use only fields needed for the message):';
export const statusMarker = 'Observed read status:';
export function selectivePrompt(
  task: SelectiveCase,
  suppliedReads?: Partial<Record<ReadOperation, unknown>>,
  failedPrefetch = false,
  serviceStatus?: unknown,
) {
  return `Customer: ${task.customerId}\nMessage: ${task.message}\n${supportPolicy}\n${suppliedReads === undefined ? '' : `${suppliedMarker}\n${JSON.stringify(suppliedReads)}\n`}${failedPrefetch ? 'Prefetch was unavailable. Continue with your original authorized lookup tools where appropriate, reusing any valid supplied reads. Never infer missing evidence.\n' : ''}${serviceStatus === undefined ? '' : `${statusMarker}\n${JSON.stringify(serviceStatus)}\nEach read may be attempted at most ${readAttemptsPerRequest} times per request. Retry a required failed read once with its original tool when its retriesRemaining is above 0; when retriesRemaining is 0 its budget is exhausted, so do not retry it.\n`}`;
}
const sorted = (response: Expected) => ({
  ...response,
  orders: response.orders?.slice().sort((a, b) => a.id.localeCompare(b.id)) ?? null,
  refunds: response.refunds?.slice().sort((a, b) => a.id.localeCompare(b.id)) ?? null,
});
// Same oracle method as the support-agent routing experiment: exact structured evidence and
// action, permitted and required reads, evidence grounded in a successful read in this request,
// reply grounding, unavailable acknowledgement and no financial-action claims.
export function assessSelective(
  response: SelectiveResponse,
  task: SelectiveCase,
  reads: { operation: ReadOperation; status?: 'success' | 'failed' }[],
) {
  const { reply, ...projection } = response;
  const selected = task.expected.orders?.find((o) => o.id === task.expected.selectedOrderId);
  const succeeded = (operation: ReadOperation) =>
    reads.some((r) => r.operation === operation && (r.status ?? 'success') === 'success');
  const allowed = [...task.permittedReads, ...task.approvedPrerequisites];
  const checks = {
    exactEvidenceAndDecision: canonical(sorted(projection)) === canonical(sorted(task.expected)),
    permittedReads: reads.every((r) => allowed.includes(r.operation)),
    requiredReadsAttempted: task.requiredReads.every((operation) =>
      reads.some((r) => r.operation === operation),
    ),
    evidenceGrounded:
      (response.eligible === null || succeeded('crm.getCustomer')) &&
      ((response.orders === null && response.selectedOrderId === null) ||
        succeeded('orders.list')) &&
      (response.refunds === null || succeeded('payments.refundHistory')),
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

export const selectiveArms = [
  'normal',
  'existing_selector_direct',
  'selective_direct',
  'handwritten_selective',
] as const;
export type SelectiveArm = (typeof selectiveArms)[number];
// Randomized Latin rotations; seed retained. Order is never chosen from results.
export function selectiveSchedule(tasks: SelectiveCase[], repeats: number, seed: number) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const permutation: SelectiveArm[] = [...selectiveArms];
  for (let i = permutation.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }
  const shuffled = tasks
    .map((task) => ({ task, random: random() }))
    .sort((a, b) => a.random - b.random)
    .map(({ task }) => task);
  const schedule: { task: SelectiveCase; repeat: number; order: SelectiveArm[] }[] = [];
  for (let repeat = 0; repeat < repeats; repeat++)
    for (let i = 0; i < shuffled.length; i++) {
      const rotation = (i + repeat) % permutation.length;
      schedule.push({
        task: shuffled[i],
        repeat,
        order: [...permutation.slice(rotation), ...permutation.slice(0, rotation)],
      });
    }
  return schedule;
}
// Fixture provider only: which reads the scripted stand-in agent needs. It replaces message
// understanding, not data: the stand-in still derives every answer from reads it received.
export function fixturePolicy(task: SelectiveCase) {
  return {
    neededReads: task.fault.kind === 'denied' ? [] : task.requiredReads,
  };
}
