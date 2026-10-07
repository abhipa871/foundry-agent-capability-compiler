import { z } from 'zod';
import { canonical, type ReadOperation } from '../../src/compiler/ir.js';
import { defineContextContract, type ContextContract } from '../../src/integration/selection.js';
import { compiledContextTool, supportPolicy } from './support-task.js';
import { fixtureResult, type RuntimeContext } from '../../src/runtime/adapters/registry.js';
import type { TrajectoryObserver } from '../../src/exploration/observe.js';

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
// Which software a "compiled tool" placement offers. Only the Foundry loader is live capability
// evidence; the partial order summary is a labeled test fixture because context.v1 cannot
// represent a valid partial result.
export type SoftwareSource = 'foundry_context_loader' | 'fixture_partial_order_summary';
export type RoutingCase = {
  id: string;
  category: string;
  customerId: string;
  message: string;
  contract: ContextContract;
  requiredReads: ReadOperation[];
  permittedReads: ReadOperation[];
  // Reads the agent must add itself after a valid software result; hand-stated, never derived.
  followUpReads: ReadOperation[];
  software: SoftwareSource;
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
  'C-111': {
    customerId: 'C-111',
    eligible: true,
    orders: [
      { id: 'O-111', daysLate: 4 },
      { id: 'O-112', daysLate: 10 },
    ],
    refunds: [],
    selectedOrderId: 'O-112',
    action: 'refund_review',
  },
  'C-212': {
    customerId: 'C-212',
    eligible: true,
    orders: [{ id: 'O-212', daysLate: 9 }],
    refunds: [{ id: 'R-212', amount: 15 }],
    selectedOrderId: 'O-212',
    action: 'human_review',
  },
  'C-414': {
    customerId: 'C-414',
    eligible: false,
    orders: [{ id: 'O-414', daysLate: 7 }],
    refunds: [{ id: 'R-414', amount: 12 }],
    selectedOrderId: 'O-414',
    action: 'delivery_support',
  },
  'C-515': {
    customerId: 'C-515',
    eligible: true,
    orders: [
      { id: 'O-515', daysLate: 2 },
      { id: 'O-516', daysLate: 11 },
    ],
    refunds: [{ id: 'R-515', amount: 20 }],
    selectedOrderId: 'O-516',
    action: 'human_review',
  },
};
export const sandboxCustomerIds = ['C-101', 'C-202', 'C-303', ...Object.keys(full)].filter(
  (id, index, all) => all.indexOf(id) === index,
);
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
    software: SoftwareSource = 'foundry_context_loader',
    followUpReads: ReadOperation[] = [],
  ): RoutingCase => ({
    id: `${split}-${category}`,
    category,
    customerId,
    message,
    contract,
    requiredReads,
    permittedReads: [...requiredReads],
    followUpReads,
    software,
    expected,
    fault,
  });
  const [toolCustomer, supplementCustomer] =
    split === 'development' ? ['C-111', 'C-212'] : ['C-414', 'C-515'];
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
    // Case type A: the agent decides whether and when to call the software as a normal tool.
    task(
      'software_tool',
      toolCustomer,
      split === 'development'
        ? 'Handle this inbound support note: "One of my packages still has not arrived. Based on my account, eligibility, orders and any refunds, what should happen next?"'
        : 'Respond to this ticket after checking whatever account records it requires: "My shipment is overdue. Given my account standing, every order and whatever refunds I have had, what is the right next step?"',
      registeredContracts.undecided,
      allReads,
      full[toolCustomer],
    ),
    // Case type B: a valid software result covers eligibility and orders only; the request also
    // needs refund evidence, which the agent must add with an existing typed tool.
    task(
      'software_supplement',
      supplementCustomer,
      split === 'development'
        ? 'Handle this inbound support note: "My order is over a week late. Before you suggest a refund, confirm whether I already received one, check my eligibility and orders, and tell me the next step."'
        : 'Respond to this ticket after checking whatever account records it requires: "My latest order is very late. I think a refund may already have been paid once; please verify that, my eligibility and my orders before recommending anything."',
      registeredContracts.undecided,
      allReads,
      full[supplementCustomer],
      'none',
      'fixture_partial_order_summary',
      ['payments.refundHistory'],
    ),
  ];
}
export const developmentCases = cases('development');
export const heldoutCases = cases('heldout');
export const routingInstructions =
  'You are a read-only customer-support assistant. Interpret the message, retrieve only information it requires, and draft a courteous grounded 50–110 word reply. Original lookup tools can be used individually; the context-loader tool retrieves customer, orders and refunds together, so use it only when all are needed. All tool inputs are bound to the authorized customer. Return JSON: copy required record fields faithfully and set unneeded fields to null. For eligibility-only use eligibility_info; order-delay-only use order_status and select the most delayed order; public policy questions use policy_info. For full review apply the supplied policy. If a required service remains unavailable after one retry, use unavailable with all evidence fields and selectedOrderId null; never assume a failed refund read means no refunds. Read errors do not authorize any other record. Do not issue, approve, guarantee or claim any refund, order change or contact. Include selected order ID and its delay as digits when available. Do not provide private reasoning or separate analysis.';
