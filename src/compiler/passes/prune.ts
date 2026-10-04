import { DomainError } from '../../domain.js';
import type { ProvenanceGraph } from '../../exploration/provenance.js';

export type PrunedEvent = { eventId: string; operation: string; reason: string; detail: string };
export type PruneResult = {
  keptEventIds: string[];
  pruned: PrunedEvent[];
  optimizations: string[];
};

const detail: Record<string, string> = {
  failed_event: 'Failed call retained as exception evidence, excluded from the runtime plan.',
  skipped_event: 'Skipped call retained as exception evidence, excluded from the runtime plan.',
  operation_without_contract: 'No typed adapter contract; cannot be compiled or executed.',
  effect_outside_read_only_compiler: 'Write effect is outside the read-only compiler scope.',
  argument_shape_unsupported: 'Argument shape has no IR mapping.',
};

// Exploratory branches are removed from the plan but never deleted: their event ids stay in the
// artifact provenance as exception evidence for later specialization. Policy checks are never
// pruned - a trace whose policy step cannot be compiled is rejected instead.
export function prune(graphs: ProvenanceGraph[]): PruneResult {
  const pruned: PrunedEvent[] = [];
  const keptEventIds: string[] = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.supported) {
        keptEventIds.push(node.eventId);
        continue;
      }
      if (
        node.operation.startsWith('policy.') ||
        (node.reason === 'operation_without_contract' && node.status === 'success') ||
        node.effect === 'external_write' ||
        node.effect === 'write'
      )
        throw new DomainError(
          `Refusing to prune ${node.operation}: policy and external-write steps must be compiled or the trace rejected.`,
          409,
        );
      pruned.push({
        eventId: node.eventId,
        operation: node.operation,
        reason: node.reason ?? 'unsupported',
        detail: detail[node.reason ?? ''] ?? 'Not part of the supported computation.',
      });
    }
  }
  if (!keptEventIds.length) throw new DomainError('Nothing supported survived pruning.', 409);
  return {
    keptEventIds,
    pruned,
    optimizations: pruned.length
      ? [`pruned ${pruned.length} exploratory event(s); evidence retained in provenance`]
      : [],
  };
}
