import { performance } from 'node:perf_hooks';
import { DomainError } from '../domain.js';
import { redact } from '../exploration/privacy.js';
import { emptyMeasurement, type Measurement } from '../telemetry/measurement.js';
import { authorizeContext, authorizeReads, contracts } from './adapters/registry.js';
import { randomUUID } from 'node:crypto';
import { customerInput, irDigest, type IRArtifact, type ReadOperation } from '../compiler/ir.js';
import type { ObservableResult } from '../exploration/tool-events.js';
import { buildCheckpoint, type ExecutionCheckpoint } from './checkpoint.js';
import { DeoptimizationError, interpret, interpretSelected, type NodeTiming } from './interpret.js';
import { planSelection, resourceSelectionSchema } from './selective.js';
import type { AdapterRunner, RuntimeContext } from './adapters/registry.js';

// `resources` is set only for an application-selected subset so a fallback agent knows its scope.
export type TaskRequest = { kind: string; input: unknown; resources?: readonly ReadOperation[] };
export type GuardResult = { name: string; ok: boolean; detail: string };
export type AgentFallback = (
  request: TaskRequest,
  checkpoint: ExecutionCheckpoint | undefined,
) => Promise<{
  summary: string;
  llmInvocations: number;
  tokens: number;
  resolved: boolean;
  result?: Record<string, unknown>;
  observable?: ObservableResult;
  measurement?: Measurement;
  toolCalls?: number;
}>;
export class AgentExecutionError extends Error {
  constructor(readonly measurement: Measurement) {
    super('Native agent execution failed.');
  }
}
export type DispatchOutcome = {
  runId: string;
  mode: 'compiled' | 'agent';
  taskKind: string;
  input: unknown;
  capability?: string;
  capabilityId?: string;
  capabilityVersion?: number;
  capabilityDigest?: string;
  guards: GuardResult[];
  llmInvocations: number;
  agentTokens: number;
  executedNodeIds: string[];
  nodeTimings: NodeTiming[];
  adapterCalls: number;
  peakParallel: number;
  durationMs: number;
  result?: Record<string, unknown>;
  observable?: ObservableResult;
  fallbackReason?: 'no_candidate' | 'guard_miss' | ExecutionCheckpoint['reason'];
  fallbackDetail?: string;
  checkpoint?: ExecutionCheckpoint;
  agentSummary?: string;
  // Present only for a requested subset. Prerequisites were executed but not returned.
  selection?: { resources: ReadOperation[]; prerequisites: ReadOperation[] };
  createdAt: string;
  outcome: Measurement['outcome'];
  measurement: Measurement;
  errorClass?: string;
};

// Last-mile selection is deterministic. Semantic similarity may propose a candidate elsewhere;
// nothing runs until every schema, policy, permission, adapter-version and freshness guard holds.
// With `resources`, the scope guard covers the requested reads; whether the approved plan can
// produce them (and its prerequisites are authorized) is a separate, non-security guard.
export function checkGuards(
  artifact: IRArtifact,
  request: TaskRequest,
  context: RuntimeContext,
  now = Date.now(),
  resources?: readonly ReadOperation[],
): GuardResult[] {
  const ir = artifact.ir;
  const input = customerInput.safeParse(request.input);
  const requiredScopes = resources
    ? [...new Set(resources.map((operation) => contracts[operation].scope))]
    : ir.requiredScopes;
  const missingScopes = requiredScopes.filter((scope) => !context.scopes.includes(scope));
  let selection: GuardResult | undefined;
  if (resources) {
    try {
      const plan = planSelection(ir, resources);
      if (plan.prerequisites.length) authorizeReads(context, request.input, plan.prerequisites);
      selection = guard(
        'resource_selection',
        true,
        plan.prerequisites.length
          ? `prerequisites ${plan.prerequisites.join(', ')}`
          : 'requested reads only',
      );
    } catch (error) {
      selection = guard(
        'resource_selection',
        false,
        error instanceof DomainError && error.status === 403
          ? 'prerequisite read not authorized'
          : error instanceof Error
            ? error.message
            : 'selection unavailable',
      );
    }
  }
  const drifted = Object.entries(ir.adapterVersions).filter(
    ([operation, version]) =>
      context.adapterVersions[operation as keyof typeof context.adapterVersions] !== version,
  );
  const age = now - context.observedAt;
  return [
    guard('artifact_status', artifact.status === 'approved', `status ${artifact.status}`),
    guard(
      'artifact_digest',
      irDigest(ir) === artifact.digest && artifact.approvedDigest === artifact.digest,
      'recomputed digest must match the approved digest',
    ),
    guard(
      'validation',
      artifact.verifiedDigest === artifact.digest &&
        Boolean(artifact.checks.length) &&
        artifact.checks.every((check) => check.passed),
      'current passing verification required',
    ),
    guard(
      'principal',
      !ir.guards.principalId || context.principalId === ir.guards.principalId,
      'principal binding',
    ),
    guard('compiler_version', ir.compilerVersion === 'read-ir-v1', ir.compilerVersion),
    guard('task_kind', ir.taskKind === request.kind, `${ir.taskKind} vs ${request.kind}`),
    guard(
      'input_schema',
      input.success,
      input.success ? ir.inputsSchemaId : 'input rejected by customer_input.v1',
    ),
    guard('tenant', context.tenantId === ir.guards.tenantId, context.tenantId),
    guard('data_snapshot', context.snapshot === ir.guards.snapshot, context.snapshot),
    guard('policy_version', context.policyVersion === ir.policyVersion, context.policyVersion),
    guard(
      'adapter_versions',
      drifted.length === 0,
      drifted.length ? `drifted: ${drifted.map(([op]) => op).join(', ')}` : 'pinned versions match',
    ),
    guard(
      'scopes',
      missingScopes.length === 0,
      missingScopes.length ? `missing ${missingScopes.join(', ')}` : requiredScopes.join(', '),
    ),
    guard(
      'data_freshness',
      age >= 0 && age <= ir.guards.maxAgeMs,
      `${age}ms observed against a ${ir.guards.maxAgeMs}ms window`,
    ),
    ...(selection ? [selection] : []),
  ];
}

