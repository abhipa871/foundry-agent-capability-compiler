import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { format } from 'prettier';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { FoundryClient } from '../src/integration/client.js';
import { TrajectoryObserver } from '../src/exploration/observe.js';
import { Store } from '../src/registry/store.js';
import {
  fixtureResult,
  localContext,
  mockAdapters,
  type AdapterRunner,
} from '../src/runtime/adapters/registry.js';
import { contextProjection, fullContextSchema, sameContext } from '../src/runtime/observable.js';
import { ApiKeyAuthenticator, localIdentity } from '../src/security/identity.js';
import { ArtifactSigner } from '../src/security/signing.js';
import type { Measurement } from '../src/telemetry/measurement.js';
import { sumMeasurements } from './experiments/statistics.js';
import {
  assessSupportResponse,
  compiledContextTool,
  contextFromReads,
  supportCases,
  supportInstructions,
  supportPrompt,
  supportProjection,
  supportResponseSchema,
  type SupportCase,
} from './experiments/support-task.js';
import { executeTool, tools } from './experiments/customer-agent.js';
import {
  GeminiAgent,
  geminiModel,
  geminiProvider,
  type GeminiRun,
  type GeminiTool,
} from './experiments/gemini-agent.js';

const output = 'docs/gemini-consumer-benchmark.json';
const trials = Number(process.env.FOUNDRY_GEMINI_TRIALS ?? 9);
if (!Number.isInteger(trials) || trials < 3 || trials > 27 || trials % 3 !== 0)
  throw new Error('FOUNDRY_GEMINI_TRIALS must be 3–27 in multiples of 3.');

const supportJsonSchema = {
  type: 'object',
  properties: {
    customerId: { type: 'string' },
    eligible: { type: 'boolean' },
    orders: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, daysLate: { type: 'integer' } },
        required: ['id', 'daysLate'],
        additionalProperties: false,
      },
    },
    refunds: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, amount: { type: 'number' } },
        required: ['id', 'amount'],
        additionalProperties: false,
      },
    },
    selectedOrderId: { type: 'string' },
    action: { type: 'string', enum: ['refund_review', 'human_review', 'delivery_support'] },
    reply: { type: 'string' },
  },
  required: ['customerId', 'eligible', 'orders', 'refunds', 'selectedOrderId', 'action', 'reply'],
  additionalProperties: false,
};

const contextJsonSchema = {
  type: 'object',
  properties: {
    customer_id: { type: 'string' },
    crm_get_customer: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        tenantId: { type: 'string' },
        snapshot: { type: 'string' },
        eligible: { type: 'boolean' },
      },
      required: ['customerId', 'tenantId', 'snapshot', 'eligible'],
      additionalProperties: false,
    },
    orders_list: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        tenantId: { type: 'string' },
        snapshot: { type: 'string' },
        orders: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, daysLate: { type: 'integer' } },
            required: ['id', 'daysLate'],
            additionalProperties: false,
          },
        },
      },
      required: ['customerId', 'tenantId', 'snapshot', 'orders'],
      additionalProperties: false,
    },
    payments_refund_history: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        tenantId: { type: 'string' },
        snapshot: { type: 'string' },
        refunds: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, amount: { type: 'number' } },
            required: ['id', 'amount'],
            additionalProperties: false,
          },
        },
      },
      required: ['customerId', 'tenantId', 'snapshot', 'refunds'],
      additionalProperties: false,
    },
  },
  required: ['customer_id', 'crm_get_customer', 'orders_list', 'payments_refund_history'],
  additionalProperties: false,
};

type Arm = 'regular_api' | 'compiled_tool' | 'compiled_prefetch' | 'regular_prefetch';
const arms: Arm[] = ['regular_api', 'compiled_tool', 'compiled_prefetch', 'regular_prefetch'];
const began = performance.now();
const ids = ['C-101', 'C-202', 'C-303'];
const context = () => ({ ...localContext(), allowedCustomerIds: [...ids] });
let physicalReads = 0;
const adapters: AdapterRunner = mockAdapters({ onCall: () => physicalReads++ });
const agent = new GeminiAgent({ model: geminiModel, maxModelCalls: 6, maxToolCalls: 10 });
const setupRuns: GeminiRun<unknown>[] = [];
let lastNativeFailure: string | undefined;

