import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain.js';
import {
  accessSchema,
  digest,
  json,
  type AccessContext,
  type ContractRegistry,
  type Json,
} from '../compiler/contracts.js';
import {
  levels,
  materialize,
  taskPlanSchema,
  validateTaskPlan,
  type TaskPlan,
} from '../compiler/task-ir.js';

export const taskArtifactSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().min(1).max(80),
    plan: taskPlanSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['draft', 'verified', 'approved', 'revoked']),
    verifiedDigest: z.string().optional(),
    approvedDigest: z.string().optional(),
    verificationId: z.string().uuid().optional(),
    checks: z.array(z.object({ name: z.string(), passed: z.boolean() }).strict()).max(512),
  })
  .strict();
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;
export type TaskCheckpoint = {
  id: string;
  kind: string;
  artifactDigest?: string;
  completedNodes: string[];
  liveValues: Record<string, Json>;
  completedEffects: never[];
  reason: string;
};
export type TaskOutcome = {
  mode: 'compiled' | 'fallback' | 'denied';
  outcome: 'success' | 'unresolved' | 'denied';
  result?: Json;
  checkpoint?: TaskCheckpoint;
  llmInvocations: 0;
  toolCalls: number;
};

export function guardTask(
  artifact: TaskArtifact,
  kind: string,
  input: unknown,
  rawContext: AccessContext,
  registry: ContractRegistry,
  now = Date.now(),
  allowDraft = false,
): { plan: TaskPlan; input: Json; context: AccessContext } {
  const context = accessSchema.parse(json(rawContext));
  const plan = validateTaskPlan(artifact.plan, registry);
  if (
    artifact.tenantId !== context.tenantId ||
    plan.tenantId !== context.tenantId ||
    plan.principalId !== context.principalId ||
    plan.policyVersion !== context.policyVersion
  )
    throw new DomainError('Capability access denied.', 403);
  if (artifact.digest !== digest(plan)) throw new DomainError('Artifact digest mismatch.', 409);
  if (
    !allowDraft &&
    (artifact.status !== 'approved' ||
      artifact.approvedDigest !== artifact.digest ||
      artifact.verifiedDigest !== artifact.digest ||
      !artifact.checks.length ||
      artifact.checks.some((check) => !check.passed))
  )
    throw new DomainError('Artifact is not approved for this digest.', 409);
  if (kind !== plan.kind || plan.snapshot !== context.snapshot)
    throw new DomainError('Task or snapshot mismatch.', 409);
  const task = registry.task(kind);
  const age = now - context.observedAt;
  if (age < 0 || age > task.maxAgeMs) throw new DomainError('Runtime context is stale.', 409);
  for (const node of plan.nodes) {
    if (registry.tool(node.tool).scopes.some((scope) => !context.scopes.includes(scope)))
      throw new DomainError('Required scope denied.', 403);
  }
  return { plan, input: registry.authorizeTask(kind, input, context), context };
}

// Only trusted application handlers execute. The plan contains references and bindings, never code.
export async function runTaskPlan(
  artifact: TaskArtifact,
  kind: string,
  rawInput: unknown,
  rawContext: AccessContext,
  registry: ContractRegistry,
  options: { allowDraft?: boolean; signal?: AbortSignal } = {},
): Promise<TaskOutcome> {
  const values = new Map<string, Json>();
  const completedNodes: string[] = [];
  let toolCalls = 0;
  try {
    const { plan, input, context } = guardTask(
      artifact,
      kind,
      rawInput,
      rawContext,
      registry,
      Date.now(),
      options.allowDraft,
    );
    const task = registry.task(kind);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const timer = setTimeout(() => controller.abort(), task.timeoutMs);
    try {
      for (const batch of levels(plan)) {
        for (let index = 0; index < batch.length; index += task.maxConcurrency) {
          // Drain siblings before handoff; late completions cannot mutate a returned checkpoint.
          const settled = await Promise.allSettled(
            batch.slice(index, index + task.maxConcurrency).map(async (node) => {
              signal.throwIfAborted();
              const args = materialize(node.args, input, values);
              toolCalls++;
              const result = await registry.invoke(kind, node.tool, args, context, signal);
              signal.throwIfAborted();
              values.set(node.id, result);
              completedNodes.push(node.id);
            }),
          );
          const failed = settled.find((entry) => entry.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        }
      }
      signal.throwIfAborted();
      const result = json(task.output.parse(materialize(plan.output, input, values)));
      return { mode: 'compiled', outcome: 'success', result, toolCalls, llmInvocations: 0 };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  } catch (error) {
    // Do not echo provider errors, arguments, credentials, or partial task results.
    const denied = error instanceof DomainError && error.status === 403;
    if (denied) return { mode: 'denied', outcome: 'denied', toolCalls, llmInvocations: 0 };
    return {
      mode: 'fallback',
      outcome: 'unresolved',
      toolCalls,
      llmInvocations: 0,
      checkpoint: {
        id: randomUUID(),
        kind,
        artifactDigest: artifact.digest,
        completedNodes: completedNodes.sort(),
        liveValues: Object.fromEntries(values),
        completedEffects: [],
        reason: 'Task execution failed a guard, output validation, or deadline.',
      },
    };
  }
}
