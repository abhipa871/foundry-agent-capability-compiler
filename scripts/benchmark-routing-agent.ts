import { spawnSync } from 'node:child_process';
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
import { codexLaunch } from '../src/agent/codex.js';
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
  buildCallLedger,
  runPartialSoftware,
  sandboxCustomerIds,
  softwareToolFor,
  type LedgerToolCall,
  type RoutingCase,
  type ExperimentArm,
  type RoutingResponse,
} from './experiments/routing-task.js';
import { sumMeasurements } from './experiments/statistics.js';
import { summarizeRouting, pairedRouting } from './experiments/routing-statistics.js';

const split = process.argv[2];
if (split !== 'development' && split !== 'heldout')
  throw new Error('Choose development or heldout.');
if (process.argv.length > 3) throw new Error('The only supported argument is the split.');
// Plan v2 (12 cases) writes new evidence; v1 files stay untouched and are listed as prior work.
const planVersion = 'routing-v2-12-case';
const output = `docs/routing-agent-v2-${split}.json`;
const priorPaths = [
  'docs/routing-agent-development-preflight.json',
  'docs/routing-agent-development-revalidation-preflight.json',
  'docs/routing-agent-development-interrupted.json',
  'docs/routing-agent-development-provider-preflight.json',
  'docs/routing-agent-development.json',
  ...(split === 'heldout' ? ['docs/routing-agent-v2-development.json'] : []),
];
const priorEvidence = priorPaths
  .filter((path) => existsSync(path))
  .map((path) => {
    const evidence = JSON.parse(readFileSync(path, 'utf8')) as {
      plan?: { measuredSupportRequests?: number };
      complete?: boolean;
      experimentTotals: {
        apiEquivalentCostUsd: number | null;
        nativeRequests: number;
        ledger: { apiEquivalentCostUsd: number | null }[];
      };
      providerAccounting: { completedInferenceResponses: number };
      trials: { runs: Record<string, unknown> }[];
    };
    return {
      path,
      complete: evidence.complete ?? false,
      plannedMeasuredRequests: evidence.plan?.measuredSupportRequests ?? null,
      apiEquivalentCostUsd: evidence.experimentTotals.apiEquivalentCostUsd,
      knownCostSubtotalUsd: evidence.experimentTotals.ledger.reduce(
        (sum, entry) => sum + (entry.apiEquivalentCostUsd ?? 0),
        0,
      ),
      unknownCostRequests: evidence.experimentTotals.ledger.filter(
        (entry) => entry.apiEquivalentCostUsd === null,
      ).length,
      nativeRequests: evidence.experimentTotals.nativeRequests,
      completedInferenceResponses: evidence.providerAccounting.completedInferenceResponses,
      measuredTaskRequests: evidence.trials.reduce(
        (sum, trial) => sum + Object.keys(trial.runs).length,
        0,
      ),
      note: 'Prior attempt retained for accounting only; never pooled with this run. Unknown request costs are not zero.',
    };
  });
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
    'src/exploration/observe.ts',
    'src/runtime/adapters/registry.ts',
    'src/runtime/dispatcher.ts',
    'src/runtime/interpret.ts',
    'src/compiler/compile-ir.ts',
    'scripts/experiments/customer-agent.ts',
    'scripts/experiments/support-task.ts',
    'scripts/experiments/routing-task.ts',
    'scripts/experiments/routing-statistics.ts',
    'scripts/benchmark-routing-agent.ts',
  ].map((path) => [path, sha(readFileSync(path))]),
);
const identity = {
  ...localIdentity,
  customerIds: [...sandboxCustomerIds],
};
const codexLaunchCommand = codexLaunch();
const codexVersion = (() => {
  const run = spawnSync(
    codexLaunchCommand.command,
    [...codexLaunchCommand.argsPrefix, '--version'],
    {
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  return run.status === 0 ? (run.stdout.trim().split('\n').pop() ?? null) : null;
})();
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
  recoverReadFailures: true,
  allowUnavailableContext: true,
});
const supportAgent = new CustomerContextAgent({
  adapters: (...args) => activeAdapters(...args),
  context: () => activeContext,
  agentId: identity.agentId,
  onRun: observeRun('support'),
  maxModelCalls: 6,
  maxToolCalls: 10,
  timeoutMs: 60000,
  recoverReadFailures: true,
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
  if (!run.resolved) return run;
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
  const spent = sumCost(ledger);
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
  const observerStartedAt = performance.now();
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
  const softwareTool = softwareToolFor(task);
  const agentToolCalls: LedgerToolCall[] = [];
  const loadPartial = async () => {
    if (loaderAttempted)
      return {
        unavailable: true,
        message: 'Software was already attempted. Use valid available data or original tools.',
      };
    loaderAttempted = true;
    return runPartialSoftware(observer, activeContext);
  };
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
    } else if (!denied && selectedMode === 'compiled_prefetch') {
      if (task.software !== 'foundry_context_loader')
        throw new Error('Fixture software is never prefetched as a Foundry capability.');
      await load();
    }
    if (!denied) {
      const agentTools =
        selectedMode === 'compiled_tool'
          ? task.contract.requirement === 'agent_decides' || arm === 'selector_direct_fallback'
            ? [...originalTools, softwareTool]
            : [softwareTool]
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
          const call: LedgerToolCall = {
            name,
            startedAt: performance.now(),
            completedAt: 0,
            status: 'success',
          };
          agentToolCalls.push(call);
          try {
            z.object({}).strict().parse(args);
            if (denied) throw new DomainError('Access denied.', 403);
            if (!agentTools.some((tool) => tool.name === name))
              throw new DomainError('Tool not offered for this request.', 403);
            if (name === softwareTool.name) {
              const result: Record<string, unknown> = await (task.software ===
              'fixture_partial_order_summary'
                ? loadPartial()
                : load());
              if ('unavailable' in result || 'denied' in result) call.status = 'failed';
              return result;
            }
            return await executeTool(capture, name, args);
          } catch (error) {
            call.status = 'failed';
            throw error;
          } finally {
            call.completedAt = performance.now();
          }
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
  const callLedger = buildCallLedger({
    task,
    toolCalls: agentToolCalls.map((call) => ({
      ...call,
      startedAt: call.startedAt - started,
      completedAt: (call.completedAt || performance.now()) - started,
    })),
    reads: businessReads.map((read) => ({
      ...read,
      startedAt: read.startedAt - started,
      completedAt: read.completedAt - started,
    })),
    modelEvents: observer.modelEvents.map((event) => ({
      ...event,
      startMs: event.startMs + observerStartedAt - started,
      endMs: event.endMs + observerStartedAt - started,
    })),
    cost: apiEquivalentCost,
  });
  const result = {
    arm,
    softwareSource: task.software,
    softwareEvidence:
      task.software === 'fixture_partial_order_summary'
        ? 'Labeled test fixture software with live agent inference; not Foundry capability evidence.'
        : 'Foundry compiled capability where invoked.',
    selectedMode,
    selectionReason,
    loaderAttempted,
    callLedger,
    redundantToolCalls: callLedger.redundantToolCalls,
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
const measuredSupportRequests = schedule.length * experimentArms.length;
const deniedMeasuredRequests =
  schedule.filter((row) => row.task.fault === 'denied').length * experimentArms.length;
const livePlan = {
  planVersion,
  split,
  output,
  cases: cases.length,
  arms: experimentArms.length,
  repeats,
  measuredSupportRequests,
  deniedMeasuredRequestsWithoutInference: deniedMeasuredRequests,
  observationContextRequests: 2,
  initialShadowContextRequests: 3,
  revalidationShadowContextRequests: 3,
  warmupSupportRequests: experimentArms.length,
  maxNestedContextFallbackRequests: maxNestedContextRequests,
  maxProviderAgentRequests:
    2 +
    3 +
    3 +
    experimentArms.length +
    measuredSupportRequests -
    deniedMeasuredRequests +
    maxNestedContextRequests,
  maxCompletedResponsesPerAgentRequest: 6,
  estimateStopUsd: 9,
  seed,
};
try {
  console.log(JSON.stringify({ stage: 'plan', ...livePlan, codexVersion }));
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
          duplicateReads: run.duplicateSuccessfulReads,
          softwareCalls: run.callLedger.softwareCalls,
          followUpCalls: run.callLedger.followUpCalls,
          redundantToolCalls: run.callLedger.redundantToolCalls,
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
  const fixtureCategories = new Set(
    cases.filter((task) => task.software !== 'foundry_context_loader').map((t) => t.category),
  );
  const liveSoftware = complete.filter((row) => !fixtureCategories.has(row.category));
  const pair = (before: ExperimentArm, after: ExperimentArm, rows = liveSoftware) =>
    pairedRouting(
      rows.map((row) => ({
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
    plan: { ...livePlan, measuredSupportRequests: schedule.length * experimentArms.length },
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      provider,
      model,
      codexVersion,
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
      developmentIds: [...new Set(developmentCases.map((task) => task.customerId))],
      heldoutIds: [...new Set(heldoutCases.map((task) => task.customerId))],
      fixtureSoftwareCategories: [...fixtureCategories],
      fixtureSoftware:
        'software_supplement offers a labeled fixture order-summary tool (eligibility and orders only) because the compiled context.v1 contract cannot return a valid partial result. Its rows use live agent inference but are excluded from Foundry-capability aggregates and paired comparisons.',
      callLedger:
        'Each agent tool call is recorded separately with its business reads, duplicate/redundant/unnecessary flags and latency. Each completed model response is recorded with tokens, API-equivalent cost and the tool calls it issued.',
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
        'Descriptive paired case-block bootstrap, retaining repeats together. Eleven or twelve synthetic case blocks are not a production workload sample; no production p95 claim.',
    },
    pricing: {
      ...rateCard,
      verifiedAt: '2026-10-07',
      kind: 'API-equivalent estimate; actual ChatGPT billing unknown',
      actualBilledCostUsd: null,
      hostingConnectorEngineeringCostUsd: null,
    },
    setup,
    revalidation,
    shadowGates,
    steadyState: Object.fromEntries(
      experimentArms.map((arm) => [
        arm,
        summarizeRouting(liveSoftware.map((row) => row.runs[arm]!)),
      ]),
    ),
    steadyStateIncludingFixtureSoftwareCase: Object.fromEntries(
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
      compiledToolVsNormal: pair('normal', 'compiled_tool'),
      compiledPrefetchVsNormal: pair('normal', 'compiled_prefetch'),
      handwrittenVsNormal: pair('normal', 'handwritten_prefetch'),
      compiledPrefetchVsHandwritten: pair('handwritten_prefetch', 'compiled_prefetch'),
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
      knownCostSubtotalUsd: ledger.reduce((sum, row) => sum + (row.apiEquivalentCostUsd ?? 0), 0),
      unknownCostRequests: ledger.filter((row) => row.apiEquivalentCostUsd === null).length,
      priorEvidence,
      includingPriorAttemptsApiEquivalentCostUsd:
        sumCost(ledger) === null || priorEvidence.some((run) => run.apiEquivalentCostUsd === null)
          ? null
          : sumCost(ledger)! +
            priorEvidence.reduce((sum, run) => sum + run.apiEquivalentCostUsd!, 0),
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