const keys = generateKeyPairSync('ed25519');
const signer = new ArtifactSigner(
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const localApiKey = 'gemini_consumer_benchmark_local_credential';
const auth = new ApiKeyAuthenticator([
  { sha256: createHash('sha256').update(localApiKey).digest('hex'), identity: localIdentity },
]);
const store = new Store(':memory:');

const native: ConstructorParameters<typeof FoundryClient>[0]['native'] = async (
  task,
  _checkpoint,
  supplied,
) => {
  try {
    const input = z.object({ customerId: z.string() }).parse(task.input);
    const observer =
      supplied ??
      new TrajectoryObserver({
        input,
        context: context(),
        adapters,
        agentId: localIdentity.agentId,
        provider: geminiProvider,
        model: geminiModel,
        apiCallsKnown: true,
      });
    const toolResults = new Map<string, unknown>();
    const run = await agent.runTask({
      observer,
      tools: tools as GeminiTool[],
      executeTool: async (capture, name, args) => {
        if (toolResults.has(name)) return toolResults.get(name);
        const result = await executeTool(capture, name, args);
        toolResults.set(name, result);
        return result;
      },
      prompt: `Load the complete personal order context for ${input.customerId}: account eligibility, all orders, and complete refund history.`,
      instructions:
        'You retrieve a consumer’s order context using only the supplied read tools. Return every resource faithfully in the required JSON schema. Do not invent values or perform writes.',
      outputSchema: contextJsonSchema,
      parseResult: (raw) => fullContextSchema.parse(raw),
      complete: (result, capture) => capture.finish(result).measurement!,
    });
    setupRuns.push(run as GeminiRun<unknown>);
    return {
      resolved: true,
      summary: 'Gemini-backed personal order context.',
      llmInvocations: run.measurement.modelCalls!,
      tokens: run.measurement.totalTokens!,
      measurement: run.measurement,
      result: run.result,
    };
  } catch (error) {
    lastNativeFailure = error instanceof Error ? error.message : 'Unknown native failure.';
    throw error;
  }
};

const { app, service } = createApp(store, false, {
  auth,
  signer,
  runtime: {
    adapters: () => adapters,
    context,
    agent: (task, checkpoint) => native(task, checkpoint, undefined),
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
let controlApiCalls = 0;
const client = (shareReplayEvidence = false) =>
  new FoundryClient({
    ...localIdentity,
    context,
    adapters,
    native,
    provider: geminiProvider,
    model: geminiModel,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: localApiKey,
    trustedPublicKey: publicKey,
    shareReplayEvidence,
    fetch: (url, init) => {
      controlApiCalls++;
      return fetch(url, init);
    },
  });
const measuredClient = client();
const request = (customerId: string) => ({ kind: 'customer_context', input: { customerId } });
const oracle = (customerId: string) => ({
  customer_id: customerId,
  crm_get_customer: fixtureResult('crm.getCustomer', customerId),
  orders_list: fixtureResult('orders.list', customerId),
  payments_refund_history: fixtureResult('payments.refundHistory', customerId),
});
const gate: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

type Run = {
  arm: Arm;
  caseId: string;
  measurement: Measurement;
  providerUsage: GeminiRun<unknown>['usage'];
  providerRequests: number;
  physicalReads: number;
  controlApiCalls: number;
  modelVisibleToolCalls: number;
  passed: boolean;
  response: z.infer<typeof supportResponseSchema>;
};

async function execute(task: SupportCase, arm: Arm): Promise<Run> {
  const started = performance.now();
  const readsBefore = physicalReads;
  const controlBefore = controlApiCalls;
  const observer = new TrajectoryObserver({
    input: { customerId: task.customerId },
    context: context(),
    adapters,
    agentId: localIdentity.agentId,
    provider: geminiProvider,
    model: geminiModel,
    apiCallsKnown: true,
  });
  const contextMeasurements: Measurement[] = [];
  let loadedContext: ReturnType<typeof contextProjection> | undefined;
  const loadCompiled = async () => {
    const run = await measuredClient.execute(request(task.customerId), { fallback: 'defer' });
    contextMeasurements.push(run.measurement);
    gate(run.mode === 'compiled' && run.outcome === 'success', 'Compiled context did not execute.');
    loadedContext = contextProjection(run.result);
    gate(sameContext(loadedContext, oracle(task.customerId)), 'Compiled context mismatch.');
    return loadedContext;
  };
  const loadRegular = async () => {
    const [customer, orders, refunds] = await Promise.all(
      [
        ['crm.getCustomer', 'customer'],
        ['orders.list', 'orders'],
        ['payments.refundHistory', 'refunds'],
      ].map(async ([operation]) =>
        observer.read(operation as Parameters<typeof observer.read>[0], {
          source: 'task_input',
          key: 'customerId',
        }),
      ),
    );
    loadedContext = contextProjection({
      customer_id: task.customerId,
      crm_get_customer: customer.value,
      orders_list: orders.value,
      payments_refund_history: refunds.value,
    });
    gate(sameContext(loadedContext, oracle(task.customerId)), 'Regular prefetch mismatch.');
    return loadedContext;
  };

  if (arm === 'compiled_prefetch') await loadCompiled();
  if (arm === 'regular_prefetch') await loadRegular();
  const offered =
    arm === 'regular_api'
      ? (tools as GeminiTool[])
      : arm === 'compiled_tool'
        ? (compiledContextTool as GeminiTool[])
        : [];
  const run = await agent.runTask({
    observer,
    tools: offered,
    executeTool: async (capture, name, args) => {
      if (arm === 'regular_api') return executeTool(capture, name, args);
      if (arm !== 'compiled_tool' || name !== 'load_customer_context')
        throw new Error('Gemini requested a tool outside the arm allowlist.');
      z.object({}).strict().parse(args);
      return loadCompiled();
    },
    prompt: supportPrompt(
      task,
      arm === 'compiled_prefetch' || arm === 'regular_prefetch' ? loadedContext : undefined,
    ),
    instructions: supportInstructions,
    outputSchema: supportJsonSchema,
    parseResult: (raw) => supportResponseSchema.parse(raw),
    complete: (_result, capture) => {
      capture.measurement.durationMs = performance.now() - started;
      capture.measurement.outcome = 'success';
      return structuredClone(capture.measurement);
    },
  });
  if (arm === 'regular_api') loadedContext = contextFromReads(observer, task.customerId);
  gate(loadedContext && sameContext(loadedContext, oracle(task.customerId)), 'Context missing.');
  const assessment = assessSupportResponse(run.result, task);
  const measurement = contextMeasurements.length
    ? sumMeasurements([run.measurement, ...contextMeasurements], performance.now() - started)
    : { ...run.measurement, durationMs: performance.now() - started };
  measurement.toolCalls = physicalReads - readsBefore;
  measurement.apiCalls = controlApiCalls - controlBefore + run.providerRequests;
  gate(measurement.totalTokens === run.usage.totalTokens, 'Per-arm token total mismatch.');
  return {
    arm,
    caseId: task.id,
    measurement,
    providerUsage: run.usage,
    providerRequests: run.providerRequests,
    physicalReads: physicalReads - readsBefore,
    controlApiCalls: controlApiCalls - controlBefore,
    modelVisibleToolCalls: run.toolCalls.length,
    passed: assessment.passed,
    response: run.result,
  };
}

const warmups: Run[] = [];
const measured: { caseId: string; order: Arm[]; runs: Record<Arm, Run> }[] = [];
let failure: string | undefined;
let candidate: { id: string; digest: string } | undefined;
try {
  for (const id of ids.slice(0, 2)) {
    const observed = await client(true).execute(request(id));
    gate(
      observed.outcome === 'success',
      `Observation failed${lastNativeFailure ? `: ${lastNativeFailure}` : '.'}`,
    );
  }
  const patterns = service.jit.analyze();
  gate(patterns.length === 1, 'Expected exactly one compilable pattern.');
  candidate = service.jit.compilePattern(patterns[0].id);
  const verified = await service.jit.verify(candidate.id);
  gate(
    verified.checks.every((check) => check.passed),
    'Candidate verification failed.',
  );
  for (const id of ids) {
    const shadow = await service.jit.shadow(candidate.id, { customerId: id });
    gate(shadow.shadow.status === 'match', 'Candidate shadow mismatch.');
  }
  gate(service.jit.shadowStatus(candidate.id).ready, 'Candidate shadow gate not ready.');
  service.jit.approve(
    candidate.id,
    'Live Gemini consumer benchmark after verification and shadow.',
  );
  service.jit.deploy(candidate.id);
  service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
  console.log(JSON.stringify({ stage: 'setup', model: geminiModel, candidate }));

  for (const arm of arms) {
    const warmup = await execute(supportCases[0], arm);
    gate(warmup.passed, `Warmup failed for ${arm}.`);
    warmups.push(warmup);
  }
  for (let index = 0; index < trials; index++) {
    const task = supportCases[(index * 3 + Math.floor(index / 3)) % supportCases.length];
    const rotation = index % arms.length;
    const order = [...arms.slice(rotation), ...arms.slice(0, rotation)];
    const runs = {} as Record<Arm, Run>;
    for (const arm of order) {
      runs[arm] = await execute(task, arm);
      gate(runs[arm].passed, `${task.id}/${arm} failed correctness checks.`);
    }
    const projection = JSON.stringify(supportProjection(runs.regular_api.response));
    gate(
      arms.every((arm) => JSON.stringify(supportProjection(runs[arm].response)) === projection),
      `${task.id} differed across arms.`,
    );
    measured.push({ caseId: task.id, order, runs });
    console.log(
      JSON.stringify({
        stage: 'trial',
        trial: index + 1,
        caseId: task.id,
        totals: Object.fromEntries(arms.map((arm) => [arm, runs[arm].measurement.totalTokens])),
      }),
    );
  }
} catch (error) {
  failure = error instanceof Error ? error.message : 'Benchmark failed.';
  process.exitCode = 1;
} finally {
  const runsByArm = Object.fromEntries(
    arms.map((arm) => [arm, measured.map((trial) => trial.runs[arm])]),
  ) as Record<Arm, Run[]>;
  const sum = (runs: Run[], key: keyof GeminiRun<unknown>['usage']) =>
    runs.reduce((total, run) => total + run.providerUsage[key], 0);
  const summary = Object.fromEntries(
    arms.map((arm) => {
      const runs = runsByArm[arm];
      return [
        arm,
        {
          requests: runs.length,
          totalInputTokens: sum(runs, 'inputTokens'),
          totalCandidateTokens: sum(runs, 'candidateTokens'),
          totalThoughtTokens: sum(runs, 'thoughtTokens'),
          totalCachedInputTokens: sum(runs, 'cachedInputTokens'),
          totalTokens: sum(runs, 'totalTokens'),
          meanTokens: runs.length ? sum(runs, 'totalTokens') / runs.length : null,
          providerRequests: runs.reduce((total, run) => total + run.providerRequests, 0),
          physicalReads: runs.reduce((total, run) => total + run.physicalReads, 0),
          modelVisibleToolCalls: runs.reduce((total, run) => total + run.modelVisibleToolCalls, 0),
          controlApiCalls: runs.reduce((total, run) => total + run.controlApiCalls, 0),
          successRate: runs.length ? runs.filter((run) => run.passed).length / runs.length : null,
        },
      ];
    }),
  );
  const setupUsage = setupRuns.reduce((total, run) => total + run.usage.totalTokens, 0);
  const warmupUsage = Object.fromEntries(
    arms.map((arm) => [
      arm,
      warmups
        .filter((run) => run.arm === arm)
        .reduce((total, run) => total + run.providerUsage.totalTokens, 0),
    ]),
  );
  const report = {
    capturedAt: new Date().toISOString(),
    complete: !failure && measured.length === trials,
    failure,
    model: geminiModel,
    provider: geminiProvider,
    methodology: {
      task: 'Personal consumer order review: inspect eligibility, orders, and refund history, then recommend the appropriate next step.',
      compiledRegion:
        'The existing verified load_customer_context read capability. Gemini always performs the final assessment and response.',
      arms: {
        regular_api: 'Gemini chooses among three ordinary typed read tools.',
        compiled_tool: 'Gemini chooses one verified compiled context tool.',
        compiled_prefetch: 'The Foundry SDK executes the verified capability before Gemini.',
        regular_prefetch: 'Application code performs the same three reads before Gemini.',
      },
      trialsPerArm: trials,
      temperature: 0,
      rotatedArmOrder: true,
      providerReportedUsage: true,
      tokenDefinition:
        'Gemini usageMetadata.totalTokenCount summed across every generateContent response in a task; includes input, candidate, and thought tokens.',
    },
    candidate,
    measured: { summary, trials: measured },
    excludedFromMeasuredArmTotals: {
      setupGeminiTokens: setupUsage,
      warmupGeminiTokensByArm: warmupUsage,
      smokeTestGeminiTokens: 94,
    },
    experimentTotals: {
      measuredGeminiTokens: Object.values(summary).reduce(
        (total, arm: any) => total + arm.totalTokens,
        0,
      ),
      setupGeminiTokens: setupUsage,
      warmupGeminiTokens: Object.values(warmupUsage).reduce((total, value) => total + value, 0),
      smokeTestGeminiTokens: 94,
      elapsedMs: performance.now() - began,
    },
  };
  writeFileSync(output, await format(JSON.stringify(report), { parser: 'json', printWidth: 96 }));
  console.log(JSON.stringify({ complete: report.complete, failure, summary }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
}
