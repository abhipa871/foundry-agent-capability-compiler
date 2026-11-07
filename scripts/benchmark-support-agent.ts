import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { format } from 'prettier';
import { createApp } from '../src/app.js';
import { Store } from '../src/registry/store.js';
import { FoundryClient } from '../src/integration/client.js';
import { TrajectoryObserver } from '../src/exploration/observe.js';
import { localContext, mockAdapters, fixtureResult } from '../src/runtime/adapters/registry.js';
import { sameContext, contextProjection } from '../src/runtime/observable.js';
import { ApiKeyAuthenticator, localIdentity } from '../src/security/identity.js';
import { ArtifactSigner } from '../src/security/signing.js';
import type { Measurement } from '../src/telemetry/measurement.js';
import {
  CustomerContextAgent,
  executeTool,
  tools,
  apiEquivalentCost,
  rateCard,
  provider,
  model,
} from './experiments/customer-agent.js';
import {
  supportCases,
  supportInstructions,
  supportPrompt,
  supportResponseSchema,
  assessSupportResponse,
  contextFromReads,
  supportProjection,
  compiledContextTool,
  type SupportCase,
} from './experiments/support-task.js';
import {
  mean,
  comparison,
  breakEven,
  latencySummary,
  numericKeys,
  sumMeasurements,
} from './experiments/statistics.js';

// Test an entire agent task. Only the existing customer-context retrieval is compiled; the
// decision and reply stay model-generated in every arm. No policy/decision capability is added.
const began = performance.now();
const cpuStart = process.cpuUsage();
const trialsRequested = Number(process.env.FOUNDRY_SUPPORT_TRIALS ?? 18);
if (
  !Number.isInteger(trialsRequested) ||
  trialsRequested < 9 ||
  trialsRequested > 90 ||
  trialsRequested % 9 !== 0
)
  throw new Error('Use 9–90 trials, in multiples of 9 for balanced case coverage.');
