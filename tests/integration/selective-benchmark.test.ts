import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  developmentCases,
  heldoutCases,
  allReads,
  assessSelective,
  fixturePolicy,
  selectiveArms,
  selectiveInstructions,
  selectivePrompt,
  selectiveResponseSchema,
  selectiveSchedule,
  failedReadStatus,
  type SelectiveCase,
  type SelectiveResponse,
} from '../../scripts/experiments/selective-task.js';
import { routingFixture } from '../../scripts/experiments/routing-task.js';
import {
  CustomerContextAgent,
  executeTool,
  operations,
  tools,
} from '../../scripts/experiments/customer-agent.js';
import { selectExecution } from '../../src/integration/selection.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import {
  authorizeReads,
  localContext,
  type AdapterRunner,
} from '../../src/runtime/adapters/registry.js';
import { DomainError } from '../../src/domain.js';
import type { ReadOperation } from '../../src/compiler/ir.js';

const categories = [
  'customer_only',
  'orders_only',
  'refunds_only',
  'customer_orders',
  'customer_refunds',
  'orders_refunds',
  'complete',
  'agent_decides',
  'no_resource',
  'partial_compiled_failure',
  'quarantined_selective',
  'incompatible_selective',
  'denied',
  'transient_failure',
  'permanent_failure',
  'dependency',
];
const byCategory = (cases: SelectiveCase[], category: string) =>
  cases.find((task) => task.category === category)!;
const reply = (task: SelectiveCase) => {
  const selected = task.expected.orders?.find((o) => o.id === task.expected.selectedOrderId);
  return `Thank you for your message. ${selected ? `Order ${selected.id} is ${selected.daysLate} days late.` : ''} The requested records are summarised above; nothing has been changed.`;
};
const answer = (task: SelectiveCase): SelectiveResponse => ({
  ...task.expected,
  reply: reply(task),
});
type Read = { operation: ReadOperation; status: 'success' | 'failed' };
const ok = (operations: ReadOperation[]): Read[] =>
  operations.map((operation) => ({ operation, status: 'success' }));

describe('frozen selective benchmark plan', () => {
  it('plans every required category on disjoint development and held-out records', () => {
    for (const cases of [developmentCases, heldoutCases])
      expect(cases.map((task) => task.category).sort()).toEqual([...categories].sort());
    const ids = (cases: SelectiveCase[]) => new Set(cases.map((task) => task.customerId));
    expect([...ids(developmentCases)].filter((id) => ids(heldoutCases).has(id))).toEqual([]);
    for (const category of categories)
      if (
        category !== 'dependency' &&
        !category.endsWith('_selective') &&
        !category.endsWith('failure')
      )
        expect(byCategory(developmentCases, category).message).not.toBe(
          byCategory(heldoutCases, category).message,
        );
    expect(selectiveSchedule(developmentCases, 1, 51203).length * selectiveArms.length).toBe(64);
    expect(selectiveSchedule(heldoutCases, 2, 81307).length * selectiveArms.length).toBe(128);
    for (const row of selectiveSchedule(heldoutCases, 2, 81307))
      expect([...row.order].sort()).toEqual([...selectiveArms].sort());
  });
  it('states expected answers that agree with the record snapshot, without reading agents', () => {
    for (const task of [...developmentCases, ...heldoutCases]) {
      const { expected } = task;
      if (expected.eligible !== null)
        expect(expected.eligible).toBe(
          (routingFixture('crm.getCustomer', task.customerId) as { eligible: boolean }).eligible,
        );
      if (expected.orders !== null)
        expect(expected.orders).toEqual(
          (routingFixture('orders.list', task.customerId) as { orders: unknown }).orders,
        );
      if (expected.refunds !== null)
        expect(expected.refunds).toEqual(
          (routingFixture('payments.refundHistory', task.customerId) as { refunds: unknown })
            .refunds,
        );
    }
  });
  it('uses registered contracts and selects identically for unseen records', () => {
    for (const task of developmentCases) {
      const seen = selectExecution(task.contract, { customerId: task.customerId }, localContext());
      const unseen = selectExecution(
        task.contract,
        { customerId: 'C-999' },
        { ...localContext(), allowedCustomerIds: ['C-999'] },
      );
      expect(seen.reason).not.toBe('untrusted_task_metadata');
      expect({ ...unseen, durationMs: 0 }).toEqual({ ...seen, durationMs: 0 });
    }
    const subset = byCategory(developmentCases, 'orders_refunds');
    expect(
      selectExecution(subset.contract, { customerId: subset.customerId }, localContext()),
    ).toMatchObject({
      mode: 'compiled_prefetch',
      resources: ['orders.list', 'payments.refundHistory'],
    });
    expect(
      selectExecution(subset.existingContract, { customerId: subset.customerId }, localContext())
        .mode,
    ).toBe('normal');
  });
});

