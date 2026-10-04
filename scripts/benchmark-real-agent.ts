import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { format } from 'prettier';
import { createApp } from '../src/app.js';
import { FoundryClient } from '../src/integration/client.js';
import {
  localContext,
  mockAdapters,
  fixtureResult,
  type RuntimeContext,
} from '../src/runtime/adapters/registry.js';
import { sameContext } from '../src/runtime/observable.js';
import { dispatch, type DispatchOutcome } from '../src/runtime/dispatcher.js';
import { ArtifactSigner } from '../src/security/signing.js';
import { ApiKeyAuthenticator, localIdentity } from '../src/security/identity.js';
import { Store } from '../src/registry/store.js';
import type { Measurement } from '../src/telemetry/measurement.js';
import {
  CustomerContextAgent,
  apiEquivalentCost,
  model,
  provider,
  rateCard,
} from './experiments/customer-agent.js';
import { ProviderRequestCounters } from './experiments/metrics.js';
import {
  mean,
  comparison,
  breakEven,
  latencySummary,
  numericKeys,
} from './experiments/statistics.js';

const pairsRequested = Number(process.env.FOUNDRY_EXPERIMENT_PAIRS ?? 30);
if (!Number.isInteger(pairsRequested) || pairsRequested < 6 || pairsRequested > 100)
  throw new Error('Use 6–100 paired requests.');