export const readAttemptsPerRequest = 2;
// The status of every read whose latest attempt failed, including the retry budget it has left.
// A handoff must state what remains permitted; a bare failure count was read as exhausted.
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
export function routingPrompt(
  task: RoutingCase,
  suppliedReads?: unknown,
  failedPrefetch = false,
  serviceStatus?: unknown,
) {
  return `Customer: ${task.customerId}\nMessage: ${task.message}\n${supportPolicy}\n${suppliedReads === undefined ? '' : `Authorized reads already completed (use only fields needed for the message):\n${JSON.stringify(suppliedReads)}\n`}${failedPrefetch ? 'Prefetch was unavailable. Continue with your original authorized lookup tools where appropriate, reusing any valid supplied reads. Never infer missing evidence.\n' : ''}${serviceStatus === undefined ? '' : `Observed read status: ${JSON.stringify(serviceStatus)}. Each read may be attempted at most ${readAttemptsPerRequest} times per request. Retry a required failed read once with its original tool when its retriesRemaining is above 0; when retriesRemaining is 0 its budget is exhausted, so do not retry it.\n`}`;
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
  reads: { operation: ReadOperation; status?: 'success' | 'failed' }[],
) {
  const { reply, ...projection } = response;
  const selected = task.expected.orders?.find((o) => o.id === task.expected.selectedOrderId);
  const succeeded = (operation: ReadOperation) =>
    reads.some((r) => r.operation === operation && (r.status ?? 'success') === 'success');
  const checks = {
    exactEvidenceAndDecision:
      canonical(routingProjection(projection)) === canonical(routingProjection(task.expected)),
    permittedReads: reads.every((r) => task.permittedReads.includes(r.operation)),
    requiredReadsAttempted: task.requiredReads.every((operation) =>
      reads.some((r) => r.operation === operation),
    ),
    // A correct-looking value without a successful read in this request is a guess.
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

// Labeled test fixture for case type B. It is not a Foundry artifact and is never compiled,
// verified or deployed. It reads through the same authorized observer, adapters, schemas and
// snapshot, and fails closed on stale runtime context like the compiled freshness guard.
export const partialSoftwareReads: ReadOperation[] = ['crm.getCustomer', 'orders.list'];
export const partialSoftwareTool = {
  type: 'function',
  name: 'load_order_summary',
  description:
    "Read the authorized customer's eligibility record and all orders using the existing order-summary service. Returns the typed records; no recommendation or reply is generated.",
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};
export async function runPartialSoftware(
  observer: TrajectoryObserver,
  context: RuntimeContext,
  maxAgeMs = 30000,
  now = Date.now(),
) {
  const age = now - context.observedAt;
  if (age < 0 || age > maxAgeMs) return { unavailable: true, reason: 'stale_runtime_context' };
  const [customer, orders] = await Promise.all(
    partialSoftwareReads.map((operation) =>
      observer.read(operation, { source: 'task_input', key: 'customerId' }),
    ),
  );
  return { customer: customer.value, orders: orders.value };
}
export function softwareToolFor(task: RoutingCase) {
  return task.software === 'fixture_partial_order_summary'
    ? partialSoftwareTool
    : compiledContextTool[0];
}
export function softwareReadsFor(task: RoutingCase): ReadOperation[] {
  return task.software === 'fixture_partial_order_summary' ? partialSoftwareReads : allReads;
}

// Per-call accounting for one request. Times are milliseconds from the request start. Providers
// report a response's usage after the tool calls it emitted have started, so a tool call belongs
// to the earliest response completing at or after its start. Per-tool-call tokens are not reported.
export type LedgerToolCall = {
  name: string;
  startedAt: number;
  completedAt: number;
  status: 'success' | 'failed';
};
export type LedgerRead = {
  operation: ReadOperation;
  startedAt: number;
  completedAt: number;
  status: 'success' | 'failed';
};
export type LedgerModelEvent = {
  startMs: number;
  endMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};
export function buildCallLedger(options: {
  task: RoutingCase;
  toolCalls: LedgerToolCall[];
  reads: LedgerRead[];
  modelEvents: LedgerModelEvent[];
  cost: (input: number, cached: number, output: number) => number;
}) {
  const software = softwareToolFor(options.task).name;
  const toolOperation = (name: string): ReadOperation[] =>
    name === software
      ? softwareReadsFor(options.task)
      : Object.hasOwn(toolReads, name)
        ? toolReads[name]
        : [];
  const within = (read: LedgerRead, start: number, end: number) =>
    read.startedAt >= start && read.startedAt <= end;
  const earliestCall = Math.min(...options.toolCalls.map((call) => call.startedAt), Infinity);
  const applicationReads = options.reads.filter(
    (read) =>
      !options.toolCalls.some((call) => within(read, call.startedAt, call.completedAt)) &&
      read.startedAt < earliestCall,
  );
  const successfulBefore = (at: number) =>
    new Set(
      options.reads
        .filter((read) => read.status === 'success' && read.completedAt <= at)
        .map((read) => read.operation),
    );
  const softwareCalled = options.toolCalls.some((call) => call.name === software);
  const calls = options.toolCalls.map((call, index) => {
    const reads = options.reads.filter((read) => within(read, call.startedAt, call.completedAt));
    const known = successfulBefore(call.startedAt);
    const operations = toolOperation(call.name);
    return {
      index,
      name: call.name,
      kind:
        call.name === software
          ? options.task.software === 'fixture_partial_order_summary'
            ? ('fixture_software' as const)
            : ('foundry_software' as const)
          : softwareCalled &&
              options.toolCalls.some(
                (prior) => prior.name === software && prior.startedAt < call.startedAt,
              )
            ? ('follow_up' as const)
            : ('original_tool' as const),
      status: call.status,
      latencyMs: call.completedAt - call.startedAt,
      businessReads: reads.map((read) => ({ operation: read.operation, status: read.status })),
      // Already-returned resources requested again, whether or not a request cache served them.
      redundant: operations.length > 0 && operations.every((operation) => known.has(operation)),
      duplicateSuccessfulReads: reads.filter(
        (read) => read.status === 'success' && known.has(read.operation),
      ).length,
      unnecessaryReads: reads.filter(
        (read) => !options.task.permittedReads.includes(read.operation),
      ).length,
      necessaryFollowUp:
        options.task.followUpReads.length > 0 &&
        operations.some((operation) => options.task.followUpReads.includes(operation)) &&
        !operations.every((operation) => known.has(operation)),
    };
  });
  const sortedModels = [...options.modelEvents].sort((a, b) => a.endMs - b.endMs);
  const responses = sortedModels.map((event, index) => {
    const previous = sortedModels[index - 1]?.endMs ?? -Infinity;
    const known =
      event.inputTokens !== null && event.outputTokens !== null && event.cachedInputTokens !== null;
    return {
      index,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      apiEquivalentCostUsd: known
        ? options.cost(event.inputTokens!, event.cachedInputTokens!, event.outputTokens!)
        : null,
      latencyMs: event.endMs - event.startMs,
      issuedToolCalls: calls
        .filter(
          (call) =>
            options.toolCalls[call.index].startedAt > previous &&
            options.toolCalls[call.index].startedAt <= event.endMs,
        )
        .map((call) => call.index),
    };
  });
  return {
    applicationReads: applicationReads.map((read) => ({
      operation: read.operation,
      status: read.status,
      latencyMs: read.completedAt - read.startedAt,
    })),
    calls,
    responses,
    softwareCalls: calls.filter((call) => call.kind.endsWith('_software')).length,
    followUpCalls: calls.filter((call) => call.kind === 'follow_up').length,
    necessaryFollowUpCalls: calls.filter((call) => call.necessaryFollowUp).length,
    redundantToolCalls: calls.filter((call) => call.redundant).length,
  };
}
const toolReads: Record<string, ReadOperation[]> = {
  lookup_customer: ['crm.getCustomer'],
  lookup_orders: ['orders.list'],
  lookup_refund_history: ['payments.refundHistory'],
};

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
