import { randomUUID } from 'node:crypto';
import { customerInput, irDigest, type IRArtifact } from '../compiler/ir.js';
import type { ObservableResult } from '../exploration/tool-events.js';
import { buildCheckpoint, type ExecutionCheckpoint } from './checkpoint.js';
import { DeoptimizationError, interpret, type NodeTiming } from './interpret.js';
import type { AdapterRunner, RuntimeContext } from './adapters/registry.js';

export type TaskRequest = { kind: string; input: unknown };
export type GuardResult = { name: string; ok: boolean; detail: string };
export type AgentFallback = (
  request: TaskRequest,
  checkpoint: ExecutionCheckpoint | undefined,
) => Promise<{ summary: string; llmInvocations: number; tokens: number; resolved: boolean }>;
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
  createdAt: string;
};

// Last-mile selection is deterministic. Semantic similarity may propose a candidate elsewhere;
// nothing runs until every schema, policy, permission, adapter-version and freshness guard holds.
export function checkGuards(
  artifact: IRArtifact,
  request: TaskRequest,
  context: RuntimeContext,
  now = Date.now(),
): GuardResult[] {
  const ir = artifact.ir;
  const input = customerInput.safeParse(request.input);
  const missingScopes = ir.requiredScopes.filter((scope) => !context.scopes.includes(scope));
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
      missingScopes.length ? `missing ${missingScopes.join(', ')}` : ir.requiredScopes.join(', '),
    ),
    guard(
      'data_freshness',
      age >= 0 && age <= ir.guards.maxAgeMs,
      `${age}ms observed against a ${ir.guards.maxAgeMs}ms window`,
    ),
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
  },
): Promise<DispatchOutcome> {
  const runId = randomUUID();
  const base = {
    runId,
    taskKind: request.kind,
    input: request.input,
    llmInvocations: 0,
    agentTokens: 0,
    executedNodeIds: [] as string[],
    nodeTimings: [] as NodeTiming[],
    adapterCalls: 0,
    peakParallel: 0,
    createdAt: new Date().toISOString(),
  };
  const ordered = [...candidates].sort((a, b) => b.version - a.version);
  let guards: GuardResult[] = [];
  let selected: IRArtifact | undefined;
  for (const candidate of ordered) {
    const evaluated = checkGuards(candidate, request, options.context, options.now);
    if (candidate.taskKind === request.kind) guards = evaluated;
    if (evaluated.every((entry) => entry.ok)) {
      selected = candidate;
      guards = evaluated;
      break;
    }
  }
  if (!selected) {
    const reason = guards.length ? 'guard_miss' : 'no_candidate';
    const detail = guards.find((entry) => !entry.ok)?.name ?? 'no approved capability';
    const agentResult = await options.agent?.(request, undefined);
    return {
      ...base,
      mode: 'agent',
      guards,
      fallbackReason: reason,
      fallbackDetail: `${reason}: ${detail}`,
      llmInvocations: agentResult?.llmInvocations ?? 0,
      agentTokens: agentResult?.tokens ?? 0,
      agentSummary: agentResult?.summary,
      durationMs: 0,
    };
  }
  try {
    const run = await interpret(selected.ir, request.input, {
      adapters: options.adapters,
      context: options.context,
    });
    return {
      ...base,
      mode: 'compiled',
      capability: selected.name,
      capabilityId: selected.id,
      capabilityVersion: selected.version,
      capabilityDigest: selected.digest,
      guards,
      executedNodeIds: run.executedNodeIds,
      nodeTimings: run.nodeTimings,
      adapterCalls: run.adapterCalls,
      peakParallel: run.peakParallel,
      llmInvocations: run.llmInvocations,
      durationMs: run.durationMs,
      result: run.result,
      observable: run.observable,
    };
  } catch (error) {
    const deopt = error instanceof DeoptimizationError ? error : undefined;
    const checkpoint = buildCheckpoint({
      runId,
      artifact: selected,
      taskInput: request.input,
      reason: deopt?.detail.reason ?? 'runtime_failure',
      detail: error instanceof Error ? error.message : 'Compiled execution failed.',
      failedNodeId: deopt?.detail.nodeId,
      completedNodeIds: deopt?.detail.completedNodeIds,
      nextNodeIds: deopt?.detail.nextNodeIds,
      liveValues: deopt?.detail.liveValues,
      observedResourceVersions: deopt?.detail.observedResources,
    });
    const agentResult = await options.agent?.(request, checkpoint);
    return {
      ...base,
      mode: 'agent',
      capability: selected.name,
      capabilityId: selected.id,
      capabilityVersion: selected.version,
      capabilityDigest: selected.digest,
      guards,
      executedNodeIds: checkpoint.completedNodeIds,
      fallbackReason: checkpoint.reason,
      fallbackDetail: checkpoint.detail,
      checkpoint,
      llmInvocations: agentResult?.llmInvocations ?? 0,
      agentTokens: agentResult?.tokens ?? 0,
      agentSummary: agentResult?.summary,
      durationMs: 0,
    };
  }
}

function guard(name: string, ok: boolean, detail: string): GuardResult {
  return { name, ok, detail };
}