const ids = ['C-101', 'C-202', 'C-303'];
const context = (): RuntimeContext => ({ ...localContext(), allowedCustomerIds: [...ids] });
const toolDelayMs = 2; // existing adapter default; no artificial baseline delays or duplicates
const adapters = mockAdapters({ delayMs: toolDelayMs });
type NativeRun = {
  measurement: Measurement | undefined;
  status: string;
  responses: number;
  apiEquivalentCostUsd: number | null;
  phase: string;
};
let phase = 'initialization';
const nativeRuns: NativeRun[] = [];
const counters = new ProviderRequestCounters();
const agent = new CustomerContextAgent({
  adapters,
  context,
  agentId: localIdentity.agentId,
  metricsEndpoint: await counters.start(),
  onRun: (run) => nativeRuns.push({ ...run, phase }),
});
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const apiKey = 'real_agent_experiment_local_credential_000000';
const auth = new ApiKeyAuthenticator([
  { sha256: createHash('sha256').update(apiKey).digest('hex'), identity: localIdentity },
]);
const store = new Store(':memory:');
const { app, service } = createApp(store, false, {
  auth,
  signer: new ArtifactSigner(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  runtime: {
    adapters: () => adapters,
    context,
    agent: (task, checkpoint) => agent.native(task, checkpoint, undefined),
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
let controlCalls = 0;
const transport: typeof fetch = (input, init) => {
  controlCalls++;
  return fetch(input, init);
};
const client = (shareReplayEvidence = false, overrideContext = context) =>
  new FoundryClient({
    ...localIdentity,
    context: overrideContext,
    adapters,
    native: agent.native,
    model,
    provider,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey,
    trustedPublicKey: publicKey,
    fetch: transport,
    shareReplayEvidence,
  });
const oracle = (customerId: string) => ({
  customer_id: customerId,
  crm_get_customer: fixtureResult('crm.getCustomer', customerId),
  orders_list: fixtureResult('orders.list', customerId),
  payments_refund_history: fixtureResult('payments.refundHistory', customerId),
});
const gate = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const outputPath = 'docs/real-agent-benchmark.json';
const experimentStart = performance.now();
const cpuStart = process.cpuUsage();
const phaseDurations: Record<string, number> = {};
const measuredPairs: {
  index: number;
  customerId: string;
  heldOut: boolean;
  order: string[];
  baseline: DispatchOutcome;
  optimized: DispatchOutcome;
  baselineApiEquivalentCostUsd: number | null;
  optimizedApiEquivalentCostUsd: number | null;
  baselineControlApiCalls: number;
  optimizedControlApiCalls: number;
  baselineNativeDurationMs: number;
  matched: boolean;
}[] = [];
const warmups: { customerId: string; baseline: Measurement; optimized: Measurement }[] = [];
const security: { name: string; passed: boolean }[] = [];
let setupWallMs = 0;
let validationChecks: unknown;
let artifactDigest: string | undefined;
let fallback: DispatchOutcome | undefined;
let failure: string | undefined;
let candidateId: string | undefined;
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  phase = name;
  const start = performance.now();
  try {
    return await fn();
  } finally {
    phaseDurations[name] = performance.now() - start;
  }
}
const request = (customerId: string) => ({ kind: 'customer_context', input: { customerId } });
const measuredClient = client();
async function execute(customerId: string, mode: 'observe' | 'live') {
  service.jit.configureRouting({ mode, rolloutPercent: mode === 'live' ? 100 : 0 });
  const callsBefore = controlCalls;
  const start = performance.now();
  const result = await measuredClient.execute(request(customerId));
  result.measurement.durationMs = performance.now() - start; // includes final telemetry + archive
  result.durationMs = result.measurement.durationMs;
  const cost =
    result.measurement.inputTokens === null ||
    result.measurement.cachedInputTokens === null ||
    result.measurement.outputTokens === null
      ? null
      : apiEquivalentCost(
          result.measurement.inputTokens,
          result.measurement.cachedInputTokens,
          result.measurement.outputTokens,
        );
  return { result, cost, controlApiCalls: controlCalls - callsBefore };
}
try {
  await timed('providerInitialization', () => agent.start());
  await timed('observation', async () => {
    for (const id of ids.slice(0, 2)) {
      const run = await client(true).execute(request(id));
      gate(
        run.outcome === 'success' && sameContext(run.result, oracle(id)),
        'Real observation failed oracle gate.',
      );
    }
  });
  const candidate = await timed('analysisAndCompilation', async () => {
    const patterns = service.jit.analyze();
    gate(
      patterns.length === 1,
      'Real trajectories did not establish one eligible structural pattern.',
    );
    return service.jit.compilePattern(patterns[0].id);
  });
  candidateId = candidate.id;
  artifactDigest = candidate.digest;
  const verified = await timed('validation', () => service.jit.verify(candidate.id));
  validationChecks = verified.checks;
  gate(
    verified.checks.every((check) => check.passed),
    'Artifact validation failed.',
  );
  await timed('trustedShadow', async () => {
    for (const id of ids) {
      const shadow = await service.jit.shadow(candidate.id, { customerId: id });
      gate(
        shadow.shadow.status === 'match' && sameContext(shadow.authoritative.result, oracle(id)),
        'Real native-authoritative shadow failed.',
      );
    }
  });
  gate(service.jit.shadowStatus(candidate.id).ready, 'Trusted shadow readiness failed.');
  await timed('approvalAndDeployment', async () => {
    service.jit.approve(
      candidate.id,
      'User-authorized isolated real-agent experiment; current validation and real shadow passed.',
    );
    service.jit.deploy(candidate.id);
  });
  setupWallMs = performance.now() - experimentStart;
  console.log(
    JSON.stringify({
      stage: 'setup_validated',
      model,
      observationRequests: 2,
      shadowRequests: 3,
      setupWallMs,
    }),
  );
  await timed('warmup', async () => {
    for (const id of ids) {
      const a = await execute(id, 'observe');
      const b = await execute(id, 'live');
      gate(
        a.result.outcome === 'success' &&
          b.result.outcome === 'success' &&
          sameContext(a.result.result, b.result.result) &&
          sameContext(a.result.result, oracle(id)),
        'Warmup equivalence failed.',
      );
      warmups.push({
        customerId: id,
        baseline: a.result.measurement,
        optimized: b.result.measurement,
      });
    }
  });
  await timed('pairedMeasurement', async () => {
    for (let index = 0; index < pairsRequested; index++) {
      const id = ids[index % ids.length];
      const order = index % 2 ? (['live', 'observe'] as const) : (['observe', 'live'] as const);
      const results = new Map<string, Awaited<ReturnType<typeof execute>>>();
      let baselineNativeDurationMs = 0;
      for (const mode of order) {
        const run = await execute(id, mode);
        if (mode === 'observe')
          baselineNativeDurationMs = nativeRuns.at(-1)?.measurement?.durationMs ?? 0;
        results.set(mode, run);
      }
      const a = results.get('observe')!;
      const b = results.get('live')!;
      const matched =
        a.result.outcome === 'success' &&
        b.result.outcome === 'success' &&
        sameContext(a.result.result, b.result.result) &&
        sameContext(a.result.result, oracle(id));
      measuredPairs.push({
        index,
        customerId: id,
        heldOut: id === 'C-303',
        order: [...order],
        baseline: a.result,
        optimized: b.result,
        baselineApiEquivalentCostUsd: a.cost,
        optimizedApiEquivalentCostUsd: b.cost,
        baselineControlApiCalls: a.controlApiCalls,
        optimizedControlApiCalls: b.controlApiCalls,
        baselineNativeDurationMs,
        matched,
      });
      console.log(
        JSON.stringify({
          stage: 'pair',
          pair: index + 1,
          customerId: id,
          matched,
          baselineMs: a.result.durationMs,
          optimizedMs: b.result.durationMs,
          baselineTokens: a.result.measurement.totalTokens,
          baselineModelCalls: a.result.measurement.modelCalls,
        }),
      );
      gate(matched, 'Paired full-context oracle gate failed; stopping.');
      gate(
        a.result.mode === 'agent' && b.result.mode === 'compiled',
        'Steady-state routing unexpectedly fell back; stopping.',
      );
    }
  });
  await timed('authorizationChecks', async () => {
    const artifact = service.jit.get(candidate.id);
    for (const [name, ctx] of [
      ['missing_scope', { ...context(), scopes: ['crm:read', 'orders:read'] }],
      ['record_denied', { ...context(), allowedCustomerIds: ['C-202'] }],
      ['tenant_mismatch', { ...context(), tenantId: 'another-tenant' }],
      ['principal_mismatch', { ...context(), principalId: 'another-principal' }],
    ] satisfies [string, RuntimeContext][]) {
      let toolCalls = 0;
      let modelCalls = 0;
      const result = await dispatch(request('C-101'), [artifact], {
        context: ctx,
        adapters: async (...args) => {
          toolCalls++;
          return adapters(...args);
        },
        agent: async () => {
          modelCalls++;
          throw new Error('Denied execution reached agent.');
        },
      });
      const passed = result.outcome === 'denied' && toolCalls === 0 && modelCalls === 0;
      security.push({ name, passed });
      gate(passed, 'Compiled authorization regression.');
      if (['missing_scope', 'record_denied'].includes(name)) {
        const before = nativeRuns.length;
        const denied = await client(false, () => ctx).execute(request('C-101'));
        const nativePassed = denied.outcome === 'denied' && nativeRuns.length === before;
        security.push({ name: `native_${name}`, passed: nativePassed });
        gate(nativePassed, 'Native authorization regression.');
      }
    }
  });
  await timed('rollbackFallbackValidation', async () => {
    service.jit.quarantine(candidate.id);
    const run = await execute('C-101', 'live');
    fallback = run.result;
    gate(
      fallback.mode === 'agent' &&
        fallback.outcome === 'success' &&
        sameContext(fallback.result, oracle('C-101')),
      'Quarantine fallback failed.',
    );
  });
} catch (error) {
  // These are harness gate labels, not model text, prompts or reasoning.
  failure = agent.lastFailure ?? (error instanceof Error ? error.message : 'Experiment failed.');
  process.exitCode = 1;
} finally {
  phase = 'shutdown';
  await agent.close();
  const metrics = counters.result();
  const reportedResponses = nativeRuns.reduce((sum, run) => sum + run.responses, 0);
  const transportRequests = metrics['codex.api_request'] + metrics['codex.websocket.request'];
  const requestCountCrossCheck =
    counters.received > 0 && counters.rejected === 0 && transportRequests === reportedResponses;
  const base = measuredPairs.map((pair) => pair.baseline.measurement);
  const opt = measuredPairs.map((pair) => pair.optimized.measurement);
  const bm = base.length ? mean(base) : undefined;
  const om = opt.length ? mean(opt) : undefined;
  const meanCost = (key: 'baselineApiEquivalentCostUsd' | 'optimizedApiEquivalentCostUsd') =>
    measuredPairs.some((pair) => pair[key] === null) || !measuredPairs.length
      ? null
      : measuredPairs.reduce((sum, pair) => sum + pair[key]!, 0) / measuredPairs.length;
  const baselineCost = meanCost('baselineApiEquivalentCostUsd');
  const optimizedCost = meanCost('optimizedApiEquivalentCostUsd');
  const sumCost = (runs: NativeRun[]) =>
    runs.some((run) => run.apiEquivalentCostUsd === null)
      ? null
      : runs.reduce((sum, run) => sum + run.apiEquivalentCostUsd!, 0);
  const setupRuns = nativeRuns.filter((run) =>
    ['observation', 'trustedShadow'].includes(run.phase),
  );
  const setupCost = sumCost(setupRuns);
  const rate = (runs: Measurement[]) =>
    runs.length
      ? (runs.filter((run) => run.outcome === 'success').length / runs.length) * 100
      : null;
  const report = {
    capturedAt: new Date().toISOString(),
    complete: !failure && measuredPairs.length === pairsRequested,
    failure,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      provider,
      model,
      reasoningEffort: 'none',
      authMode: 'ChatGPT subscription',
      businessData: 'deterministic fixtures-v1 through existing typed adapters',
      toolDelayMs,
      concurrency: 1,
      pairsRequested,
      measuredPairs: measuredPairs.length,
      warmupPairs: warmups.length,
    },
    methodology: {
      trainingIds: ids.slice(0, 2),
      heldOutId: ids[2],
      task: 'load_customer_context(customerId)',
      alternatingPairOrder: true,
      freshEphemeralThreadPerAgentRequest: true,
      fullSdkWallTimeIncludingTelemetry: true,
      privateReasoningRetained: false,
      oracle: 'existing independent fixture oracle plus sameContext full-resource equivalence',
      baseline:
        'Efficient real agent: chooses reads without forced duplicates; baseline runs include observation SDK overhead.',
      modelCalls:
        'Distinct additive provider-reported completed inference responses; transport counters cross-check retries separately.',
      modelEventTiming:
        'Observed response intervals; includes intervening tool handling, not pure inference time.',
    },
    pricing: {
      ...rateCard,
      kind: 'API-equivalent estimate, not actual subscription billing',
      actualBilledCostUsd: null,
      controlPlaneHostingCostUsd: null,
      adapterBackendCostUsd: null,
      engineeringAndHumanApprovalCostUsd: null,
      warning:
        'Total monetary ROI is not established because these costs are unpriced. CPU/wall overhead is included below. CLI context overhead limits generalization to a minimal Responses API client.',
    },
    candidate: { id: candidateId, digest: artifactDigest, validationChecks, shadowCoverage: ids },
    oneTime: {
      phaseDurationsMs: Object.fromEntries(
        Object.entries(phaseDurations).filter(([key]) =>
          [
            'providerInitialization',
            'observation',
            'analysisAndCompilation',
            'validation',
            'trustedShadow',
            'approvalAndDeployment',
          ].includes(key),
        ),
      ),
      setupWallMs,
      providerInitializationMs: agent.startupMs,
      nativeRuns: setupRuns,
      apiEquivalentCostUsd: setupCost,
      compilationModelCalls: 0,
      compilationTokens: 0,
      fixtureValidationModelCalls: 0,
      fixtureValidationTokens: 0,
      conservativeAccounting:
        'Charges both ordinary observation requests in full, plus all three real native shadow requests. Compilation, independent fixture validation, signing and approval/deployment wall time are included.',
      unpricedAndUnmeasuredSetup:
        'Existing control-plane bootstrap and module imports precede the setup clock. CPU/hosting/deployment and human approval costs are unpriced, not assumed free. Break-even is measured inference-equivalent and workflow-wall-time only.',
    },
    comparison:
      bm && om
        ? {
            ...Object.fromEntries(numericKeys.map((key) => [key, comparison(bm[key], om[key])])),
            apiEquivalentCostUsd: comparison(baselineCost, optimizedCost),
            actualBilledCostUsd: comparison(null, null),
            successRatePercent: comparison(rate(base), rate(opt)),
            fallbackRatePercent: comparison(
              (measuredPairs.filter((pair) => pair.baseline.mode !== 'agent').length /
                measuredPairs.length) *
                100,
              (measuredPairs.filter((pair) => pair.optimized.mode !== 'compiled').length /
                measuredPairs.length) *
                100,
            ),
          }
        : null,
    latency: base.length
      ? {
          baseline: latencySummary(base),
          optimized: latencySummary(opt),
          baselineTimeOutsideObservationWindowMeanMs:
            measuredPairs.reduce(
              (sum, pair) => sum + pair.baseline.durationMs - pair.baselineNativeDurationMs,
              0,
            ) / measuredPairs.length,
          optimizedAllInclusiveMeanMs: om?.durationMs,
          observationWindowNote:
            'Observer begins before capability offer retrieval. Time outside its window includes thread archive and telemetry, and is not an isolated SDK overhead measurement.',
        }
      : null,
    breakEven: {
      conservativeApiEquivalentExecutions: breakEven(
        setupCost,
        baselineCost === null || optimizedCost === null ? null : baselineCost - optimizedCost,
      ),
      conservativeWallTimeExecutions: breakEven(
        setupWallMs,
        bm?.durationMs == null || om?.durationMs == null ? null : bm.durationMs - om.durationMs,
      ),
      incrementalApiEquivalentExecutionsExcludingOrdinaryObservations: breakEven(
        sumCost(setupRuns.filter((run) => run.phase === 'trustedShadow')),
        baselineCost === null || optimizedCost === null ? null : baselineCost - optimizedCost,
      ),
      actualTotalMonetaryExecutions: null,
    },
    correctness: {
      fullMatches: measuredPairs.filter((pair) => pair.matched).length,
      measuredComparisons: measuredPairs.length,
      security,
      quarantinedFallback: fallback,
      heldOutMeasuredPairs: measuredPairs.filter((pair) => pair.heldOut).length,
    },
    providerAccounting: {
      reportedResponses,
      transportCounters: metrics,
      metricExportsReceived: counters.received,
      metricExportsRejected: counters.rejected,
      requestCountCrossCheck,
      warnings: agent.warnings,
      reroutes: agent.reroutes,
      transportCounterLimitation: requestCountCrossCheck
        ? undefined
        : 'Transport counters were unavailable or did not reconcile. Model calls count provider-reported completed inference responses; hidden failed/retried attempts cannot be audited.',
    },
    experimentTotals: {
      elapsedMs: performance.now() - experimentStart,
      harnessCpuMicros: process.cpuUsage(cpuStart),
      maxRssKb: process.resourceUsage().maxRSS,
      nativeRequests: nativeRuns.length,
      totalApiEquivalentCostUsd: sumCost(nativeRuns),
      nativeRuns,
      phaseDurationsMs: phaseDurations,
      interpretation:
        'Includes setup, warmups, measured baselines and the real rollback fallback check. Development pilots are recorded separately in the written report. Harness CPU excludes the separate Codex process; wall time includes it.',
    },
    warmups,
    pairs: measuredPairs,
  };
  writeFileSync(
    outputPath,
    await format(JSON.stringify(report), { parser: 'json', printWidth: 96 }),
  );
  console.log(
    JSON.stringify({
      outputPath,
      complete: report.complete,
      failure,
      comparison: report.comparison,
      breakEven: report.breakEven,
      providerAccounting: report.providerAccounting,
    }),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await counters.close();
  store.close();
}