const ids = ['C-101', 'C-202', 'C-303'];
const context = () => ({ ...localContext(), allowedCustomerIds: [...ids] });
let physicalReads = 0;
const adapters = mockAdapters({ onCall: () => physicalReads++ });
let phase = 'initialization';
const nativeRuns: {
  role: string;
  phase: string;
  measurement: Measurement | undefined;
  status: string;
  responses: number;
  apiEquivalentCostUsd: number | null;
}[] = [];
const contextAgent = new CustomerContextAgent({
  adapters,
  context,
  agentId: localIdentity.agentId,
  onRun: (run) => nativeRuns.push({ ...run, phase, role: 'context_agent' }),
});
const supportAgent = new CustomerContextAgent({
  adapters,
  context,
  agentId: localIdentity.agentId,
  onRun: (run) => nativeRuns.push({ ...run, phase, role: 'support_agent' }),
});
const keys = generateKeyPairSync('ed25519');
const signer = new ArtifactSigner(
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const apiKey = 'support_experiment_local_credential_000000000';
const auth = new ApiKeyAuthenticator([
  { sha256: createHash('sha256').update(apiKey).digest('hex'), identity: localIdentity },
]);
const store = new Store(':memory:');
const { app, service } = createApp(store, false, {
  auth,
  signer,
  runtime: {
    adapters: () => adapters,
    context,
    agent: (task, checkpoint) => contextAgent.native(task, checkpoint, undefined),
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
let controlApiCalls = 0;
const transport: typeof fetch = (input, init) => {
  controlApiCalls++;
  return fetch(input, init);
};
const client = (shareReplayEvidence = false, overrideContext = context) =>
  new FoundryClient({
    ...localIdentity,
    context: overrideContext,
    adapters,
    native: contextAgent.native,
    provider,
    model,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey,
    trustedPublicKey: publicKey,
    fetch: transport,
    shareReplayEvidence,
  });
const measuredClient = client();
const request = (customerId: string) => ({ kind: 'customer_context', input: { customerId } });
const oracle = (customerId: string) => ({
  customer_id: customerId,
  crm_get_customer: fixtureResult('crm.getCustomer', customerId),
  orders_list: fixtureResult('orders.list', customerId),
  payments_refund_history: fixtureResult('payments.refundHistory', customerId),
});
const gate = (passed: boolean, message: string) => {
  if (!passed) throw new Error(message);
};
const durations: Record<string, number> = {};
async function timed<T>(label: string, fn: () => Promise<T>) {
  phase = label;
  const start = performance.now();
  try {
    return await fn();
  } finally {
    durations[label] = performance.now() - start;
  }
}
type Arm = 'baseline' | 'compiled_tool' | 'compiled_prefetch';
const arms: Arm[] = ['baseline', 'compiled_tool', 'compiled_prefetch'];
async function executeSupport(task: SupportCase, arm: Arm) {
  const start = performance.now();
  const readsBefore = physicalReads;
  const apiBefore = controlApiCalls;
  const capture = new TrajectoryObserver({
    input: { customerId: task.customerId },
    context: context(),
    adapters,
    agentId: localIdentity.agentId,
    provider,
    model,
    apiCallsKnown: true,
  });
  const contextMeasurements: Measurement[] = [];
  const routes: { mode: string; outcome: string; durationMs: number; fallbackReason?: string }[] =
    [];
  let loadedContext: ReturnType<typeof contextProjection> | undefined;
  async function loadCompiledContext() {
    const run = await measuredClient.execute(request(task.customerId));
    contextMeasurements.push(run.measurement);
    routes.push({
      mode: run.mode,
      outcome: run.outcome,
      durationMs: run.durationMs,
      fallbackReason: run.fallbackReason,
    });
    gate(run.outcome === 'success', 'Customer context failed during support request.');
    loadedContext = contextProjection(run.result);
    gate(
      sameContext(loadedContext, oracle(task.customerId)),
      'Loaded context differs from independent oracle.',
    );
    return loadedContext;
  }
  if (arm === 'compiled_prefetch') await loadCompiledContext();
  const run = await supportAgent.runTask({
    input: { customerId: task.customerId },
    observer: capture,
    tools: arm === 'baseline' ? tools : arm === 'compiled_tool' ? compiledContextTool : [],
    executeTool: async (observer, name, args) => {
      if (arm === 'baseline') return executeTool(observer, name, args);
      if (arm !== 'compiled_tool' || name !== 'load_customer_context')
        throw new Error('Support tool outside read allowlist.');
      z.object({}).strict().parse(args);
      return loadCompiledContext();
    },
    prompt: supportPrompt(task, arm === 'compiled_prefetch' ? loadedContext : undefined),
    instructions: supportInstructions,
    outputSchema: z.toJSONSchema(supportResponseSchema),
    parseResult: (raw) => supportResponseSchema.parse(raw),
    effort: 'low',
    complete: (_response, observer) => {
      // End-to-end support output is never misrepresented as a compiled customer-context trace.
      observer.measurement.durationMs = performance.now() - start;
      observer.measurement.outcome = 'success';
      return structuredClone(observer.measurement);
    },
  });
  if (arm === 'baseline') loadedContext = contextFromReads(capture, task.customerId);
  gate(
    loadedContext !== undefined && sameContext(loadedContext, oracle(task.customerId)),
    'Support agent did not retrieve full required evidence.',
  );
  const measured = sumMeasurements(
    [run.measurement, ...contextMeasurements],
    performance.now() - start,
  );
  measured.toolCalls = physicalReads - readsBefore; // includes compiled and fallback reads
  measured.apiCalls = controlApiCalls - apiBefore; // optimization API calls, not provider transport attempts
  const assessment = assessSupportResponse(run.result, task);
  const cost =
    measured.inputTokens === null ||
    measured.cachedInputTokens === null ||
    measured.outputTokens === null
      ? null
      : apiEquivalentCost(measured.inputTokens, measured.cachedInputTokens, measured.outputTokens);
  return {
    arm,
    measurement: measured,
    modelToolCalls: run.toolCalls,
    modelEvents: run.modelEvents,
    apiEquivalentCostUsd: cost,
    response: run.result,
    assessment,
    context: loadedContext,
    contextMeasurements,
    routes,
    usedFallback: routes.some((route) => route.mode !== 'compiled'),
  };
}
type SupportRun = Awaited<ReturnType<typeof executeSupport>>;
const measured: {
  index: number;
  case: SupportCase;
  heldOut: boolean;
  order: Arm[];
  runs: Partial<Record<Arm, SupportRun>>;
  allPassed: boolean;
  decisionsEquivalent: boolean;
}[] = [];
const warmups: SupportRun[] = [];
const security: { name: string; passed: boolean }[] = [];
let setupMs = 0;
let candidate: { id: string; digest: string; checks?: unknown } | undefined;
let fallback: SupportRun | undefined;
let failure: string | undefined;
try {
  await timed('providerInitialization', async () => {
    await contextAgent.start();
    await supportAgent.start();
  });
  await timed('observation', async () => {
    for (const id of ids.slice(0, 2)) {
      const observed = await client(true).execute(request(id));
      gate(
        observed.outcome === 'success' && sameContext(observed.result, oracle(id)),
        'Observation gate failed.',
      );
    }
  });
  candidate = await timed('analysisAndCompilation', async () => {
    const patterns = service.jit.analyze();
    gate(patterns.length === 1, 'Structural eligibility gate failed.');
    return service.jit.compilePattern(patterns[0].id);
  });
  const id = candidate.id;
  const validated = await timed('validation', () => service.jit.verify(id));
  candidate.checks = validated.checks;
  gate(
    validated.checks.every((check) => check.passed),
    'Existing artifact validation failed.',
  );
  await timed('trustedShadow', async () => {
    for (const customerId of ids) {
      const result = await service.jit.shadow(id, { customerId });
      gate(result.shadow.status === 'match', 'Existing trusted shadow failed.');
    }
  });
  gate(service.jit.shadowStatus(id).ready, 'Shadow readiness failed.');
  await timed('promotion', async () => {
    service.jit.approve(
      id,
      'User-authorized isolated support-agent experiment after real shadow and independent validation.',
    );
    service.jit.deploy(id);
    service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
  });
  setupMs = performance.now() - began;
  console.log(
    JSON.stringify({
      stage: 'setup_validated',
      setupMs,
      cases: supportCases.length,
      trialsRequested,
    }),
  );
  await timed('warmup', async () => {
    for (const task of [supportCases[0], supportCases[3], supportCases[6]])
      for (const arm of arms) {
        const run = await executeSupport(task, arm);
        warmups.push(run);
        gate(
          run.assessment.passed && !run.usedFallback,
          `Support warmup failed: ${task.id}/${arm}.`,
        );
      }
  });
  await timed('measurement', async () => {
    // Interleave customers; rotate all three arm positions to distribute warmup/cache/order noise.
    const interleaved = [0, 3, 6, 1, 4, 7, 2, 5, 8].map((index) => supportCases[index]);
    for (let index = 0; index < trialsRequested; index++) {
      const task = interleaved[index % interleaved.length];
      const rotation = index % arms.length;
      const order = [...arms.slice(rotation), ...arms.slice(0, rotation)];
      const entry: (typeof measured)[number] = {
        index,
        case: task,
        heldOut: task.customerId === 'C-303',
        order,
        runs: {},
        allPassed: false,
        decisionsEquivalent: false,
      };
      measured.push(entry); // retain partial trials and their costs if a gate fails
      for (const arm of order) entry.runs[arm] = await executeSupport(task, arm);
      const runs = arms.map((arm) => entry.runs[arm]!);
      entry.allPassed = runs.every((run) => run.assessment.passed && !run.usedFallback);
      entry.decisionsEquivalent = runs.every(
        (run) =>
          JSON.stringify(supportProjection(run.response)) ===
          JSON.stringify(supportProjection(runs[0].response)),
      );
      console.log(
        JSON.stringify({
          stage: 'trial',
          trial: index + 1,
          case: task.id,
          allPassed: entry.allPassed,
          decisionsEquivalent: entry.decisionsEquivalent,
          results: Object.fromEntries(
            runs.map((run) => [
              run.arm,
              {
                totalTokens: run.measurement.totalTokens,
                modelCalls: run.measurement.modelCalls,
                latencyMs: run.measurement.durationMs,
                cost: run.apiEquivalentCostUsd,
              },
            ]),
          ),
        }),
      );
      gate(
        entry.allPassed && entry.decisionsEquivalent,
        'Support correctness/routing gate failed; stopping.',
      );
    }
  });
  await timed('authorizationChecks', async () => {
    for (const [name, deniedContext] of [
      ['scope_denied', { ...context(), scopes: ['crm:read', 'orders:read'] }],
      ['record_denied', { ...context(), allowedCustomerIds: ['C-202'] }],
    ] as const) {
      const readCount = physicalReads;
      const modelCount = nativeRuns.length;
      const denied = await client(false, () => ({
        ...deniedContext,
        scopes: [...deniedContext.scopes],
        allowedCustomerIds: [...deniedContext.allowedCustomerIds],
      })).execute(request('C-101'));
      const passed =
        denied.outcome === 'denied' &&
        physicalReads === readCount &&
        nativeRuns.length === modelCount;
      security.push({ name, passed });
      gate(passed, 'Support integration authorization regression.');
    }
  });
  await timed('quarantineFallback', async () => {
    service.jit.quarantine(id);
    fallback = await executeSupport(supportCases[0], 'compiled_tool');
    gate(
      fallback.usedFallback && fallback.assessment.passed,
      'Support task lost correctness during native context fallback.',
    );
  });
} catch (error) {
  failure =
    supportAgent.lastFailure ??
    contextAgent.lastFailure ??
    (error instanceof Error ? error.message : 'Experiment failed.');
  process.exitCode = 1;
} finally {
  await supportAgent.close();
  await contextAgent.close();
  const completeTrials = measured.filter((entry) => arms.every((arm) => entry.runs[arm]));
  const samples = Object.fromEntries(
    arms.map((arm) => [arm, completeTrials.map((entry) => entry.runs[arm]!)]),
  ) as Record<Arm, SupportRun[]>;
  const means = Object.fromEntries(
    arms.map((arm) => [
      arm,
      samples[arm].length ? mean(samples[arm].map((run) => run.measurement)) : undefined,
    ]),
  ) as Record<Arm, ReturnType<typeof mean> | undefined>;
  const costMean = (runs: SupportRun[]) =>
    !runs.length || runs.some((run) => run.apiEquivalentCostUsd === null)
      ? null
      : runs.reduce((sum, run) => sum + run.apiEquivalentCostUsd!, 0) / runs.length;
  const base = means.baseline;
  const compare = (arm: Arm) =>
    base && means[arm]
      ? {
          ...Object.fromEntries(
            numericKeys.map((key) => [key, comparison(base[key], means[arm]![key])]),
          ),
          apiEquivalentCostUsd: comparison(costMean(samples.baseline), costMean(samples[arm])),
        }
      : null;
  const sumNativeCost = (runs: typeof nativeRuns) =>
    runs.some((run) => run.apiEquivalentCostUsd === null)
      ? null
      : runs.reduce((sum, run) => sum + run.apiEquivalentCostUsd!, 0);
  const setupRuns = nativeRuns.filter((run) =>
    ['observation', 'trustedShadow'].includes(run.phase),
  );
  const setupCost = sumNativeCost(setupRuns);
  const costSaving = (arm: Arm) =>
    costMean(samples.baseline) === null || costMean(samples[arm]) === null
      ? null
      : costMean(samples.baseline)! - costMean(samples[arm])!;
  const report = {
    capturedAt: new Date().toISOString(),
    complete: !failure && completeTrials.length === trialsRequested,
    failure,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      provider,
      model,
      reasoningEffort: 'low for support, none for context setup/fallback',
      authMode: 'ChatGPT',
      businessSnapshot: 'fixtures-v1',
      providerInference: 'live',
      toolDelayMs: 2,
    },
    methodology: {
      task: 'Assess a late-delivery/refund complaint and draft a grounded support reply.',
      compiledRegion:
        'existing read-only load_customer_context only; recommendations and replies are always generated by the model',
      arms: {
        baseline:
          'Natural single agent with three existing read tools. No forced extra calls or sequential reads.',
        compiled_tool:
          'Same agent, with the existing compiled context capability exposed as one read tool. Agent still chooses to invoke it.',
        compiled_prefetch:
          'Application knows context is required and invokes the same SDK capability before the model. The model still assesses the account and writes the reply.',
      },
      freshEphemeralThreads: true,
      identicalModelPolicyAndOutputSchema: true,
      armOrder: 'rotated',
      cases: supportCases,
      repeatsPerCase: trialsRequested / 9,
      trainingCustomerIds: ['C-101', 'C-202'],
      heldOutCustomerId: 'C-303',
      warmupRequests: warmups.length,
      independentOracle:
        'hand-stated evidence and recommended actions for each customer, separate from agent/compiler/adapters',
      replyAssessment:
        'objective order/delay grounding, bounded output, next-step presence and prohibited financial-action claims; not human-rated writing quality',
      fullRequestLatency:
        'includes SDK offer, signature/guards, reads, model selection/reply work and provider thread cleanup',
      measurements:
        'all completed provider responses and actual underlying adapter reads, with compiled/native context fallback costs added',
    },
    pricing: {
      ...rateCard,
      verifiedAt: '2026-10-05',
      kind: 'API-equivalent estimate, not actual ChatGPT billing',
      actualBilledCostUsd: null,
      controlPlaneAndConnectorCostUsd: null,
    },
    candidate,
    setup: {
      wallMs: setupMs,
      phaseDurationsMs: Object.fromEntries(
        Object.entries(durations).filter(
          ([name]) =>
            !['warmup', 'measurement', 'authorizationChecks', 'quarantineFallback'].includes(name),
        ),
      ),
      apiEquivalentCostUsd: setupCost,
      nativeRuns: setupRuns,
      compilationAndFixtureValidationModelCalls: 0,
    },
    steadyState: Object.fromEntries(
      arms.map((arm) => [
        arm,
        {
          mean: means[arm],
          apiEquivalentCostUsd: costMean(samples[arm]),
          latency: samples[arm].length
            ? latencySummary(samples[arm].map((run) => run.measurement))
            : null,
          successRate: samples[arm].length
            ? samples[arm].filter((run) => run.assessment.passed).length / samples[arm].length
            : null,
          fallbackRate: samples[arm].length
            ? samples[arm].filter((run) => run.usedFallback).length / samples[arm].length
            : null,
          meanModelVisibleToolCalls: samples[arm].length
            ? samples[arm].reduce((sum, run) => sum + run.modelToolCalls.length, 0) /
              samples[arm].length
            : null,
        },
      ]),
    ),
    comparisons: {
      compiled_tool: compare('compiled_tool'),
      compiled_prefetch: compare('compiled_prefetch'),
    },
    breakEven: Object.fromEntries(
      ['compiled_tool', 'compiled_prefetch'].map((value) => {
        const arm = value as Arm;
        return [
          arm,
          {
            conservativeInferenceEquivalentExecutions: breakEven(setupCost, costSaving(arm)),
            conservativeWallTimeExecutions: breakEven(
              setupMs,
              base?.durationMs == null || means[arm]?.durationMs == null
                ? null
                : base.durationMs - means[arm]!.durationMs!,
            ),
            actualTotalEconomicExecutions: null,
          },
        ];
      }),
    ),
    correctness: {
      completeTrials: completeTrials.length,
      passingTrials: completeTrials.filter((entry) => entry.allPassed && entry.decisionsEquivalent)
        .length,
      heldOutTrials: completeTrials.filter((entry) => entry.heldOut).length,
      security,
      fallback,
    },
    providerAccounting: {
      reportedCompletedInferenceResponses: nativeRuns.reduce((sum, run) => sum + run.responses, 0),
      contextWarnings: contextAgent.warnings,
      supportWarnings: supportAgent.warnings,
      reroutes: contextAgent.reroutes + supportAgent.reroutes,
      transportRetryAttempts: null,
      limitation:
        'Completed inference counts are provider-reported. This account does not expose audited transport retries or actual billing.',
    },
    experimentTotals: {
      elapsedMs: performance.now() - began,
      cpuMicros: process.cpuUsage(cpuStart),
      nativeRuns,
      apiEquivalentCostUsd: sumNativeCost(nativeRuns),
      note: 'All setup, warmup, measured requests, failures and fallback validation are included. Deterministic CPU/hosting/connector/engineering costs are unpriced; no total business ROI claim.',
    },
    warmups,
    trials: measured,
  };
  writeFileSync(
    'docs/support-agent-benchmark.json',
    await format(JSON.stringify(report), { parser: 'json', printWidth: 96 }),
  );
  console.log(
    JSON.stringify({
      complete: report.complete,
      failure,
      comparisons: report.comparisons,
      breakEven: report.breakEven,
      completedTrials: completeTrials.length,
    }),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
}
