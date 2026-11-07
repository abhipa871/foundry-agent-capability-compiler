import { authorizeReads, type RuntimeContext } from '../runtime/adapters/registry.js';
import type { IRArtifact, ReadOperation } from '../compiler/ir.js';
import { checkGuards } from '../runtime/dispatcher.js';
import {
  createReadWorkflowSelector,
  type PrefetchCostComparison,
  type ReadWorkflowContract,
  type ReadWorkflowSelection,
} from './read-workflow-selection.js';

const reads = ['crm.getCustomer', 'orders.list', 'payments.refundHistory'] as const;
const selector = createReadWorkflowSelector<ReadOperation, RuntimeContext>({
  operations: reads.map((name) => ({ name, effect: 'read' as const })),
  supportsSubsets: true,
  authorize: (input, context, resources) => {
    authorizeReads(context, input, resources);
  },
});

// JSON or model output cannot manufacture a registered application contract.
// Preserve the existing customer's public array type; registration still freezes it at runtime.
export type ContextContract = ReadWorkflowContract<ReadOperation> & {
  readonly reads: ReadOperation[];
};
export function defineContextContract(raw: {
  requirement: 'known' | 'agent_decides' | 'subset';
  reads: readonly ReadOperation[];
}): ContextContract {
  return selector.defineContract(raw) as ContextContract;
}
export type ExecutionSelection = ReadWorkflowSelection<ReadOperation>;
export type { PrefetchCostComparison };
export type ExecutionSelectionOptions = {
  prefetchCostComparison?: PrefetchCostComparison;
  // Application-owned local candidate. Null means known unavailable; omit if unknown.
  candidate?: IRArtifact | null;
};

export function selectExecution(
  contract: ContextContract,
  input: unknown,
  context: RuntimeContext,
  options: ExecutionSelectionOptions = {},
): ExecutionSelection {
  const selection = selector.select(contract, input, context, {
    prefetchCostComparison: options.prefetchCostComparison,
    readiness: (resources) => {
      // Preserve the legacy customer's unknown-availability behavior. New integrations must
      // implement readiness against their own validated capability and execution guards.
      if (options.candidate === undefined) return { status: 'ready' };
      if (options.candidate === null)
        return { status: 'unavailable', reason: 'no_available_capability' };
      const guards = checkGuards(
        options.candidate,
        { kind: 'customer_context', input },
        context,
        Date.now(),
        resources,
      );
      if (
        guards.some(
          (guard) =>
            !guard.ok && ['tenant', 'principal', 'scopes', 'policy_version'].includes(guard.name),
        )
      )
        return { status: 'denied', reason: 'capability_authorization_denied' };
      const miss = guards.find((guard) => !guard.ok);
      return miss
        ? { status: 'unavailable', reason: `capability_guard_miss:${miss.name}` }
        : { status: 'ready' };
    },
  });
  // Keep existing customer-specific telemetry reasons stable for SDK consumers.
  if (selection.reason === 'contract_requires_no_reads')
    selection.reason = 'contract_requires_no_customer_reads';
  return selection;
}
export type { ReadOperation };
