import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  allReads,
  assessRouting,
  balancedSchedule,
  buildCallLedger,
  developmentCases,
  experimentArms,
  heldoutCases,
  partialSoftwareReads,
  partialSoftwareTool,
  routingFixture,
  routingResponseSchema,
  runPartialSoftware,
  softwareToolFor,
  type LedgerToolCall,
  type RoutingCase,
  type RoutingResponse,
} from '../../scripts/experiments/routing-task.js';
import {
  CustomerContextAgent,
  apiEquivalentCost,
  executeTool,
  tools,
} from '../../scripts/experiments/customer-agent.js';
import { selectExecution } from '../../src/integration/selection.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import {
  authorizeReads,
  localContext,
  type AdapterRunner,
  type RuntimeContext,
} from '../../src/runtime/adapters/registry.js';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import type { ReadOperation } from '../../src/compiler/ir.js';

const fake = vi.hoisted(() => ({ spawn: undefined as undefined | (() => unknown) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: () => fake.spawn!(),
}));
afterEach(() => {
  fake.spawn = undefined;
});

const byCategory = (cases: RoutingCase[], category: string) =>
  cases.find((task) => task.category === category)!;
const context = (customerId: string, overrides: Partial<RuntimeContext> = {}): RuntimeContext => ({
  ...localContext(),
  allowedCustomerIds: [customerId],
  ...overrides,
});
function countingAdapters(log: ReadOperation[]): AdapterRunner {
  return async (operation, args, ctx) => {
    authorizeReads(ctx, args, [operation]);
    log.push(operation);
    return routingFixture(operation, args.customerId);
  };
}

it('plans 12 development and 12 held-out cases: 72 and 144 measured requests across six arms', () => {
  for (const cases of [developmentCases, heldoutCases]) {
    expect(cases).toHaveLength(12);
    expect(cases.map((task) => task.category)).toEqual(
      expect.arrayContaining(['software_tool', 'software_supplement']),
    );
  }
  expect(balancedSchedule(developmentCases, 1, 41107).length * experimentArms.length).toBe(72);
  expect(balancedSchedule(heldoutCases, 2, 71109).length * experimentArms.length).toBe(144);
  for (const category of ['software_tool', 'software_supplement']) {
    const development = byCategory(developmentCases, category);
    const heldout = byCategory(heldoutCases, category);
    expect(heldout.customerId).not.toBe(development.customerId);
    expect(developmentCases.some((task) => task.customerId === heldout.customerId)).toBe(false);
    expect(heldout.message).not.toBe(development.message);
  }
});

it('defines both new case types with independent oracles, evidence and permitted reads', () => {
  for (const cases of [developmentCases, heldoutCases]) {
    const tool = byCategory(cases, 'software_tool');
    expect(tool.software).toBe('foundry_context_loader');
    expect(tool.contract.requirement).toBe('agent_decides');
    expect(tool.requiredReads).toEqual(allReads);
    expect(tool.followUpReads).toEqual([]);
    expect(tool.expected.action).not.toBe('unavailable');

    const supplement = byCategory(cases, 'software_supplement');
    expect(supplement.software).toBe('fixture_partial_order_summary');
    expect(supplement.contract.requirement).toBe('agent_decides');
    expect(supplement.followUpReads).toEqual(['payments.refundHistory']);
    expect(new Set([...partialSoftwareReads, ...supplement.followUpReads])).toEqual(
      new Set(supplement.requiredReads),
    );
    // The missing fact changes the answer, so presenting partial output as complete is wrong.
    expect(supplement.expected.refunds!.length).toBeGreaterThan(0);
    expect(supplement.expected.action).toBe('human_review');
    expect(softwareToolFor(supplement).name).toBe(partialSoftwareTool.name);
  }
});

