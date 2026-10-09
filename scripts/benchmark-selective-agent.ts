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
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { format } from 'prettier';
import { createApp } from '../src/app.js';
import { Store } from '../src/registry/store.js';
import {
  FoundryClient,
  RequestReadCache,
  selectExecution,
  subsetContextProjection,
  type ExecutionSelection,
} from '../src/integration/client.js';
import { TrajectoryObserver } from '../src/exploration/observe.js';
import {
  authorizeReads,
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
import type { ReadOperation } from '../src/compiler/ir.js';
import { resourceKeys } from '../src/runtime/selective.js';
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
import { compiledContextTool } from './experiments/support-task.js';
import { routingFixture } from './experiments/routing-task.js';
import {
  developmentCases,
  heldoutCases,
  allReads,
  sandboxCustomerIds,
  selectiveResponseSchema,
  selectiveInstructions,
  selectivePrompt,
  assessSelective,
  selectiveArms,
  selectiveSchedule,
  failedReadStatus,
  readAttemptsPerRequest,
  fixturePolicy,
  selectivePlanVersion,
  placement,
  offeredTools,
  type PlacementMode,
  type SelectiveCase,
  type SelectiveArm,
  type SelectiveResponse,
} from './experiments/selective-task.js';
import { sumMeasurements } from './experiments/statistics.js';
import { summarizeRouting, pairedRouting } from './experiments/routing-statistics.js';

// Usage: benchmark-selective-agent.ts <development|heldout> --provider fixture
//        benchmark-selective-agent.ts <development|heldout> --provider live --cap-usd <amount>
// Fixture mode uses a labeled no-inference provider to validate the harness; its tokens and
// costs are synthetic. Live mode runs paid inference and must be explicitly authorized.
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: { provider: { type: 'string' }, 'cap-usd': { type: 'string' } },
});
const split = positionals[0];
if (positionals.length !== 1 || (split !== 'development' && split !== 'heldout'))
  throw new Error('Choose exactly one split: development or heldout.');
const providerMode = flags.provider;
if (providerMode !== 'fixture' && providerMode !== 'live')
  throw new Error('Choose --provider fixture or --provider live.');
const fixtureProvider = resolve('scripts/experiments/fixture-provider.mjs');
let capUsd: number | null = null;
if (providerMode === 'live') {
  capUsd = Number(flags['cap-usd']);
  if (!Number.isFinite(capUsd) || capUsd <= 0)
    throw new Error('Live inference requires an explicit positive --cap-usd spending cap.');
  if (process.env.FOUNDRY_CODEX_BIN && resolve(process.env.FOUNDRY_CODEX_BIN) === fixtureProvider)
    throw new Error('Live mode refuses the fixture provider.');
} else if (flags['cap-usd'] !== undefined)
  throw new Error('Fixture mode runs no inference; --cap-usd does not apply.');
const planVersion = selectivePlanVersion;
// v1 evidence (including the stopped live development attempt) is retained under its own names.
const output = `docs/selective-agent-v1.1-${providerMode === 'fixture' ? 'fixture-' : ''}${split}.json`;
if (existsSync(output)) throw new Error(`Refusing to overwrite retained evidence: ${output}.`);
if (providerMode === 'live' && split === 'heldout') {
  const development = 'docs/selective-agent-v1.1-development.json';
  if (!existsSync(development) || !JSON.parse(readFileSync(development, 'utf8')).complete)
    throw new Error('Held-out live run requires a complete live v1.1 development run first.');
}
const priorEvidence = (providerMode === 'live' ? ['docs/selective-agent-development.json'] : [])
  .filter((path) => existsSync(path))
  .map((path) => {
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    return {
      path,
      planVersion: evidence.plan?.planVersion ?? null,
      complete: evidence.complete,
      failure: evidence.failure ?? null,
      apiEquivalentCostUsd: evidence.experimentTotals.apiEquivalentCostUsd,
      providerAgentRequests: evidence.experimentTotals.providerAgentRequests,
      completedInferenceResponses: evidence.providerAccounting.completedInferenceResponses,
      note: 'Prior attempt retained for accounting only; never pooled with this run.',
    };
  });