describe('selective oracle', () => {
  it('accepts a grounded exact answer and permits only approved prerequisites', () => {
    const task = byCategory(developmentCases, 'orders_refunds');
    expect(assessSelective(answer(task), task, ok(task.requiredReads)).passed).toBe(true);
    const dependency = byCategory(developmentCases, 'dependency');
    expect(
      assessSelective(answer(dependency), dependency, ok(['crm.getCustomer', 'orders.list']))
        .passed,
    ).toBe(true);
    const plain = byCategory(developmentCases, 'orders_only');
    expect(
      assessSelective(answer(plain), plain, ok(['crm.getCustomer', 'orders.list'])).checks
        .permittedReads,
    ).toBe(false);
  });
  it('rejects missing evidence, extra fields, failed reads presented as data and wrong decisions', () => {
    const task = byCategory(developmentCases, 'orders_refunds');
    const checks = (response: SelectiveResponse, reads = ok(task.requiredReads)) =>
      assessSelective(response, task, reads).checks;
    expect(checks(answer(task), ok(['orders.list'])).requiredReadsAttempted).toBe(false);
    expect(
      checks(answer(task), [
        { operation: 'orders.list', status: 'success' },
        { operation: 'payments.refundHistory', status: 'failed' },
      ]).evidenceGrounded,
    ).toBe(false);
    expect(checks({ ...answer(task), eligible: true }).exactEvidenceAndDecision).toBe(false);
    expect(checks({ ...answer(task), refunds: null }).exactEvidenceAndDecision).toBe(false);
    expect(checks({ ...answer(task), action: 'human_review' }).exactEvidenceAndDecision).toBe(
      false,
    );
    expect(
      checks({
        ...answer(task),
        reply: 'Your refund has been issued and everything is resolved now.',
      }).noFinancialActionClaim,
    ).toBe(false);
    const permanent = byCategory(developmentCases, 'permanent_failure');
    expect(permanent.expected).toMatchObject({
      action: 'unavailable',
      orders: null,
      refunds: null,
    });
    expect(
      assessSelective(
        {
          ...permanent.expected,
          reply: 'All of your records look fine and nothing else is needed.',
        },
        permanent,
        ok(permanent.requiredReads),
      ).checks.unavailableAcknowledged,
    ).toBe(false);
  });
});

describe('labeled fixture provider', () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-fixture-provider-test-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  async function runFixture(
    task: SelectiveCase,
    options: { supplied?: Partial<Record<ReadOperation, unknown>>; failFirst?: ReadOperation },
  ) {
    const policy = join(directory, `${task.id}.json`);
    writeFileSync(policy, JSON.stringify(fixturePolicy(task)));
    const previous = { ...process.env };
    process.env.FOUNDRY_CODEX_BIN = resolve('scripts/experiments/fixture-provider.mjs');
    process.env.FOUNDRY_FIXTURE_POLICY = policy;
    const context = { ...localContext(), allowedCustomerIds: [task.customerId] };
    const reads: { operation: ReadOperation; status: 'success' | 'failed' }[] = [];
    const attempts = new Map<ReadOperation, number>();
    const adapters: AdapterRunner = async (operation, args, ctx) => {
      authorizeReads(ctx, args, [operation]);
      const attempt = (attempts.get(operation) ?? 0) + 1;
      attempts.set(operation, attempt);
      if (operation === options.failFirst && attempt === 1) {
        reads.push({ operation, status: 'failed' });
        throw new DomainError('Sandbox read unavailable.', 503);
      }
      reads.push({ operation, status: 'success' });
      return routingFixture(operation, args.customerId);
    };
    const agent = new CustomerContextAgent({
      adapters,
      context: () => context,
      agentId: 'fixture-agent',
      timeoutMs: 5000,
      recoverReadFailures: true,
    });
    try {
      await agent.start();
      const reads_ = [...task.contract.reads];
      const run = await agent.runTask({
        input: { customerId: task.customerId },
        observer: new TrajectoryObserver({
          input: { customerId: task.customerId },
          context,
          adapters,
          agentId: 'fixture-agent',
          allowedOperations: reads_,
        }),
        allowedOperations: reads_,
        tools: options.supplied ? [] : tools.filter((t) => reads_.includes(operations[t.name])),
        executeTool,
        prompt: selectivePrompt(
          task,
          options.supplied,
          false,
          reads.some((read) => read.status === 'failed') ? failedReadStatus(reads) : undefined,
        ),
        instructions: selectiveInstructions,
        outputSchema: z.toJSONSchema(selectiveResponseSchema),
        parseResult: (raw) => selectiveResponseSchema.parse(raw),
        complete: (_result, capture) => structuredClone(capture.measurement),
      });
      return { run, reads };
    } finally {
      await agent.close();
      process.env = previous;
    }
  }
  it('answers only from supplied reads without calling tools', async () => {
    const task = byCategory(developmentCases, 'customer_orders');
    const supplied = Object.fromEntries(
      task.requiredReads.map((op) => [op, routingFixture(op, task.customerId)]),
    );
    const { run, reads } = await runFixture(task, { supplied });
    expect(reads).toEqual([]);
    expect(run.measurement.modelCalls).toBe(1);
    expect(assessSelective(run.result, task, ok(task.requiredReads)).passed).toBe(true);
  });
  it('calls the offered tools, retries a recoverable failure once, and reports synthetic usage', async () => {
    const task = byCategory(developmentCases, 'transient_failure');
    const { run, reads } = await runFixture(task, { failFirst: 'payments.refundHistory' });
    expect(reads).toEqual([
      { operation: 'payments.refundHistory', status: 'failed' },
      { operation: 'payments.refundHistory', status: 'success' },
    ]);
    expect(run.measurement.modelCalls).toBe(3);
    expect(run.measurement.totalTokens).toBeGreaterThan(0);
    expect(assessSelective(run.result, task, reads).passed).toBe(true);
    expect(allReads).toContain('payments.refundHistory');
  });
});