it('selects the software as an agent tool for undecided contracts and keeps denial terminal', () => {
  const task = byCategory(developmentCases, 'software_tool');
  const offered = selectExecution(
    task.contract,
    { customerId: task.customerId },
    context(task.customerId),
  );
  expect(offered).toMatchObject({
    mode: 'compiled_tool',
    reason: 'agent_must_decide_whether_context_is_needed',
  });
  expect(offered.durationMs).toBeGreaterThanOrEqual(0);
  expect(
    selectExecution(
      task.contract,
      { customerId: task.customerId },
      context(task.customerId, { allowedCustomerIds: [] }),
    ).mode,
  ).toBe('denied');
});

it('rejects guessed or partial evidence presented as a complete answer', () => {
  const task = byCategory(developmentCases, 'software_supplement');
  const response: RoutingResponse = {
    ...task.expected,
    reply: `Order ${task.expected.selectedOrderId} is ${task.expected.orders![0].daysLate} days late. A prior refund is on record, so a specialist will review next steps.`,
  };
  const read = (operation: ReadOperation, status: 'success' | 'failed' = 'success') => ({
    operation,
    status,
  });
  const complete = allReads.map((operation) => read(operation));
  expect(assessRouting(response, task, complete).passed).toBe(true);
  // Correct-looking refund evidence without a successful refund read is a guess.
  const withoutRefund = [read('crm.getCustomer'), read('orders.list')];
  expect(assessRouting(response, task, withoutRefund).checks.evidenceGrounded).toBe(false);
  expect(
    assessRouting(response, task, [...withoutRefund, read('payments.refundHistory', 'failed')])
      .checks.evidenceGrounded,
  ).toBe(false);
  // Treating the software result as complete changes evidence and the recommended action.
  const partialAsComplete = { ...response, refunds: [], action: 'refund_review' as const };
  expect(assessRouting(partialAsComplete, task, withoutRefund).passed).toBe(false);
});

it('runs the labeled partial software through the same authorization, identity and freshness checks', async () => {
  const task = byCategory(developmentCases, 'software_supplement');
  const reads: ReadOperation[] = [];
  const ctx = context(task.customerId);
  const observer = new TrajectoryObserver({
    input: { customerId: task.customerId },
    context: ctx,
    adapters: countingAdapters(reads),
    agentId: 'fixture-agent',
    allowedOperations: allReads,
  });
  const result = (await runPartialSoftware(observer, ctx)) as Record<string, unknown>;
  expect(Object.keys(result).sort()).toEqual(['customer', 'orders']);
  expect(reads.sort()).toEqual([...partialSoftwareReads].sort());

  const staleReads: ReadOperation[] = [];
  const stale = context(task.customerId, { observedAt: Date.now() - 60000 });
  const staleObserver = new TrajectoryObserver({
    input: { customerId: task.customerId },
    context: stale,
    adapters: countingAdapters(staleReads),
    agentId: 'fixture-agent',
    allowedOperations: allReads,
  });
  expect(await runPartialSoftware(staleObserver, stale)).toEqual({
    unavailable: true,
    reason: 'stale_runtime_context',
  });
  expect(staleReads).toEqual([]);

  const deniedReads: ReadOperation[] = [];
  const denied = context(task.customerId, { allowedCustomerIds: [] });
  const deniedObserver = new TrajectoryObserver({
    input: { customerId: task.customerId },
    context: denied,
    adapters: countingAdapters(deniedReads),
    agentId: 'fixture-agent',
    allowedOperations: allReads,
  });
  await expect(runPartialSoftware(deniedObserver, denied)).rejects.toMatchObject({ status: 403 });
  expect(deniedReads).toEqual([]);
});