const directory = mkdtempSync(join(tmpdir(), 'foundry-selective-evaluation-'));
const policyPath = join(directory, 'fixture-policy.json');
if (providerMode === 'fixture') {
  process.env.FOUNDRY_CODEX_BIN = fixtureProvider;
  process.env.FOUNDRY_FIXTURE_POLICY = policyPath;
}
const cases = split === 'development' ? developmentCases : heldoutCases;
const repeats = split === 'development' ? 1 : 2;
const seed = split === 'development' ? 51203 : 81307;
const schedule = selectiveSchedule(cases, repeats, seed);
const began = performance.now();
const cpuStart = process.cpuUsage();
const snapshot = join(directory, 'observed.sqlite');
const dependencySnapshot = join(directory, 'dependency.sqlite');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(
  [
    'src/integration/selection.ts',
    'src/integration/client.ts',
    'src/integration/request-reads.ts',
    'src/integration/protocol.ts',
    'src/exploration/observe.ts',
    'src/runtime/adapters/registry.ts',
    'src/runtime/dispatcher.ts',
    'src/runtime/interpret.ts',
    'src/runtime/selective.ts',
    'src/verification/verify-ir.ts',
    'src/compiler/compile-ir.ts',
    'scripts/experiments/customer-agent.ts',
    'scripts/experiments/support-task.ts',
    'scripts/experiments/routing-task.ts',
    'scripts/experiments/selective-task.ts',
    'scripts/experiments/fixture-provider.mjs',
    'scripts/benchmark-selective-agent.ts',
  ].map((path) => [path, sha(readFileSync(path))]),
);
const identity = { ...localIdentity, customerIds: [...sandboxCustomerIds] };
const launch = codexLaunch();
const providerVersion = (() => {
  const run = spawnSync(launch.command, [...launch.argsPrefix, '--version'], {
    encoding: 'utf8',
    timeout: 10000,
  });
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
const agentOptions = {
  adapters: ((...args) => activeAdapters(...args)) as AdapterRunner,
  context: () => activeContext,
  agentId: identity.agentId,
  maxModelCalls: 6,
  maxToolCalls: 10,
  timeoutMs: 60000,
  recoverReadFailures: true,
};
const contextAgent = new CustomerContextAgent({
  ...agentOptions,
  onRun: observeRun('context'),
  allowUnavailableContext: true,
});
const supportAgent = new CustomerContextAgent({ ...agentOptions, onRun: observeRun('support') });
// Native context retrieval serves only observation and trusted shadows. Measured arms use direct
// fallback, so a nested native request during measurement is a harness fault.
const native: ConstructorParameters<typeof FoundryClient>[0]['native'] = async (
  task,
  checkpoint,
  supplied,
) => {
  if (['measurement', 'warmup'].includes(phase)) {
    budgetStopped = 'Unexpected nested native context request during measurement.';
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
  if (
    !allReads.every((operation) => values[operation] !== undefined) ||
    !sameContext(run.result, joined(input.customerId, values, allReads))
  ) {
    const measured = { ...run.measurement!, outcome: 'failed' as const };
    ledger[ledger.length - 1].status = 'evidence_failed';
    ledger[ledger.length - 1].measurement = measured;
    throw new AgentExecutionError(measured);
  }
  return run;
};
function joined(
  customerId: string,
  values: Partial<Record<ReadOperation, unknown>>,
  reads: readonly ReadOperation[],
) {
  return Object.fromEntries([
    ['customer_id', customerId],
    ...reads.map((operation) => [resourceKeys[operation], values[operation]]),
  ]);
}
const independent = (customerId: string, reads: readonly ReadOperation[]) =>
  joined(
    customerId,
    Object.fromEntries(reads.map((op) => [op, routingFixture(op, customerId)])),
    reads,
  );
const keys = generateKeyPairSync('ed25519');
const signer = new ArtifactSigner(
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const apiKey = 'selective_sandbox_credential_00000000000000';
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
  await new Promise<void>((done) => server.once('listening', done));
  return {
    store,
    service,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
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
  if (capUsd === null) return;
  const spent = sumCost(ledger);
  if (spent === null || spent >= capUsd)
    throw new Error(`Live estimate unknown or $${capUsd} inference-equivalent cap reached.`);
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
const artifacts = { observed: '', dependency: '' };
const setup: Record<string, unknown> = {};
const shadowGates: { phase: string; customerId: string; status: string }[] = [];
async function approveWithShadows(
  server: Awaited<ReturnType<typeof host>>,
  id: string,
  label: string,
) {
  const verified = await timed(`${label}Validation`, () => server.service.jit.verify(id));
  guard(
    verified.checks.every((check) => check.passed),
    `${label} artifact verification failed.`,
  );
  await timed(`${label}TrustedShadow`, async () => {
    for (const customerId of ['C-101', 'C-202', 'C-303']) {
      activeContext = baseContext();
      const result = await server.service.jit.shadow(id, { customerId });
      shadowGates.push({ phase, customerId, status: result.shadow.status });
      guard(result.shadow.status === 'match', `${label} trusted shadow: ${result.shadow.status}.`);
    }
  });
  if (server.service.jit.get(id)?.status !== 'approved')
    server.service.jit.approve(id, 'User-authorized isolated selective-context experiment.');
  server.service.jit.deploy(id);
  server.service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
  guard(server.service.jit.runtimeTicket().mode === 'live', `${label} artifact not live.`);
  return verified.checks;
}
type BusinessRead = {
  operation: ReadOperation;
  startedAt: number;
  completedAt: number;
  status: 'success' | 'failed';
};
type ToolCall = { name: string; startedAt: number; completedAt: number; status: string };

async function executeCase(task: SelectiveCase, arm: SelectiveArm) {
  budget();
  const fixturePath = join(directory, `request-${Date.now()}-${arm}.sqlite`);
  copyFileSync(task.artifact === 'dependency' ? dependencySnapshot : snapshot, fixturePath);
  const sandbox = await host(fixturePath);
  if (task.fault.kind === 'quarantined') sandbox.service.jit.quarantine(artifacts[task.artifact]);
  activeContext = {
    ...baseContext(),
    ...(task.fault.kind === 'stale' ? { observedAt: Date.now() - 60000 } : {}),
    ...(task.fault.kind === 'denied' ? { allowedCustomerIds: [] } : {}),
  };
  const businessReads: BusinessRead[] = [];
  const attempts = new Map<ReadOperation, number>();
  const fault = task.fault;
  const rawAdapters: AdapterRunner = async (operation, args, context, signal) => {
    authorizeReads(context, args, [operation]);
    const attempt = (attempts.get(operation) ?? 0) + 1;
    attempts.set(operation, attempt);
    if (attempt > readAttemptsPerRequest)
      throw new DomainError('Sandbox read retry budget exhausted.', 503);
    const entry: BusinessRead = {
      operation,
      startedAt: performance.now(),
      completedAt: 0,
      status: 'success',
    };
    businessReads.push(entry);
    try {
      await delay(2, undefined, { signal });
      if (
        'operation' in fault &&
        fault.operation === operation &&
        (fault.kind === 'permanent' || attempt === 1)
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
  const direct = arm === 'existing_selector_direct' || arm === 'selective_direct';
  const cache = direct
    ? new RequestReadCache({
        adapters: rawAdapters,
        input: { customerId: task.customerId },
        freshnessMs: 30000,
      })
    : undefined;
  activeAdapters = cache?.adapters ?? rawAdapters;
  let controlApiCalls = 0;
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
    fetch: (url, init) => {
      controlApiCalls++;
      return fetch(url, init);
    },
  });
  const contextRuns: DispatchOutcome[] = [];
  const started = performance.now();
  const ledgerStart = ledger.length;
  const contractReads = [...task.contract.reads];
  let response: SelectiveResponse | undefined;
  let assessment = { passed: false, checks: {} as Record<string, boolean> };
  let supportRun: Awaited<ReturnType<typeof supportAgent.runTask<SelectiveResponse>>> | undefined;
  let failure: string | undefined;
  let denied = false;
  let prefetchFailed = false;
  let loaderAttempted = false;
  let available: Partial<Record<ReadOperation, unknown>> | undefined;
  let selectorMs = 0;
  let selection: ExecutionSelection | undefined;
  let mode: PlacementMode = 'normal';
  let reason = 'manual_original_tools';
  try {
    authorizeReads(activeContext, { customerId: task.customerId }, contractReads);
  } catch {
    denied = true;
    mode = 'denied';
    reason = 'task_authorization_denied';
  }
  if (!denied) {
    if (arm === 'existing_selector_direct' || arm === 'selective_direct') {
      selection = selectExecution(
        arm === 'selective_direct' ? task.contract : task.existingContract,
        { customerId: task.customerId },
        activeContext,
      );
      selectorMs = selection.durationMs;
    }
    ({ mode, reason } = placement(task, arm, selection));
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
    allowedOperations: contractReads,
  });
  const originalTools = tools.filter((tool) => contractReads.includes(operations[tool.name]));
  const softwareTool = compiledContextTool[0];
  const agentToolCalls: ToolCall[] = [];
  const pick = (values: Partial<Record<ReadOperation, unknown>> | undefined) =>
    Object.fromEntries(
      contractReads.filter((op) => values?.[op] !== undefined).map((op) => [op, values![op]]),
    );
  // Existing arm: the shipped SDK call. Selective arm: the same call plus the selected subset.
  const load = async (resources?: ReadOperation[]) => {
    if (loaderAttempted)
      return {
        unavailable: true,
        message:
          'Context loader was already attempted. Use valid available data or original tools.',
      };
    loaderAttempted = true;
    const run = await client.execute(request(task.customerId), {
      fallback: 'defer',
      ...(resources ? { resources, selection } : {}),
    });
    contextRuns.push(run);
    if (run.outcome === 'denied') {
      denied = true;
      return { denied: true };
    }
    if (run.outcome !== 'success' || !run.result) {
      prefetchFailed = true;
      available = pick(cache?.available(activeContext));
      return {
        unavailable: true,
        availableReads: available,
        serviceStatus: failedReadStatus(businessReads),
      };
    }
    if (run.selection) {
      const subset = subsetContextProjection(run.result, run.selection.resources);
      guard(
        JSON.stringify(subset) ===
          JSON.stringify(
            subsetContextProjection(
              independent(task.customerId, run.selection.resources),
              run.selection.resources,
            ),
          ),
        'Subset differed from independent record snapshot.',
      );
      available = Object.fromEntries(
        run.selection.resources.map((op) => [op, subset[resourceKeys[op]]]),
      );
      return subset;
    }
    const parsed = contextProjection(run.result);
    guard(
      sameContext(parsed, independent(task.customerId, allReads)),
      'Context differed from independent record snapshot.',
    );
    available = {
      'crm.getCustomer': parsed.crm_get_customer,
      'orders.list': parsed.orders_list,
      'payments.refundHistory': parsed.payments_refund_history,
    };
    return parsed;
  };
  try {
    if (!denied && mode === 'handwritten_prefetch') {
      const values: Partial<Record<ReadOperation, unknown>> = {};
      const settled = await Promise.allSettled(
        contractReads.map(async (operation) => {
          for (let attempt = 0; attempt < readAttemptsPerRequest; attempt++) {
            try {
              values[operation] = (
                await observer.read(operation, { source: 'task_input', key: 'customerId' })
              ).value;
              return;
            } catch (error) {
              if (error instanceof DomainError && error.status === 403) throw error;
              if (attempt === readAttemptsPerRequest - 1) throw error;
            }
          }
        }),
      );
      prefetchFailed = settled.some((item) => item.status === 'rejected');
      available = pick(values);
    } else if (!denied && mode === 'compiled_prefetch')
      await load(arm === 'selective_direct' ? selection!.resources : undefined);
    if (!denied) {
      const offered = offeredTools(task, mode, prefetchFailed);
      const agentTools = [...originalTools, softwareTool].filter((tool) =>
        offered.includes(tool.name),
      );
      if (providerMode === 'fixture')
        writeFileSync(policyPath, JSON.stringify(fixturePolicy(task)));
      supportRun = await supportAgent.runTask({
        input: { customerId: task.customerId },
        observer,
        allowedOperations: contractReads,
        tools: agentTools,
        executeTool: async (capture, name, args) => {
          const call: ToolCall = {
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
              const result: Record<string, unknown> = await load();
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
        prompt: selectivePrompt(
          task,
          available,
          prefetchFailed,
          businessReads.some((read) => read.status === 'failed')
            ? failedReadStatus(businessReads)
            : undefined,
        ),
        instructions: selectiveInstructions,
        outputSchema: z.toJSONSchema(selectiveResponseSchema),
        parseResult: (raw) => selectiveResponseSchema.parse(raw),
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
      assessment = assessSelective(response, task, businessReads);
    } else
      assessment = {
        passed:
          task.fault.kind === 'denied' &&
          businessReads.length === 0 &&
          ledger.length === ledgerStart,
        checks: {
          deniedBeforeInferenceAndReads:
            businessReads.length === 0 && ledger.length === ledgerStart,
        },
      };
  } catch (error) {
    failure =
      supportAgent.lastFailure ?? (error instanceof Error ? error.message : 'Request failed');
  }
  let measurement: Measurement;
  if (denied) measurement = { ...emptyMeasurement(), outcome: 'denied' };
  else if (supportRun)
    measurement = sumMeasurements(
      [supportRun.measurement, ...contextRuns.map((r) => r.measurement)],
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
  const allowed = [...task.permittedReads, ...task.approvedPrerequisites];
  const unnecessaryReads = businessReads.filter((r) => !allowed.includes(r.operation)).length;
  const prerequisiteReads = businessReads.filter(
    (r) =>
      task.approvedPrerequisites.includes(r.operation) &&
      !task.permittedReads.includes(r.operation),
  ).length;
  const duplicateSuccessfulReads = businessReads.filter((r, index) =>
    businessReads
      .slice(0, index)
      .some((prior) => prior.operation === r.operation && prior.status === 'success'),
  ).length;
  const authorizationViolations =
    businessReads.filter((r) => r.status === 'success' && !allowed.includes(r.operation)).length +
    (task.fault.kind === 'denied' && (businessReads.length > 0 || ledger.length > ledgerStart)
      ? 1
      : 0);
  const at = (time: number) => Math.round(time - started);
  const result = {
    arm,
    artifact: task.artifact,
    selectedMode: mode,
    selectionReason: reason,
    requestedResources: selection?.resources ?? [],
    selectorMs,
    measurement,
    apiEquivalentCostUsd: costOf(measurement),
    assessment,
    response,
    failure,
    usedFallback: prefetchFailed || contextRuns.some((run) => run.mode !== 'compiled'),
    fallbackReasons: contextRuns.flatMap((run) => (run.fallbackReason ? [run.fallbackReason] : [])),
    prefetchFailed,
    loaderAttempted,
    suppliedReadOperations: Object.keys(available ?? {}),
    unnecessaryReads,
    prerequisiteReads,
    duplicateSuccessfulReads,
    authorizationViolations,
    redundantToolCalls: agentToolCalls.filter((call) => {
      const ops = call.name === softwareTool.name ? allReads : [operations[call.name]];
      return ops.every((op) =>
        businessReads.some(
          (read) =>
            read.operation === op &&
            read.status === 'success' &&
            read.completedAt <= call.startedAt,
        ),
      );
    }).length,
    cacheHits: cache?.hits ?? 0,
    toolCalls: agentToolCalls.map((call) => ({
      name: call.name,
      status: call.status,
      latencyMs: (call.completedAt || performance.now()) - call.startedAt,
      businessReads: businessReads
        .filter((read) => read.startedAt >= call.startedAt && read.startedAt <= call.completedAt)
        .map((read) => ({ operation: read.operation, status: read.status })),
    })),
    responses: observer.modelEvents.map((event) => ({
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      latencyMs: event.endMs - event.startMs,
      endMs: Math.round(event.endMs + observerStartedAt - started),
      apiEquivalentCostUsd:
        event.inputTokens === null ||
        event.outputTokens === null ||
        event.cachedInputTokens === null
          ? null
          : apiEquivalentCost(event.inputTokens, event.cachedInputTokens, event.outputTokens),
    })),
    businessReads: businessReads.map((r) => ({
      ...r,
      startedAt: at(r.startedAt),
      completedAt: at(r.completedAt),
    })),
    contextRuns: contextRuns.map((run) => ({
      mode: run.mode,
      outcome: run.outcome,
      fallbackReason: run.fallbackReason,
      selection: run.selection,
      executedNodeIds: run.executedNodeIds,
      adapterCalls: run.adapterCalls,
      peakParallel: run.peakParallel,
      guards: run.guards.filter((entry) => !entry.ok),
      durationMs: run.durationMs,
    })),
  };
  await sandbox.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(fixturePath + suffix, { force: true });
  return result;
}
type CaseRun = Awaited<ReturnType<typeof executeCase>>;
const results: {
  caseId: string;
  category: string;
  group: string;
  repeat: number;
  order: SelectiveArm[];
  runs: Partial<Record<SelectiveArm, CaseRun>>;
}[] = [];
const warmups: CaseRun[] = [];
let failure: string | undefined;
let currentHost: Awaited<ReturnType<typeof host>> | undefined;
const deniedRequests =
  schedule.filter((row) => row.task.fault.kind === 'denied').length * selectiveArms.length;
const plan = {
  planVersion,
  split,
  providerMode,
  output,
  cases: cases.length,
  arms: selectiveArms,
  repeats,
  measuredSupportRequests: schedule.length * selectiveArms.length,
  deniedMeasuredRequestsWithoutInference: deniedRequests,
  observationContextRequests: 2,
  shadowContextRequests: 9,
  warmupSupportRequests: selectiveArms.length,
  maxProviderAgentRequests:
    2 + 9 + selectiveArms.length + schedule.length * selectiveArms.length - deniedRequests,
  maxCompletedResponsesPerAgentRequest: 6,
  spendingCapUsd: capUsd,
  seed,
};
try {
  console.log(JSON.stringify({ stage: 'plan', ...plan, providerVersion }));
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
        run.outcome === 'success' && sameContext(run.result, independent(customerId, allReads)),
        'Source observation failed.',
      );
    }
  });
  const candidate = await timed('analysisCompilation', async () => {
    const patterns = server.service.jit.analyze();
    guard(patterns.length === 1, 'Eligibility failed.');
    return server.service.jit.compilePattern(patterns[0].id);
  });
  artifacts.observed = candidate.id;
  const checks = await approveWithShadows(server, candidate.id, 'observed');
  const setupCost = sumCost(ledger);
  const ledgerAt = ledger.length;
  server.service.jit.quarantine(candidate.id);
  guard(!server.service.jit.runtimeTicket().artifact, 'Quarantine still offered artifact.');
  const revalidationChecks = await approveWithShadows(server, candidate.id, 'revalidation');
  setup.observed = {
    artifactId: candidate.id,
    digest: candidate.digest,
    readBindings: candidate.ir.nodes.map((node) => ({ id: node.id, deps: node.deps })),
    concurrency: candidate.ir.concurrency,
    apiEquivalentCostUsd: setupCost,
    checks,
  };
  setup.revalidation = {
    apiEquivalentCostUsd: sumCost(ledger.slice(ledgerAt)),
    checks: revalidationChecks,
  };
  await server.close();
  currentHost = await host(dependencySnapshot);
  const dependencyServer = currentHost;
  const dependencyLedgerAt = ledger.length;
  dependencyServer.service.jit.seed();
  const dependency = await timed('dependencyCompilation', async () =>
    dependencyServer.service.jit.compile(),
  );
  guard(
    dependency.ir.nodes.some((node) => node.deps.length > 0 && node.opcode === 'adapter.read'),
    'Demo-trace artifact lacks the expected read dependency.',
  );
  artifacts.dependency = dependency.id;
  setup.dependency = {
    source: 'repository demo traces (orders and refunds read through the customer record)',
    artifactId: dependency.id,
    digest: dependency.digest,
    readBindings: dependency.ir.nodes.map((node) => ({ id: node.id, deps: node.deps })),
    checks: await approveWithShadows(dependencyServer, dependency.id, 'dependency'),
    apiEquivalentCostUsd: sumCost(ledger.slice(dependencyLedgerAt)),
  };
  await dependencyServer.close();
  currentHost = undefined;
  setup.phases = { ...phases };
  setup.wallMs = performance.now() - began;
  phase = 'warmup';
  for (const arm of selectiveArms) {
    const run = await executeCase(developmentCases[0], arm);
    warmups.push(run);
    guard(
      run.assessment.passed,
      `Warmup failed: ${arm} ${Object.entries(run.assessment.checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(', ')}.`,
    );
  }
  for (const scheduled of schedule) {
    phase = 'measurement';
    const entry: (typeof results)[number] = {
      caseId: scheduled.task.id,
      category: scheduled.task.category,
      group: scheduled.task.group,
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
          resources: run.requestedResources,
          correct: run.assessment.passed,
          outcome: run.measurement.outcome,
          tokens: run.measurement.totalTokens,
          models: run.measurement.modelCalls,
          reads: run.measurement.toolCalls,
          prerequisiteReads: run.prerequisiteReads,
          unnecessaryReads: run.unnecessaryReads,
          duplicateReads: run.duplicateSuccessfulReads,
          fallback: run.usedFallback,
          latencyMs: Math.round(run.measurement.durationMs),
          cost: run.apiEquivalentCostUsd,
        }),
      );
      // Provider accounting, authorization and (from v1.1) any oracle failure stop the run;
      // injected service faults are cases, not failures.
      if (run.measurement.totalTokens === null && run.measurement.outcome !== 'denied')
        throw new Error('Provider usage incomplete; bounded run stopped.');
      guard(run.authorizationViolations === 0, 'Authorization safety gate failed.');
      guard(
        run.assessment.passed,
        `Correctness gate failed: ${entry.caseId} ${arm} ${Object.entries(run.assessment.checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => name)
          .join(', ')}.`,
      );
      if (scheduled.task.fault.kind === 'denied')
        guard(
          run.measurement.outcome === 'denied' &&
            run.measurement.modelCalls === 0 &&
            run.businessReads.length === 0,
          'Denial safety gate failed.',
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
  const complete = results.filter((row) => selectiveArms.every((arm) => row.runs[arm]));
  const summarize = (rows: typeof complete) =>
    Object.fromEntries(
      selectiveArms.map((arm) => [arm, summarizeRouting(rows.map((row) => row.runs[arm]!))]),
    );
  const pair = (before: SelectiveArm, after: SelectiveArm, rows = complete) =>
    rows.length
      ? pairedRouting(
          rows.map((row) => ({
            caseId: row.caseId,
            baseline: row.runs[before]!,
            optimized: row.runs[after]!,
          })),
        )
      : null;
  const groups = [...new Set(cases.map((task) => task.group))];
  const extra = (rows: typeof complete) =>
    Object.fromEntries(
      selectiveArms.map((arm) => {
        const runs = rows.map((row) => row.runs[arm]!);
        const mean = (values: number[]) =>
          values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
        return [
          arm,
          {
            meanPrerequisiteReads: mean(runs.map((run) => run.prerequisiteReads)),
            authorizationViolations: runs.reduce((s, run) => s + run.authorizationViolations, 0),
            meanBusinessReads: mean(runs.map((run) => run.businessReads.length)),
          },
        ];
      }),
    );
  const synthetic = providerMode === 'fixture';
  const report = {
    capturedAt: new Date().toISOString(),
    split,
    providerMode,
    evidenceKind: synthetic
      ? 'FIXTURE HARNESS VALIDATION: scripted no-inference provider; tokens, model calls, costs and latencies are synthetic and are not measurements of any model or of Foundry performance.'
      : 'Live provider inference; costs are API-equivalent estimates, not billed cost.',
    complete: !failure && complete.length === schedule.length,
    failure,
    plan,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      provider: synthetic ? 'fixture-provider' : provider,
      model: synthetic ? 'none (scripted fixture)' : model,
      providerVersion,
      reasoningEffort: 'low support / none context',
      businessSnapshot: 'fixtures-v1 expanded synthetic records',
      readDelayMs: 2,
    },
    sourceHashes: sources,
    methodology: {
      cases,
      arms: {
        normal: 'Original typed lookup tools for the contract reads; no prefetch.',
        existing_selector_direct:
          'Shipped selector on the existing contract vocabulary (subset expressed as known reads) with direct fallback; partial contexts run normally.',
        selective_direct:
          'Subset contract selector; validated subset executed from the approved artifact with direct fallback (complete subsets use the existing prefetch path).',
        handwritten_selective:
          'Comparator: the exact contract reads loaded by hand-written code with one retry; agent-decided and no-context cases run normally.',
      },
      trainingIds: ['C-101', 'C-202'],
      shadowIds: ['C-101', 'C-202', 'C-303'],
      developmentIds: [...new Set(developmentCases.map((task) => task.customerId))],
      heldoutIds: [...new Set(heldoutCases.map((task) => task.customerId))],
      dependencyCase:
        'Uses an artifact compiled from repository demo traces (a real customer→orders/refunds dependency) through the same verify, trusted-shadow, approve and deploy lifecycle; its prerequisite read is counted separately and is permitted, not unnecessary.',
      registryIsolation:
        'Each request forks the same validated, approved and shadowed SQLite snapshot; quarantine is applied to its own fork.',
      freshnessContractMs: 30000,
      replyChecks:
        'Exact structured evidence/action labels, permitted/required reads, evidence grounded in a successful read in this request, delay/order grounding, unavailable acknowledgement and prohibited financial-action claims; no LLM judge.',
      uncertainty:
        'Descriptive paired case-block bootstrap. Sixteen synthetic case blocks are not a production workload sample.',
    },
    pricing: {
      ...rateCard,
      kind: synthetic
        ? 'Not applicable: synthetic fixture usage. Any cost figure is arithmetic on synthetic tokens.'
        : 'API-equivalent estimate; actual billing unknown',
      actualBilledCostUsd: null,
    },
    setup,
    shadowGates,
    steadyState: summarize(complete),
    steadyStateReads: extra(complete),
    byGroup: Object.fromEntries(
      groups.map((group) => {
        const rows = complete.filter((row) => row.group === group);
        return [group, { summary: summarize(rows), reads: extra(rows) }];
      }),
    ),
    byCategory: Object.fromEntries(
      cases.map((task) => [
        task.category,
        summarize(complete.filter((row) => row.category === task.category)),
      ]),
    ),
    paired: {
      selectiveVsNormal: pair('normal', 'selective_direct'),
      selectiveVsExisting: pair('existing_selector_direct', 'selective_direct'),
      selectiveVsHandwritten: pair('handwritten_selective', 'selective_direct'),
      existingVsNormal: pair('normal', 'existing_selector_direct'),
      handwrittenVsNormal: pair('normal', 'handwritten_selective'),
      healthySelective: {
        selectiveVsNormal: pair(
          'normal',
          'selective_direct',
          complete.filter((row) => row.group === 'healthy_selective'),
        ),
        selectiveVsExisting: pair(
          'existing_selector_direct',
          'selective_direct',
          complete.filter((row) => row.group === 'healthy_selective'),
        ),
        selectiveVsHandwritten: pair(
          'handwritten_selective',
          'selective_direct',
          complete.filter((row) => row.group === 'healthy_selective'),
        ),
      },
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
      providerAgentRequests: ledger.length,
      priorEvidence,
      includingPriorAttemptsApiEquivalentCostUsd:
        sumCost(ledger) === null || priorEvidence.some((run) => run.apiEquivalentCostUsd === null)
          ? null
          : sumCost(ledger)! +
            priorEvidence.reduce((sum, run) => sum + run.apiEquivalentCostUsd, 0),
      ledger,
      note: 'All setup, revalidation, warmups, failed reads, incorrect outputs and measured requests retained. Unknown charges are not zero.',
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
      providerMode,
      failure,
      steadyState: Object.fromEntries(
        selectiveArms.map((arm) => [
          arm,
          report.steadyState[arm] && {
            correctness: report.steadyState[arm]!.correctnessRate,
            meanTokens: report.steadyState[arm]!.mean.totalTokens,
            fallbackRate: report.steadyState[arm]!.fallbackRate,
          },
        ]),
      ),
      output,
    }),
  );
}
