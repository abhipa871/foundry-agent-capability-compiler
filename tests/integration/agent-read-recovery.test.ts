import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { CustomerContextAgent } from '../../scripts/experiments/customer-agent.js';
import { DomainError } from '../../src/domain.js';
import { fixtureResult, localContext } from '../../src/runtime/adapters/registry.js';

const fake = vi.hoisted(() => ({ spawn: undefined as undefined | (() => unknown) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: () => fake.spawn!(),
}));
afterEach(() => {
  fake.spawn = undefined;
});

// A fixture provider protocol, with no network or inference: emit a completed selection response,
// return a read failure to the agent, then exercise its next response/retry and final usage.
function providerProtocol(finalText = '{"ok":true}', failuresUntilFinal = Infinity) {
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
  let interrupted = false;
  let responses = 0;
  let failures = 0;
  const send = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const usage = () => {
    responses++;
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'fixture-thread',
        tokenUsage: {
          total: {
            inputTokens: responses * 10,
            outputTokens: responses * 2,
            cachedInputTokens: 0,
            totalTokens: responses * 12,
          },
          last: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 },
        },
      },
    });
  };
  const call = (id: number) =>
    send({
      id,
      method: 'item/tool/call',
      params: {
        threadId: 'fixture-thread',
        tool: 'lookup_customer',
        arguments: {},
      },
    });
  const complete = () => {
    usage();
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
          usage();
          call(100);
        } else if (message.method === 'turn/interrupt') {
          interrupted = true;
          send({ id: message.id, result: {} });
        } else if (message.method === 'thread/archive') send({ id: message.id, result: {} });
        else if (message.result?.success === false) {
          failures++;
          setTimeout(() => {
            if (!interrupted) {
              if (failures >= failuresUntilFinal) complete();
              else {
                usage();
                call(101);
              }
            }
          }, 10);
        } else if (message.result?.success === true) {
          complete();
        }
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

async function exercise(status?: number, recovery?: boolean, invalidOutput = false) {
  fake.spawn = () => providerProtocol();
  let attempts = 0;
  let retained:
    | Parameters<NonNullable<ConstructorParameters<typeof CustomerContextAgent>[0]['onRun']>>[0]
    | undefined;
  const agent = new CustomerContextAgent({
    context: localContext,
    agentId: 'fixture-agent',
    timeoutMs: 1000,
    adapters: async (operation, input) => {
      attempts++;
      if (status && attempts === 1) throw new DomainError('Fixture read failure', status);
      return fixtureResult(operation, input.customerId);
    },
    onRun: (run) => {
      retained = run;
    },
  });
  await agent.start();
  try {
    const task = agent.runTask({
      input: { customerId: 'C-101' },
      allowedOperations: ['crm.getCustomer'],
      tools: [
        {
          type: 'function',
          name: 'lookup_customer',
          description: 'Fixture read',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      executeTool: async (observer) =>
        (await observer.read('crm.getCustomer', { source: 'task_input', key: 'customerId' })).value,
      prompt: 'Fixture prompt',
      instructions: 'Fixture instructions',
      outputSchema: {},
      recoverReadFailures: recovery,
      parseResult: (raw) => {
        if (invalidOutput) throw new Error('Invalid final schema');
        return raw;
      },
      complete: (_result, observer) => structuredClone(observer.measurement),
    });
    const result = await task.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    return { ...result, retained, attempts };
  } finally {
    await agent.close();
  }
}
it('lets an opt-in agent retry a transient authorized read and retains all completed inference/read attempts', async () => {
  const result = await exercise(503, true);
  expect(result.error).toBeUndefined();
  expect(result.attempts).toBe(2);
  expect(result.value!.measurement).toMatchObject({
    modelCalls: 3,
    inputTokens: 30,
    outputTokens: 6,
    totalTokens: 36,
    toolCalls: 2,
  });
  expect(result.value!.toolCalls.map((call) => call.status)).toEqual(['failed', 'success']);
  expect(result.retained!.apiEquivalentCostUsd).toBe(0.00033);
});
it('keeps denials and default tool failures terminal and marks interrupted provider usage unknown', async () => {
  for (const [status, recovery] of [
    [403, true],
    [503, false],
  ] as const) {
    const result = await exercise(status, recovery);
    expect(result.error).toBeDefined();
    expect(result.attempts).toBe(1);
    expect(result.retained!.measurement).toMatchObject({
      modelCalls: null,
      totalTokens: null,
      toolCalls: 1,
    });
    expect(result.retained!.apiEquivalentCostUsd).toBeNull();
  }
});
it('retains reported usage when a completed provider response fails final schema validation', async () => {
  const result = await exercise(undefined, false, true);
  expect(result.error).toBeDefined();
  expect(result.retained!.measurement).toMatchObject({
    modelCalls: 2,
    totalTokens: 24,
    outcome: 'failed',
  });
  expect(result.retained!.apiEquivalentCostUsd).toBe(0.00022);
});

it('allows the experiment context agent to report persistent unavailability without inventing a full context', async () => {
  fake.spawn = () => providerProtocol('{"context":null}', 2);
  const agent = new CustomerContextAgent({
    context: localContext,
    agentId: 'fixture-agent',
    timeoutMs: 1000,
    recoverReadFailures: true,
    allowUnavailableContext: true,
    adapters: async () => {
      throw new DomainError('Fixture unavailable', 503);
    },
  });
  await agent.start();
  try {
    const result = await agent.native(
      { kind: 'customer_context', input: { customerId: 'C-101' } },
      undefined,
      undefined,
    );
    expect(result.resolved).toBe(false);
    expect(result.result).toBeUndefined();
    expect(result.measurement).toMatchObject({
      modelCalls: 3,
      totalTokens: 36,
      toolCalls: 2,
      outcome: 'failed',
    });
  } finally {
    await agent.close();
  }
});