it('leaves the compiled capability family unchanged: it still reads every context resource', () => {
  const { ir } = compileIR(sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo')));
  const operations = ir.nodes.flatMap((node) =>
    node.opcode === 'adapter.read' ? [node.operation] : [],
  );
  expect(new Set(operations)).toEqual(new Set(allReads));
  expect(ir.outputsSchemaId).toBe('context.v1');
});

it('records the software call, each follow-up and redundant reads separately with response costs', () => {
  const task = byCategory(developmentCases, 'software_supplement');
  const ledger = buildCallLedger({
    task,
    toolCalls: [
      { name: 'load_order_summary', startedAt: 100, completedAt: 110, status: 'success' },
      { name: 'lookup_refund_history', startedAt: 200, completedAt: 205, status: 'success' },
      { name: 'lookup_orders', startedAt: 206, completedAt: 210, status: 'success' },
    ],
    reads: [
      { operation: 'crm.getCustomer', startedAt: 101, completedAt: 104, status: 'success' },
      { operation: 'orders.list', startedAt: 101, completedAt: 105, status: 'success' },
      { operation: 'payments.refundHistory', startedAt: 201, completedAt: 204, status: 'success' },
      { operation: 'orders.list', startedAt: 207, completedAt: 209, status: 'success' },
    ],
    modelEvents: [
      { startMs: 0, endMs: 90, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 10 },
      { startMs: 110, endMs: 195, inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 20 },
      { startMs: 210, endMs: 300, inputTokens: 1400, cachedInputTokens: 1200, outputTokens: 90 },
    ],
    cost: apiEquivalentCost,
  });
  expect(ledger.calls.map((call) => call.kind)).toEqual([
    'fixture_software',
    'follow_up',
    'follow_up',
  ]);
  expect(ledger.calls[0].businessReads.map((read) => read.operation).sort()).toEqual([
    'crm.getCustomer',
    'orders.list',
  ]);
  expect(ledger.calls[1]).toMatchObject({
    necessaryFollowUp: true,
    redundant: false,
    duplicateSuccessfulReads: 0,
  });
  expect(ledger.calls[2]).toMatchObject({
    necessaryFollowUp: false,
    redundant: true,
    duplicateSuccessfulReads: 1,
  });
  expect(ledger).toMatchObject({
    softwareCalls: 1,
    followUpCalls: 2,
    necessaryFollowUpCalls: 1,
    redundantToolCalls: 1,
  });
  expect(ledger.responses.map((response) => response.issuedToolCalls)).toEqual([[0], [1, 2], []]);
  expect(ledger.responses[0].apiEquivalentCostUsd).toBeCloseTo(0.0053, 10);
  expect(ledger.responses[2].apiEquivalentCostUsd).toBe(apiEquivalentCost(1400, 1200, 90));
});

it('treats the Foundry loader as live software and does not flag cache-served first reads as redundant', () => {
  const task = byCategory(developmentCases, 'software_tool');
  const ledger = buildCallLedger({
    task,
    toolCalls: [
      { name: 'load_customer_context', startedAt: 10, completedAt: 30, status: 'success' },
    ],
    reads: allReads.map((operation) => ({
      operation,
      startedAt: 11,
      completedAt: 20,
      status: 'success' as const,
    })),
    modelEvents: [],
    cost: apiEquivalentCost,
  });
  expect(ledger.calls[0]).toMatchObject({
    kind: 'foundry_software',
    redundant: false,
    duplicateSuccessfulReads: 0,
  });
  expect(ledger.applicationReads).toEqual([]);
});

// Fixture provider protocol (no network or inference). The scripted "agent" calls the partial
// software, then one follow-up lookup, then returns a final answer. It models the harness path,
// not live model behaviour.
function scriptedProvider(script: string[], finalText: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    exitCode: number | null;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  let responses = 0;
  let step = 0;
  const send = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const usage = () => {
    responses++;
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'fixture-thread',
        tokenUsage: {
          total: {
            inputTokens: responses * 100,
            outputTokens: responses * 5,
            cachedInputTokens: 0,
            totalTokens: responses * 105,
          },
          last: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0, totalTokens: 105 },
        },
      },
    });
  };
  const next = () => {
    usage();
    if (step < script.length) {
      send({
        id: 100 + step,
        method: 'item/tool/call',
        params: { threadId: 'fixture-thread', tool: script[step++], arguments: {} },
      });
      return;
    }
    send({
      method: 'item/completed',
      params: { threadId: 'fixture-thread', item: { type: 'agentMessage', text: finalText } },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'fixture-thread', turn: { status: 'completed' } },
    });
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk));
      queueMicrotask(() => {
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start')
          send({ id: message.id, result: { thread: { id: 'fixture-thread' }, model: 'gpt-5.5' } });
        else if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: 'fixture-turn' } } });
          next();
        } else if (['turn/interrupt', 'thread/archive'].includes(message.method))
          send({ id: message.id, result: {} });
        else if (message.result) setTimeout(next, 2);
      });
      callback();
    },
    final(callback) {
      callback();
      setImmediate(() => {
        child.exitCode = 0;
        child.emit('exit', 0);
      });
    },
  });
  child.kill = () => {
    child.exitCode = 1;
    child.emit('exit', 1);
  };
  return child;
}

