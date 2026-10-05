import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { format } from 'prettier';
import { createApp } from '../src/app.js';
import { Store } from '../src/registry/store.js';
import { FoundryClient, RequestReadCache, selectExecution } from '../src/integration/client.js';
import { TrajectoryObserver } from '../src/exploration/observe.js';
import {
  authorizeReads,
  contracts,
  localContext,
  type AdapterRunner,
  type RuntimeContext,
} from '../src/runtime/adapters/registry.js';
import { DomainError } from '../src/domain.js';
import { AgentExecutionError, type DispatchOutcome } from '../src/runtime/dispatcher.js';
import { contextProjection, sameContext } from '../src/runtime/observable.js';
import { emptyMeasurement, type Measurement } from '../src/telemetry/measurement.js';
import { ArtifactSigner } from '../src/security/signing.js';
import { ApiKeyAuthenticator, localIdentity } from '../src/security/identity.js';
import {
  CustomerContextAgent,
  tools,
  executeTool,
  operations,
  apiEquivalentCost,
  provider,
  model,
  rateCard,
} from './experiments/customer-agent.js';
import { compiledContextTool } from './experiments/support-task.js';
import {
  developmentCases,
  heldoutCases,
  allReads,
  routingFixture,
  routingResponseSchema,
  routingInstructions,
  routingPrompt,
  assessRouting,
  experimentArms,
  balancedSchedule,
  type RoutingCase,
  type ExperimentArm,
  type RoutingResponse,
} from './experiments/routing-task.js';
import { sumMeasurements } from './experiments/statistics.js';
import { summarizeRouting, pairedRouting } from './experiments/routing-statistics.js';

const split = process.argv[2];
if (split !== 'development' && split !== 'heldout')
  throw new Error('Choose development or heldout.');
const output = `docs/routing-agent-${split}.json`;
const preflights =
  split === 'development'
    ? [
        'docs/routing-agent-development-preflight.json',
        'docs/routing-agent-development-revalidation-preflight.json',
      ]
        .filter((path) => existsSync(path))
        .map((path) => {
          const evidence = JSON.parse(readFileSync(path, 'utf8')) as {
            experimentTotals: { apiEquivalentCostUsd: number | null; nativeRequests: number };
            providerAccounting: { completedInferenceResponses: number };
          };
          return {
            path,
            apiEquivalentCostUsd: evidence.experimentTotals.apiEquivalentCostUsd,
            nativeRequests: evidence.experimentTotals.nativeRequests,
            completedInferenceResponses: evidence.providerAccounting.completedInferenceResponses,
          };
        })
    : [];
const preflightCost = preflights.some((run) => run.apiEquivalentCostUsd === null)
  ? null
  : preflights.reduce((sum, run) => sum + run.apiEquivalentCostUsd!, 0);
if (existsSync(output)) throw new Error('Refusing to overwrite retained live evidence.');
const cases = split === 'development' ? developmentCases : heldoutCases;
const repeats = split === 'development' ? 1 : 2;
const seed = split === 'development' ? 41107 : 71109;
const schedule = balancedSchedule(cases, repeats, seed);
const began = performance.now();
const cpuStart = process.cpuUsage();
const directory = mkdtempSync(join(tmpdir(), 'foundry-routing-evaluation-'));
const snapshot = join(directory, 'approved.sqlite');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(
  [
    'src/integration/selection.ts',
    'src/integration/client.ts',
    'src/integration/request-reads.ts',
    'scripts/experiments/routing-task.ts',
    'scripts/benchmark-routing-agent.ts',
  ].map((path) => [path, sha(readFileSync(path))]),
);
const identity = {
  ...localIdentity,
  customerIds: ['C-101', 'C-202', 'C-303', 'C-404', 'C-505', 'C-606'],
};
const baseContext = (): RuntimeContext => ({
  ...localContext(),
  allowedCustomerIds: [...identity.customerIds],
});
let activeContext = baseContext();
let activeAdapters: AdapterRunner = async (operation, args, context, signal) => {
  authorizeReads(context, args, [operation]);
  await delay(2, undefined, { signal });
  return routingFixture(operation, args.customerId);
};
let phase = 'initialization';
let budgetStopped: string | undefined;
const maxNestedContextRequests = split === 'development' ? 12 : 24;
const ledger: {
  phase: string;
  role: string;
  measurement: Measurement | undefined;
  status: string;
  responses: number;
  apiEquivalentCostUsd: number | null;
}[] = [];
const observeRun =
  (role: string) =>
  (
    run: Parameters<NonNullable<ConstructorParameters<typeof CustomerContextAgent>[0]['onRun']>>[0],
  ) =>
    ledger.push({ ...run, role, phase });
