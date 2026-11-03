import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { authorizeReads, type RuntimeContext } from '../runtime/adapters/registry.js';
import type { IRArtifact, ReadOperation } from '../compiler/ir.js';
import { checkGuards } from '../runtime/dispatcher.js';

const reads = ['crm.getCustomer', 'orders.list', 'payments.refundHistory'] as const;
const schema = z
  .object({
    // `subset` is opt-in: the application states the exact reads that must precede inference.
    requirement: z.enum(['known', 'agent_decides', 'subset']),
    reads: z.array(z.enum(reads)).max(3),
  })
  .strict()
  .refine((value) => value.requirement !== 'subset' || value.reads.length > 0, {
    message: 'A subset contract must name at least one resource.',
  });
const registered = new WeakSet<object>();
declare const validated: unique symbol;
export type ContextContract = Readonly<z.infer<typeof schema>> & { readonly [validated]: true };

// Register application-owned metadata in code. JSON supplied by a user/model is not a trusted
// contract. The schema validates shape; the application is responsible for its task semantics.
export function defineContextContract(raw: z.input<typeof schema>): ContextContract {
  const value = schema.parse(raw);
  if (new Set(value.reads).size !== value.reads.length) throw new Error('Duplicate contract read.');
  Object.freeze(value.reads);
  Object.freeze(value);
  registered.add(value);
  return value as ContextContract;
}
// A known subset is prefetch of fewer resources, so it reuses `compiled_prefetch` (no new mode for
// exhaustive consumers to handle); `reason` and `resources` distinguish it. Pass `resources` to
// `FoundryClient.execute` so only those reads, and their approved prerequisites, run.
export type ExecutionSelection = {
  mode: 'normal' | 'compiled_tool' | 'compiled_prefetch' | 'denied';
  reason: string;
  durationMs: number;
  // Reads the selected mode loads before inference, in canonical order; empty otherwise.
  resources: ReadOperation[];
};

const prefetchCostSchema = z
  .object({
    pairedRequests: z.number().int().positive(),
    baselineMeanCostUsd: z.number().nonnegative(),
    prefetchMeanCostUsd: z.number().nonnegative(),
  })
  .strict();
// Application-owned, comparable complete-task measurements, including request overhead and
// failures. This evidence may veto prefetch; it cannot authorize reads or approve an artifact.
export type PrefetchCostComparison = z.infer<typeof prefetchCostSchema>;
export type ExecutionSelectionOptions = {
  prefetchCostComparison?: PrefetchCostComparison;
  // Application-owned local candidate, not an artifact supplied by the prompt. Null means the
  // application knows there is no available capability (including quarantine). Omit if unknown.
  candidate?: IRArtifact | null;
};

export function selectExecution(
  contract: ContextContract,
  input: unknown,
  context: RuntimeContext,
  options: ExecutionSelectionOptions = {},
): ExecutionSelection {
  const began = performance.now();
  const result = (
    mode: ExecutionSelection['mode'],
    reason: string,
    resources: ReadOperation[] = [],
  ) => ({
    mode,
    reason,
    durationMs: performance.now() - began,
    resources,
  });
  const readiness = (resources?: ReadOperation[]) => {
    if (options.candidate === undefined) return undefined;
    if (options.candidate === null) return result('normal', 'no_available_capability');
    const guards = checkGuards(
      options.candidate,
      { kind: 'customer_context', input },
      context,
      Date.now(),
      resources,
    );
    // Match dispatch's terminal authorization semantics, even when another guard also misses.
    if (
      guards.some(
        (guard) =>
          !guard.ok && ['tenant', 'principal', 'scopes', 'policy_version'].includes(guard.name),
      )
    )
      return result('denied', 'capability_authorization_denied');
    const miss = guards.find((guard) => !guard.ok);
    return miss ? result('normal', `capability_guard_miss:${miss.name}`) : undefined;
  };
  const prefetch = (reason: string, resources: ReadOperation[]) => {
    const unavailable = readiness(resources.length === reads.length ? undefined : resources);
    if (unavailable) return unavailable;
    if (options.prefetchCostComparison !== undefined) {
      const comparison = prefetchCostSchema.safeParse(options.prefetchCostComparison);
      if (!comparison.success) return result('normal', 'prefetch_cost_evidence_invalid');
      if (comparison.data.prefetchMeanCostUsd >= comparison.data.baselineMeanCostUsd)
        return result('normal', 'measured_prefetch_cost_not_lower');
    }
    return result('compiled_prefetch', reason, resources);
  };
  if (!registered.has(contract)) return result('normal', 'untrusted_task_metadata');
  try {
    authorizeReads(context, input, contract.reads);
  } catch {
    return result('denied', 'task_authorization_denied');
  }
  const complete = reads.every((read) => contract.reads.includes(read));
  if (!contract.reads.length) return result('normal', 'contract_requires_no_customer_reads');
  if (contract.requirement === 'subset')
    return complete
      ? prefetch('trusted_contract_requires_complete_context', [...reads])
      : prefetch(
          'trusted_contract_requires_resource_subset',
          reads.filter((read) => contract.reads.includes(read)),
        );
  if (!complete) return result('normal', 'compiled_region_exceeds_contract_reads');
  if (contract.requirement === 'agent_decides')
    return readiness() ?? result('compiled_tool', 'agent_must_decide_whether_context_is_needed');
  return prefetch('trusted_contract_requires_complete_context', [...reads]);
}
export type { ReadOperation };