it('fixture flow: supplements a partial software result with only the missing typed read', async () => {
  const task = byCategory(developmentCases, 'software_supplement');
  const final: RoutingResponse = {
    ...task.expected,
    reply: `Order ${task.expected.selectedOrderId} is 9 days late. Because a prior refund is already recorded, a specialist will review the next step; nothing has been changed.`,
  };
  fake.spawn = () =>
    scriptedProvider(['load_order_summary', 'lookup_refund_history'], JSON.stringify(final));
  const ctx = context(task.customerId);
  const reads: {
    operation: ReadOperation;
    startedAt: number;
    completedAt: number;
    status: 'success' | 'failed';
  }[] = [];
  const started = performance.now();
  const adapters: AdapterRunner = async (operation, args, c) => {
    authorizeReads(c, args, [operation]);
    const entry = {
      operation,
      startedAt: performance.now() - started,
      completedAt: 0,
      status: 'success' as const,
    };
    reads.push(entry);
    const value = routingFixture(operation, args.customerId);
    entry.completedAt = performance.now() - started;
    return value;
  };
  const agent = new CustomerContextAgent({
    adapters,
    context: () => ctx,
    agentId: 'fixture-agent',
    timeoutMs: 2000,
  });
  const calls: LedgerToolCall[] = [];
  const offered = [...tools, partialSoftwareTool];
  await agent.start();
  try {
    const observer = new TrajectoryObserver({
      input: { customerId: task.customerId },
      context: ctx,
      adapters,
      agentId: 'fixture-agent',
      allowedOperations: allReads,
    });
    const run = await agent.runTask({
      input: { customerId: task.customerId },
      observer,
      allowedOperations: allReads,
      tools: offered,
      executeTool: async (capture, name, args) => {
        const call: LedgerToolCall = {
          name,
          startedAt: performance.now() - started,
          completedAt: 0,
          status: 'success',
        };
        calls.push(call);
        try {
          return name === partialSoftwareTool.name
            ? await runPartialSoftware(capture, ctx)
            : await executeTool(capture, name, args);
        } finally {
          call.completedAt = performance.now() - started;
        }
      },
      prompt: 'Fixture prompt',
      instructions: 'Fixture instructions',
      outputSchema: z.toJSONSchema(routingResponseSchema),
      parseResult: (raw) => routingResponseSchema.parse(raw),
      complete: (_result, capture) => structuredClone(capture.measurement),
    });
    expect(reads.map((read) => read.operation).sort()).toEqual([...allReads].sort());
    expect(run.measurement).toMatchObject({ modelCalls: 3, totalTokens: 315, toolCalls: 3 });
    expect(assessRouting(run.result, task, reads).passed).toBe(true);
    const ledger = buildCallLedger({
      task,
      toolCalls: calls,
      reads,
      modelEvents: [],
      cost: apiEquivalentCost,
    });
    expect(ledger).toMatchObject({
      softwareCalls: 1,
      followUpCalls: 1,
      necessaryFollowUpCalls: 1,
      redundantToolCalls: 0,
    });
    expect(ledger.calls.reduce((sum, call) => sum + call.duplicateSuccessfulReads, 0)).toBe(0);
  } finally {
    await agent.close();
  }
});