const contextAgent = new CustomerContextAgent({
  adapters: (...args) => activeAdapters(...args),
  context: () => activeContext,
  agentId: identity.agentId,
  onRun: observeRun('context'),
  maxModelCalls: 6,
  maxToolCalls: 10,
  timeoutMs: 60000,
});
const supportAgent = new CustomerContextAgent({
  adapters: (...args) => activeAdapters(...args),
  context: () => activeContext,
  agentId: identity.agentId,
  onRun: observeRun('support'),
  maxModelCalls: 6,
  maxToolCalls: 10,
  timeoutMs: 60000,
});
const native: ConstructorParameters<typeof FoundryClient>[0]['native'] = async (
  task,
  checkpoint,
  supplied,
) => {
  if (
    ['measurement', 'warmup'].includes(phase) &&
    ledger.filter(
      (entry) => entry.role === 'context' && ['measurement', 'warmup'].includes(entry.phase),
    ).length >= maxNestedContextRequests
  ) {
    budgetStopped = 'Nested context-agent request budget reached.';
    throw new AgentExecutionError({ ...emptyMeasurement(), outcome: 'failed' });
  }
  const input = task.input as { customerId: string };
  const observer =
    supplied ??
    new TrajectoryObserver({
      input,
      context: activeContext,
      adapters: activeAdapters,
      agentId: identity.agentId,
      provider,
      model,
      apiCallsKnown: true,
    });
  const run = await contextAgent.native(task, checkpoint, observer);
  const values = Object.fromEntries(
    observer.events
      .filter((e) => e.status === 'success')
      .map((e) => [e.operation, e.result?.projection]),
  );
  const complete = allReads.every((operation) => values[operation] !== undefined);
  if (!complete || !sameContext(run.result, joinedContext(input.customerId, values))) {
    const measured = { ...run.measurement!, outcome: 'failed' as const };
    const entry = ledger[ledger.length - 1];
    entry.status = 'evidence_failed';
    entry.measurement = measured;
    throw new AgentExecutionError(measured);
  }
  return run;
};
function joinedContext(
  customerId: string,
  values: Partial<Record<(typeof allReads)[number], unknown>>,
) {
  return {
    customer_id: customerId,
    crm_get_customer: values['crm.getCustomer'],
    orders_list: values['orders.list'],
    payments_refund_history: values['payments.refundHistory'],
  };
}
const keys = generateKeyPairSync('ed25519');
const signer = new ArtifactSigner(
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const apiKey = 'routing_sandbox_credential_0000000000000000';
const auth = new ApiKeyAuthenticator([{ sha256: sha(apiKey), identity }]);
async function host(path: string) {
  const store = new Store(path);
  const { app, service } = createApp(store, false, {
    auth,
    signer,
    runtime: {
      adapters: () => activeAdapters,
      context: () => activeContext,
      agent: (task, checkpoint) => native(task, checkpoint, undefined),
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    service,
    endpoint,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
const request = (customerId: string) => ({ kind: 'customer_context', input: { customerId } });
const guard = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};
const costOf = (measure: Measurement) =>
  measure.inputTokens === null ||
  measure.outputTokens === null ||
  measure.cachedInputTokens === null
    ? null
    : apiEquivalentCost(measure.inputTokens, measure.cachedInputTokens, measure.outputTokens);
const sumCost = (rows: typeof ledger) =>
  rows.some((r) => r.apiEquivalentCostUsd === null)
    ? null
    : rows.reduce((sum, r) => sum + r.apiEquivalentCostUsd!, 0);
const budget = () => {
  if (budgetStopped) throw new Error(budgetStopped);
  const mainCost = sumCost(ledger);
  const spent = mainCost === null || preflightCost === null ? null : mainCost + preflightCost;
  if (spent === null || spent > 9)
    throw new Error('Live estimate unknown or $9 inference-equivalent budget reached; stopping.');
};
const phases: Record<string, number> = {};
async function timed<T>(name: string, fn: () => Promise<T>) {
  phase = name;
  const at = performance.now();
  try {
    return await fn();
  } finally {
    phases[name] = performance.now() - at;
  }
}
let candidateId = '';
let setup: unknown;
let revalidation: unknown;
type BusinessRead = {
  operation: (typeof allReads)[number];
  startedAt: number;
  completedAt: number;
  status: 'success' | 'failed';
};
async function executeCase(task: RoutingCase, arm: ExperimentArm) {
  budget();
  const fixturePath = join(directory, `request-${Date.now()}-${arm}.sqlite`);
  copyFileSync(snapshot, fixturePath);
  const sandbox = await host(fixturePath);
  if (task.fault === 'quarantined') sandbox.service.jit.quarantine(candidateId);
  activeContext = {
    ...baseContext(),
    ...(task.fault === 'stale' ? { observedAt: Date.now() - 60000 } : {}),
    ...(task.fault === 'denied' ? { allowedCustomerIds: [] } : {}),
  };
  const businessReads: BusinessRead[] = [];
  const attempts = new Map<string, number>();
  const rawAdapters: AdapterRunner = async (operation, args, context, signal) => {
    authorizeReads(context, args, [operation]);
    const attempt = (attempts.get(operation) ?? 0) + 1;
    attempts.set(operation, attempt);
    if (attempt > 2) throw new DomainError('Sandbox read retry budget exhausted.', 503);
    const entry: BusinessRead = {
      operation,
      startedAt: performance.now(),
      completedAt: 0,
      status: 'success',
    };
    businessReads.push(entry);
    try {
      await delay(task.fault === 'slow' && operation === 'orders.list' ? 120 : 2, undefined, {
        signal,
      });
      if (
        operation === 'payments.refundHistory' &&
        (task.fault === 'permanent' || (task.fault === 'transient' && attempt === 1))
      )
        throw new DomainError('Sandbox read unavailable.', 503);
      return routingFixture(operation, args.customerId);
    } catch (error) {
      entry.status = 'failed';
      throw error;
    } finally {
      entry.completedAt = performance.now();
    }
  };
  const cache =
    arm === 'selector_direct_fallback'
      ? new RequestReadCache({
          adapters: rawAdapters,
          input: { customerId: task.customerId },
          freshnessMs: 30000,
        })
      : undefined;
  activeAdapters = cache?.adapters ?? rawAdapters;
  let controlApiCalls = 0;
  const transport: typeof fetch = (url, init) => {
    controlApiCalls++;
    return fetch(url, init);
  };
  const client = new FoundryClient({
    ...identity,
    context: () => activeContext,
    adapters: activeAdapters,
    native,
    provider,
    model,
    endpoint: sandbox.endpoint,
    apiKey,
    trustedPublicKey: publicKey,
    fetch: transport,
  });
  const contextRuns: DispatchOutcome[] = [];
  const serviceStatus = () =>
    Object.fromEntries(
      allReads.flatMap((operation) => {
        const reads = businessReads.filter((read) => read.operation === operation);
        return reads.length && reads[reads.length - 1].status === 'failed'
          ? [[operation, { status: 'unavailable', attempts: reads.length }]]
          : [];
      }),
    );
  const started = performance.now();
  const ledgerStart = ledger.length;
  let response: RoutingResponse | undefined;
  let assessment = { passed: false, checks: {} as Record<string, boolean> };
  let supportRun: Awaited<ReturnType<typeof supportAgent.runTask<RoutingResponse>>> | undefined;
  let failure: string | undefined;
  let denied = false;
  let prefetchFailed = false;
  let loaderAttempted = false;
  let available: Partial<Record<(typeof allReads)[number], unknown>> | undefined;
  let selectorMs = 0;
  const isSelector = arm.startsWith('selector_');
  let selectedMode:
    'normal' | 'compiled_tool' | 'compiled_prefetch' | 'handwritten_prefetch' | 'denied' = 'normal';
  let selectionReason = 'manual_original_tools';
  try {
    authorizeReads(activeContext, { customerId: task.customerId }, task.contract.reads);
  } catch {
    denied = true;
    selectedMode = 'denied';
    selectionReason = 'task_authorization_denied';
  }
  if (!denied) {
    if (isSelector) {
      const selection = selectExecution(
        task.contract,
        { customerId: task.customerId },
        activeContext,
      );
      selectorMs = selection.durationMs;
      selectedMode = selection.mode;
      selectionReason = selection.reason;
    } else if (
      arm === 'handwritten_prefetch' &&
      task.contract.requirement === 'known' &&
      task.contract.reads.length
    ) {
      selectedMode = 'handwritten_prefetch';
      selectionReason = 'manual_known_reads';
    } else if (
      arm === 'compiled_prefetch' &&
      task.contract.requirement === 'known' &&
      allReads.every((r) => task.contract.reads.includes(r))
    ) {
      selectedMode = 'compiled_prefetch';
      selectionReason = 'manual_known_complete_context';
    } else if (arm === 'compiled_tool' && allReads.every((r) => task.contract.reads.includes(r))) {
      selectedMode = 'compiled_tool';
      selectionReason = 'manual_complete_context_tool';
    } else if (arm !== 'normal')
      selectionReason = 'manual_prefetch_inapplicable_use_original_tools';
  }
  const observer = new TrajectoryObserver({
    input: { customerId: task.customerId },
    context: activeContext,
    adapters: activeAdapters,
    agentId: identity.agentId,
    provider,
    model,
    apiCallsKnown: true,
    allowedOperations: [...task.contract.reads],
  });
  const originalTools = tools.filter((tool) => task.contract.reads.includes(operations[tool.name]));
  const load = async () => {
    if (loaderAttempted)
      return {
        unavailable: true,
        message:
          'Context loader was already attempted. Use valid available data or original tools.',
      };
    loaderAttempted = true;
    const run = await client.execute(request(task.customerId), {
      fallback: arm === 'selector_direct_fallback' ? 'defer' : 'native',
    });
    contextRuns.push(run);
    if (run.outcome === 'denied') {
      denied = true;
      return { denied: true };
    }
    if (run.outcome !== 'success' || !run.result) {
      prefetchFailed = true;
      available = cache?.available(activeContext);
      return { unavailable: true, availableReads: available, serviceStatus: serviceStatus() };
    }
    const parsed = contextProjection(run.result);
    const expected = joinedContext(
      task.customerId,
      Object.fromEntries(allReads.map((op) => [op, routingFixture(op, task.customerId)])),
    );
    guard(sameContext(parsed, expected), 'Context differed from independent record snapshot.');
    available = {
      'crm.getCustomer': parsed.crm_get_customer,
      'orders.list': parsed.orders_list,
      'payments.refundHistory': parsed.payments_refund_history,
    };
    return parsed;
  };
  try {
    if (!denied && selectedMode === 'handwritten_prefetch') {
      available = {};
      const settled = await Promise.allSettled(
        task.contract.reads.map(async (operation) => {
          let value: unknown;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              value = (await observer.read(operation, { source: 'task_input', key: 'customerId' }))
                .value;
              break;
            } catch (error) {
              if (error instanceof DomainError && error.status === 403) throw error;
              if (attempt === 1) throw error;
            }
          }
          available![operation] = value;
        }),
      );
      prefetchFailed = settled.some((item) => item.status === 'rejected');
      available = Object.fromEntries(
        task.contract.reads
          .filter((operation) => operation in available!)
          .map((operation) => [operation, available![operation]]),
      );
    } else if (!denied && selectedMode === 'compiled_prefetch') await load();
    if (!denied) {
      const agentTools =
        selectedMode === 'compiled_tool'
          ? task.contract.requirement === 'agent_decides' || arm === 'selector_direct_fallback'
            ? [...originalTools, ...compiledContextTool]
            : compiledContextTool
          : (selectedMode === 'compiled_prefetch' || selectedMode === 'handwritten_prefetch') &&
              !prefetchFailed
            ? []
            : originalTools;
      supportRun = await supportAgent.runTask({
        input: { customerId: task.customerId },
        observer,
        allowedOperations: [...task.contract.reads],
        tools: agentTools,
        executeTool: async (capture, name, args) => {
          z.object({}).strict().parse(args);
          if (denied) throw new DomainError('Access denied.', 403);
          if (name === 'load_customer_context') return load();
          return executeTool(capture, name, args);
        },
        prompt: routingPrompt(
          task,
          available,
          prefetchFailed,
          businessReads.some((read) => read.status === 'failed') ? serviceStatus() : undefined,
        ),
        instructions: routingInstructions,
        outputSchema: z.toJSONSchema(routingResponseSchema),
        parseResult: (raw) => routingResponseSchema.parse(raw),
        effort: 'low',
        maxModelCalls: 6,
        maxToolCalls: 10,
        complete: (result, capture) => {
          capture.measurement.outcome = result.action === 'unavailable' ? 'failed' : 'success';
          capture.measurement.durationMs = performance.now() - started;
          return structuredClone(capture.measurement);
        },
      });
      response = supportRun.result;
      assessment = assessRouting(response, task, businessReads);
    } else
      assessment = {
        passed:
          task.fault === 'denied' && businessReads.length === 0 && ledger.length === ledgerStart,
        checks: {
          deniedBeforeInferenceAndReads:
            businessReads.length === 0 && ledger.length === ledgerStart,
        },
      };
  } catch (error) {
    failure =
      supportAgent.lastFailure ?? (error instanceof Error ? error.message : 'Request failed');
  }
  const nativeEntries = ledger.slice(ledgerStart);
  let measurement: Measurement;
  if (denied) measurement = { ...emptyMeasurement(), outcome: 'denied' };
  else if (supportRun)
    measurement = sumMeasurements(
      [supportRun.measurement, ...contextRuns.map((r) => r.measurement)],
      performance.now() - started,
    );
  else if (nativeEntries.every((r) => r.measurement))
    measurement = sumMeasurements(
      nativeEntries.map((r) => r.measurement!),
      performance.now() - started,
    );
  else
    measurement = {
      ...emptyMeasurement(),
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      totalTokens: null,
      modelCalls: null,
      outcome: 'failed',
    };
  measurement.outcome = denied
    ? 'denied'
    : response && response.action !== 'unavailable' && assessment.passed && !failure
      ? 'success'
      : 'failed';
  measurement.durationMs = performance.now() - started;
  measurement.toolCalls = businessReads.length;
  measurement.apiCalls = controlApiCalls;
  const unnecessaryReads = businessReads.filter(
    (r) => !task.permittedReads.includes(r.operation),
  ).length;
  const duplicateSuccessfulReads = businessReads.filter((r, index) =>
    businessReads
      .slice(0, index)
      .some(
        (prior) =>
          prior.operation === r.operation &&
          prior.status === 'success' &&
          r.startedAt - prior.completedAt < 30000,
      ),
  ).length;
  const result = {
    arm,
    selectedMode,
    selectionReason,
    loaderAttempted,
    effectiveMode: denied
      ? 'denied'
      : prefetchFailed
        ? 'original_agent_after_prefetch_miss'
        : contextRuns.some((run) => run.mode !== 'compiled')
          ? 'native_context_agent_then_support_agent'
          : selectedMode,
    selectorMs,
    measurement,
    apiEquivalentCostUsd: costOf(measurement),
    assessment,
    response,
    failure,
    usedFallback: contextRuns.some((run) => run.mode !== 'compiled'),
    prefetchFailed,
    suppliedReadOperations: Object.keys(available ?? {}),
    reusedCompletedReads: prefetchFailed ? Object.keys(available ?? {}) : [],
    unnecessaryReads,
    duplicateSuccessfulReads,
    cacheHits: cache?.hits ?? 0,
    businessReads: businessReads.map((r) => ({
      ...r,
      startedAt: r.startedAt - started,
      completedAt: r.completedAt - started,
    })),
    contextRuns,
    modelEvents: supportRun?.modelEvents ?? observer.modelEvents,
    modelToolCalls: supportRun?.toolCalls ?? [],
    nativeEntries,
  };
  await sandbox.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(fixturePath + suffix, { force: true });
  return result;
}
type CaseRun = Awaited<ReturnType<typeof executeCase>>;
const results: {
  caseId: string;
  category: string;
  repeat: number;
  order: ExperimentArm[];
  runs: Partial<Record<ExperimentArm, CaseRun>>;
}[] = [];
const warmups: CaseRun[] = [];
let failure: string | undefined;
let currentHost: Awaited<ReturnType<typeof host>> | undefined;
const shadowGates: { phase: string; customerId: string; status: string; contextAgeMs: number }[] =
  [];
try {
  console.log(
    JSON.stringify({
      stage: 'plan',
      split,
      measuredSupportRequests: schedule.length * experimentArms.length,
      warmupSupportRequests: 6,
      setupContextRequests: 5,
      revalidationContextRequests: 3,
      maxNestedContextFallbackRequests: split === 'development' ? 12 : 24,
      estimateBudgetUsd: 9,
      seed,
    }),
  );
  await timed('providerInitialization', async () => {
    await contextAgent.start();
    await supportAgent.start();
  });
  currentHost = await host(snapshot);
  const server = currentHost;
  const trainingClient = new FoundryClient({
    ...identity,
    context: () => activeContext,
    adapters: activeAdapters,
    native,
    provider,
    model,
    endpoint: server.endpoint,
    apiKey,
    trustedPublicKey: publicKey,
    shareReplayEvidence: true,
  });
  await timed('observation', async () => {
    for (const customerId of ['C-101', 'C-202']) {
      activeContext = baseContext();
      const run = await trainingClient.execute(request(customerId));
      guard(
        run.outcome === 'success' &&
          sameContext(
            run.result,
            joinedContext(
              customerId,
              Object.fromEntries(allReads.map((op) => [op, routingFixture(op, customerId)])),
            ),
          ),
        'Source observation failed.',
      );
    }
  });
  const candidate = await timed('analysisCompilation', async () => {
    const patterns = server.service.jit.analyze();
    guard(patterns.length === 1, 'Eligibility failed.');
    return server.service.jit.compilePattern(patterns[0].id);
  });
  candidateId = candidate.id;
  const verified = await timed('validation', () => server.service.jit.verify(candidateId));
  guard(
    verified.checks.every((check) => check.passed),
    'Artifact verification failed.',
  );
  await timed('trustedShadow', async () => {
    for (const customerId of ['C-101', 'C-202', 'C-303']) {
      activeContext = baseContext();
      const result = await server.service.jit.shadow(candidateId, { customerId });
      shadowGates.push({
        phase,
        customerId,
        status: result.shadow.status,
        contextAgeMs: Date.now() - activeContext.observedAt,
      });
      guard(result.shadow.status === 'match', `Trusted shadow failed: ${result.shadow.status}.`);
    }
  });
  server.service.jit.approve(candidateId, 'User-authorized isolated routing experiment.');
  server.service.jit.deploy(candidateId);
  server.service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
  setup = {
    wallMs: performance.now() - began,
    phases: { ...phases },
    apiEquivalentCostUsd: sumCost(ledger),
    checks: verified.checks,
    artifactId: candidateId,
    digest: candidate.digest,
  };
  const revalidationStart = performance.now();
  const ledgerAt = ledger.length;
  server.service.jit.quarantine(candidateId);
  guard(!server.service.jit.runtimeTicket().artifact, 'Quarantine still offered artifact.');
  const rechecked = await timed('revalidation', () => server.service.jit.verify(candidateId));
  guard(
    rechecked.checks.every((check) => check.passed),
    'Revalidation failed.',
  );
  await timed('renewedShadow', async () => {
    for (const customerId of ['C-101', 'C-202', 'C-303']) {
      activeContext = baseContext();
      const result = await server.service.jit.shadow(candidateId, { customerId });
      shadowGates.push({
        phase,
        customerId,
        status: result.shadow.status,
        contextAgeMs: Date.now() - activeContext.observedAt,
      });
      guard(result.shadow.status === 'match', `Renewed shadow failed: ${result.shadow.status}.`);
    }
  });
  // Local-demo compatibility retains an existing approval after successful verification.
  // Other tenants return to verified and require approval again. Never mutate that lifecycle.
  if (rechecked.status === 'verified')
    server.service.jit.approve(candidateId, 'Revalidation passed before sandbox snapshots.');
  guard(server.service.jit.shadowStatus(candidateId).ready, 'Renewed shadow coverage incomplete.');
  server.service.jit.deploy(candidateId);
  server.service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
  guard(
    server.service.jit.runtimeTicket().mode === 'live',
    'Revalidation did not restore eligibility.',
  );
  revalidation = {
    wallMs: performance.now() - revalidationStart,
    fixtureValidationMs: phases.revalidation,
    trustedShadowMs: phases.renewedShadow,
    apiEquivalentCostUsd: sumCost(ledger.slice(ledgerAt)),
    checks: rechecked.checks,
  };
  await server.close();
  currentHost = undefined;
  phase = 'warmup';
  for (const arm of experimentArms) {
    const run = await executeCase(developmentCases[0], arm);
    warmups.push(run);
    guard(run.assessment.passed, 'Warmup failed.');
  }
  for (const scheduled of schedule) {
    phase = 'measurement';
    const entry: (typeof results)[number] = {
      caseId: scheduled.task.id,
      category: scheduled.task.category,
      repeat: scheduled.repeat,
      order: scheduled.order,
      runs: {},
    };
    results.push(entry);
    for (const arm of scheduled.order) {
      const run = await executeCase(scheduled.task, arm);
      entry.runs[arm] = run;
      console.log(
        JSON.stringify({
          stage: 'request',
          split,
          caseId: entry.caseId,
          repeat: entry.repeat,
          arm,
          mode: run.selectedMode,
          correct: run.assessment.passed,
          outcome: run.measurement.outcome,
          tokens: run.measurement.totalTokens,
          models: run.measurement.modelCalls,
          reads: run.measurement.toolCalls,
          unnecessaryReads: run.unnecessaryReads,
          latencyMs: run.measurement.durationMs,
          cost: run.apiEquivalentCostUsd,
        }),
      );
      // A wrong normal-agent answer is retained as a losing observation, never used as an oracle.
      // Provider/accounting/security failures stop inference; expected service failures are cases.
      if (run.measurement.totalTokens === null)
        throw new Error('Provider usage incomplete; bounded run stopped.');
      if (scheduled.task.fault === 'denied')
        guard(
          run.measurement.outcome === 'denied' &&
            run.measurement.modelCalls === 0 &&
            run.businessReads.length === 0,
          'Authorization safety gate failed.',
        );
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : 'Experiment failed';
  process.exitCode = 1;
} finally {
  if (budgetStopped) {
    failure ??= budgetStopped;
    process.exitCode = 1;
  }
  await currentHost?.close();
  await supportAgent.close();
  await contextAgent.close();
  const complete = results.filter((row) => experimentArms.every((arm) => row.runs[arm]));
  const pair = (before: ExperimentArm, after: ExperimentArm) =>
    pairedRouting(
      complete.map((row) => ({
        caseId: row.caseId,
        baseline: row.runs[before]!,
        optimized: row.runs[after]!,
      })),
    );
  const report = {
    capturedAt: new Date().toISOString(),
    split,
    complete: !failure && complete.length === schedule.length,
    failure,
    plan: {
      measuredSupportRequests: schedule.length * experimentArms.length,
      warmupRequests: 6,
      setupContextRequests: 5,
      revalidationContextRequests: 3,
      repeats,
      seed,
      estimateBudgetUsd: 9,
    },
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      provider,
      model,
      authMode: 'ChatGPT',
      reasoningEffort: 'low support / none context',
      businessSnapshot: 'fixtures-v1 expanded synthetic records',
      providerInference: 'live',
      readDelayMs: 2,
      slowReadDelayMs: 120,
    },
    sourceHashes: sources,
    methodology: {
      cases,
      trainingIds: ['C-101', 'C-202'],
      shadowIds: ['C-101', 'C-202', 'C-303'],
      heldoutIds: ['C-404', 'C-505', 'C-606'],
      registryIsolation:
        'Each request forks the same actually validated, approved and shadowed SQLite snapshot; real quarantine is applied to its own fork.',
      freshnessContractMs: 30000,
      partialAndNoContext:
        'Compiled prefetch is inapplicable; fixed compiled arms use original tools. Handwritten prefetch can load known partial reads.',
      latency:
        'Includes selector, SDK network, guards, reads, model work, provider thread archive and telemetry. Excludes per-request test database/server fixture initialization and teardown, which are in total experiment time.',
      replyChecks:
        'Independent structured evidence/action labels, permitted/required reads, delay/order grounding and prohibited financial-action claims; no private reasoning or LLM judge.',
      uncertainty:
        'Descriptive paired case-block bootstrap, retaining repeats together. Ten synthetic case blocks are not a production workload sample; no production p95 claim.',
    },
    pricing: {
      ...rateCard,
      verifiedAt: '2026-10-05',
      kind: 'API-equivalent estimate; actual ChatGPT billing unknown',
      actualBilledCostUsd: null,
      hostingConnectorEngineeringCostUsd: null,
    },
    setup,
    revalidation,
    shadowGates,
    steadyState: Object.fromEntries(
      experimentArms.map((arm) => [arm, summarizeRouting(complete.map((row) => row.runs[arm]!))]),
    ),
    byCategory: Object.fromEntries(
      cases.map((task) => [
        task.category,
        Object.fromEntries(
          experimentArms.map((arm) => [
            arm,
            summarizeRouting(
              complete.filter((row) => row.category === task.category).map((row) => row.runs[arm]!),
            ),
          ]),
        ),
      ]),
    ),
    paired: {
      selectorVsCompiledTool: pair('compiled_tool', 'selector_native_fallback'),
      directVsNativeFallback: pair('selector_native_fallback', 'selector_direct_fallback'),
      directVsNormal: pair('normal', 'selector_direct_fallback'),
      directVsHandwritten: pair('handwritten_prefetch', 'selector_direct_fallback'),
    },
    providerAccounting: {
      completedInferenceResponses: ledger.reduce((sum, run) => sum + run.responses, 0),
      reroutes: supportAgent.reroutes + contextAgent.reroutes,
      warnings: supportAgent.warnings + contextAgent.warnings,
      transportRetries: null,
    },
    experimentTotals: {
      elapsedMs: performance.now() - began,
      cpuMicros: process.cpuUsage(cpuStart),
      apiEquivalentCostUsd: sumCost(ledger),
      preflights,
      includingPreflightApiEquivalentCostUsd:
        sumCost(ledger) === null || preflightCost === null
          ? null
          : sumCost(ledger)! + preflightCost,
      nativeRequests: ledger.length,
      ledger,
      note: 'All setup, revalidation, warmups, failed reads, incorrect outputs, outliers and measured requests retained. Unknown charges are not zero.',
    },
    warmups,
    trials: results,
  };
  writeFileSync(output, await format(JSON.stringify(report), { parser: 'json', printWidth: 100 }));
  rmSync(directory, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      complete: report.complete,
      split,
      failure,
      steadyState: report.steadyState,
      output,
    }),
  );
}
