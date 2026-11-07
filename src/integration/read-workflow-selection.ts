import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const costSchema = z
  .object({
    pairedRequests: z.number().int().positive(),
    baselineMeanCostUsd: z.number().nonnegative(),
    prefetchMeanCostUsd: z.number().nonnegative(),
  })
  .strict();
export type PrefetchCostComparison = z.infer<typeof costSchema>;
export type ReadWorkflowSelection<Operation extends string> = {
  mode: 'normal' | 'compiled_tool' | 'compiled_prefetch' | 'denied';
  reason: string;
  durationMs: number;
  resources: Operation[];
};
declare const registeredContract: unique symbol;
export type ReadWorkflowContract<Operation extends string> = Readonly<{
  requirement: 'known' | 'agent_decides' | 'subset';
  reads: readonly Operation[];
}> & { readonly [registeredContract]: true };
export type ReadWorkflowReadiness =
  { status: 'ready' } | { status: 'unavailable' | 'denied'; reason: string };
const readinessSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready') }).strict(),
  z
    .object({ status: z.enum(['unavailable', 'denied']), reason: z.string().min(1).max(160) })
    .strict(),
]);

// This is a routing policy, not an executor. Only application code can register contracts and
// supply authorization/readiness checks for a separately validated, read-only capability.
export function createReadWorkflowSelector<Operation extends string, Context>(config: {
  operations: readonly { name: Operation; effect: 'read' }[];
  supportsSubsets: boolean;
  authorize: (input: unknown, context: Context, reads: readonly Operation[]) => undefined;
}) {
  const definitions = z
    .array(
      z
        .object({ name: z.string().regex(/^[A-Za-z][\w.-]{0,79}$/), effect: z.literal('read') })
        .strict(),
    )
    .min(1)
    .max(64)
    .parse(config.operations);
  const operations = definitions.map((entry) => entry.name as Operation);
  if (new Set(operations).size !== operations.length)
    throw new Error('Duplicate workflow operation.');
  const contractSchema = z
    .object({
      requirement: z.enum(['known', 'agent_decides', 'subset']),
      reads: z.array(z.enum(operations)).max(operations.length),
    })
    .strict()
    .refine((value) => value.requirement !== 'subset' || value.reads.length > 0, {
      message: 'A subset contract must name at least one resource.',
    });
  const contracts = new WeakSet<object>();
  // Copy these bindings so mutating the caller's configuration cannot change registered policy.
  const authorize = config.authorize;
  const supportsSubsets = config.supportsSubsets;
  function defineContract(raw: {
    requirement: 'known' | 'agent_decides' | 'subset';
    reads: readonly Operation[];
  }): ReadWorkflowContract<Operation> {
    const contract = contractSchema.parse(raw);
    if (new Set(contract.reads).size !== contract.reads.length)
      throw new Error('Duplicate contract read.');
    Object.freeze(contract.reads);
    Object.freeze(contract);
    contracts.add(contract);
    return contract as unknown as ReadWorkflowContract<Operation>;
  }
  function select(
    contract: ReadWorkflowContract<Operation>,
    input: unknown,
    context: Context,
    options: {
      readiness: (resources?: readonly Operation[]) => ReadWorkflowReadiness;
      prefetchCostComparison?: PrefetchCostComparison;
    },
  ): ReadWorkflowSelection<Operation> {
    const began = performance.now();
    const result = (
      mode: ReadWorkflowSelection<Operation>['mode'],
      reason: string,
      resources: Operation[] = [],
    ): ReadWorkflowSelection<Operation> => ({
      mode,
      reason,
      resources,
      durationMs: performance.now() - began,
    });
    if (!contracts.has(contract)) return result('normal', 'untrusted_task_metadata');
    try {
      const authorization: unknown = authorize(input, context, contract.reads);
      if (authorization !== undefined) {
        if (authorization instanceof Promise) void authorization.catch(() => {});
        throw new Error('Authorization must complete synchronously.');
      }
    } catch {
      return result('denied', 'task_authorization_denied');
    }
    if (!contract.reads.length) return result('normal', 'contract_requires_no_reads');
    const complete = operations.every((operation) => contract.reads.includes(operation));
    if (contract.requirement !== 'subset' && !complete)
      return result('normal', 'compiled_region_exceeds_contract_reads');
    if (contract.requirement === 'subset' && !complete && !supportsSubsets)
      return result('normal', 'resource_subsets_not_supported');
    const resources = operations.filter((operation) => contract.reads.includes(operation));
    try {
      const value: unknown = options.readiness(complete ? undefined : resources);
      if (value instanceof Promise) {
        void value.catch(() => {});
        throw new Error('Readiness must complete synchronously.');
      }
      const readiness = readinessSchema.parse(value);
      if (readiness.status !== 'ready')
        return result(readiness.status === 'denied' ? 'denied' : 'normal', readiness.reason);
    } catch {
      // A broken security/readiness integration is not permission to fall back around its checks.
      return result('denied', 'capability_readiness_failed_closed');
    }
    if (contract.requirement === 'agent_decides')
      return result('compiled_tool', 'agent_must_decide_whether_context_is_needed');
    if (options.prefetchCostComparison !== undefined) {
      const comparison = costSchema.safeParse(options.prefetchCostComparison);
      if (!comparison.success) return result('normal', 'prefetch_cost_evidence_invalid');
      if (comparison.data.prefetchMeanCostUsd >= comparison.data.baselineMeanCostUsd)
        return result('normal', 'measured_prefetch_cost_not_lower');
    }
    return result(
      'compiled_prefetch',
      complete
        ? 'trusted_contract_requires_complete_context'
        : 'trusted_contract_requires_resource_subset',
      resources,
    );
  }
  return Object.freeze({ defineContract, select });
}