export async function dispatch(
  request: TaskRequest,
  candidates: IRArtifact[],
  options: {
    adapters: AdapterRunner;
    context: RuntimeContext;
    agent?: AgentFallback;
    now?: number;
    resources?: readonly ReadOperation[];
  },
): Promise<DispatchOutcome> {
  const started = performance.now();
  const runId = randomUUID();
  const resources =
    options.resources === undefined ? undefined : resourceSelectionSchema.parse(options.resources);
  const task = resources ? { ...request, resources } : request;
  const base = {
    runId,
    taskKind: request.kind,
    input: redact(request.input),
    llmInvocations: 0,
    agentTokens: 0,
    executedNodeIds: [] as string[],
    nodeTimings: [] as NodeTiming[],
    adapterCalls: 0,
    peakParallel: 0,
    createdAt: new Date().toISOString(),
  };
  const measure = (outcome: Measurement['outcome'], toolCalls = 0): Measurement => ({
    ...emptyMeasurement(),
    outcome,
    toolCalls,
    durationMs: performance.now() - started,
  });
  const denied = (
    guards: GuardResult[],
    detail: string,
    attempted?: DeoptimizationError['detail'],
  ): DispatchOutcome => ({
    ...base,
    mode: 'agent',
    guards,
    outcome: 'denied',
    measurement: measure('denied', attempted?.adapterCalls ?? 0),
    adapterCalls: attempted?.adapterCalls ?? 0,
    nodeTimings: attempted?.nodeTimings ?? [],
    durationMs: performance.now() - started,
    fallbackReason: 'guard_miss',
    fallbackDetail: detail,
  });
  if (request.kind === 'customer_context') {
    try {
      if (resources) authorizeReads(options.context, request.input, resources);
      else authorizeContext(options.context, request.input);
    } catch {
      return denied([], 'Task authorization or input validation denied.');
    }
  }
  let guards: GuardResult[] = [];
  let selected: IRArtifact | undefined;
  for (const candidate of [...candidates].sort((a, b) => b.version - a.version)) {
    const evaluated = checkGuards(candidate, request, options.context, options.now, resources);
    if (candidate.taskKind === request.kind) guards = evaluated;
    if (evaluated.every((entry) => entry.ok)) {
      selected = candidate;
      guards = evaluated;
      break;
    }
  }
  const fallback = async (
    reason: NonNullable<DispatchOutcome['fallbackReason']>,
    detail: string,
    checkpoint?: ExecutionCheckpoint,
    attempted?: DeoptimizationError['detail'],
  ): Promise<DispatchOutcome> => {
    let agent: Awaited<ReturnType<AgentFallback>> | undefined;
    let failed = false;
    let failedMeasurement: Measurement | undefined;
    try {
      agent = await options.agent?.(task, checkpoint);
    } catch (error) {
      failed = true;
      if (error instanceof AgentExecutionError) failedMeasurement = error.measurement;
    }
    const outcome = failed ? 'failed' : agent?.resolved ? 'success' : 'unresolved';
    const reported = agent?.measurement ?? failedMeasurement;
    const measurement = reported
      ? { ...reported }
      : {
          ...measure(outcome),
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          totalTokens: agent?.tokens ?? null,
          modelCalls: agent?.llmInvocations ?? null,
          toolCalls: agent?.toolCalls ?? null,
          apiCalls: null,
        };
    measurement.outcome = outcome;
    measurement.durationMs = performance.now() - started;
    measurement.toolCalls =
      measurement.toolCalls === null
        ? null
        : measurement.toolCalls + (attempted?.adapterCalls ?? 0);
    return {
      ...base,
      mode: 'agent',
      guards,
      outcome,
      measurement,
      checkpoint,
      ...(selected
        ? {
            capability: selected.name,
            capabilityId: selected.id,
            capabilityVersion: selected.version,
            capabilityDigest: selected.digest,
          }
        : {}),
      fallbackReason: reason,
      fallbackDetail: detail,
      ...(resources
        ? {
            selection: {
              resources,
              prerequisites: selected ? planSelection(selected.ir, resources).prerequisites : [],
            },
          }
        : {}),
      executedNodeIds: checkpoint?.completedNodeIds ?? [],
      nodeTimings: attempted?.nodeTimings ?? [],
      adapterCalls: (attempted?.adapterCalls ?? 0) + (agent?.toolCalls ?? 0),
      peakParallel: attempted?.peakParallel ?? 0,
      llmInvocations: agent?.llmInvocations ?? 0,
      agentTokens: agent?.tokens ?? 0,
      agentSummary: agent?.summary ? String(redact(agent.summary)) : undefined,
      result: agent?.resolved ? agent.result : undefined,
      observable: agent?.resolved ? agent.observable : undefined,
      durationMs: measurement.durationMs,
      errorClass: failed ? 'agent_failure' : undefined,
    };
  };
  if (!selected) {
    const security = guards.find(
      (entry) =>
        !entry.ok && ['tenant', 'principal', 'scopes', 'policy_version'].includes(entry.name),
    );
    if (security) return denied(guards, 'Capability authorization denied.');
    const reason = guards.length ? 'guard_miss' : 'no_candidate';
    return fallback(
      reason,
      `${reason}: ${guards.find((entry) => !entry.ok)?.name ?? 'no approved capability'}`,
    );
  }
  try {
    const execution = { adapters: options.adapters, context: options.context };
    const run = resources
      ? await interpretSelected(selected.ir, request.input, { ...execution, resources })
      : await interpret(selected.ir, request.input, execution);
    const measurement = measure('success', run.adapterCalls);
    return {
      ...base,
      mode: 'compiled',
      outcome: 'success',
      measurement,
      capability: selected.name,
      capabilityId: selected.id,
      capabilityVersion: selected.version,
      capabilityDigest: selected.digest,
      guards,
      executedNodeIds: run.executedNodeIds,
      nodeTimings: run.nodeTimings,
      adapterCalls: run.adapterCalls,
      peakParallel: run.peakParallel,
      durationMs: measurement.durationMs,
      result: run.result,
      ...('observable' in run
        ? { observable: run.observable }
        : { selection: { resources: run.resources, prerequisites: run.prerequisites } }),
    };
  } catch (error) {
    const deopt = error instanceof DeoptimizationError ? error : undefined;
    if (deopt?.detail.status === 403 || (error instanceof DomainError && error.status === 403))
      return denied(guards, 'Adapter authorization denied.', deopt?.detail);
    const checkpoint = buildCheckpoint({
      runId,
      artifact: selected,
      taskInput: request.input,
      reason: deopt?.detail.reason ?? 'runtime_failure',
      detail: 'Compiled read failed; authorized agent handoff required.',
      failedNodeId: deopt?.detail.nodeId,
      completedNodeIds: deopt?.detail.completedNodeIds,
      nextNodeIds: deopt?.detail.nextNodeIds,
      liveValues: deopt?.detail.liveValues,
      observedResourceVersions: deopt?.detail.observedResources,
    });
    return fallback(checkpoint.reason, checkpoint.detail, checkpoint, deopt?.detail);
  }
}

function guard(name: string, ok: boolean, detail: string): GuardResult {
  return { name, ok, detail };
}
