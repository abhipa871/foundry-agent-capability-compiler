import { canonical } from '../ir.js';
import { DomainError } from '../../domain.js';
import type { StoredToolTrace } from '../../exploration/tool-events.js';
import { contracts } from '../../runtime/adapters/registry.js';
import type { PatternMatch } from '../patterns.js';

export type DedupeResult = { eliminated: number; optimizations: string[] };

// Two captured calls collapse into one IR node only when the operation, the resolved arguments,
// the principal scopes, the adapter version, and the freshness window all match. Writes are never
// coalesced; this pass asserts the candidate is read-only before touching anything.
export function dedupeReads(
  match: PatternMatch,
  traces: Map<string, StoredToolTrace>,
  freshnessMs: number,
): DedupeResult {
  const optimizations: string[] = [];
  let eliminated = 0;
  for (const node of match.nodes) {
    if (!(node.operation in contracts))
      throw new DomainError(`Cannot dedupe an uncontracted operation: ${node.operation}.`, 409);
    for (const occurrence of node.occurrences) {
      if (occurrence.eventIds.length < 2) continue;
      const trace = traces.get(occurrence.traceId);
      if (!trace) throw new DomainError('Supporting trace is missing.', 409);
      const events = occurrence.eventIds.map((id) =>
        trace.events.find((event) => event.eventId === id)!,
      );
      if (events.some((event) => event.effect !== 'read'))
        throw new DomainError('Refusing to coalesce a non-read effect.', 409);
      const versions = new Set(events.map((event) => event.adapterVersion));
      const scopes = new Set(events.map((event) => [...event.credentialScopeIds].sort().join(',')));
      const principals = new Set(
        events.map((event) => event.principalId ?? trace.principalId ?? 'local-operator'),
      );
      const args = new Set(
        events.map((event) => JSON.stringify(Object.values(event.args).map((arg) => arg.value))),
      );
      const outputs = new Set(events.map((event) => canonical(event.result?.projection)));
      const resources = new Set(events.map((event) => JSON.stringify(event.reads)));
      const span =
        Math.max(...events.map((event) => event.endMs)) -
        Math.min(...events.map((event) => event.startMs));
      if (
        versions.size !== 1 ||
        scopes.size !== 1 ||
        principals.size !== 1 ||
        args.size !== 1 ||
        resources.size !== 1 ||
        outputs.size !== 1 ||
        span > freshnessMs
      )
        throw new DomainError(
          `Duplicate reads of ${node.operation} differ in adapter version, principal, freshness window, or observed output and cannot be coalesced.`,
          409,
        );
      eliminated += events.length - 1;
      optimizations.push(
        `eliminated ${events.length - 1} duplicate read(s) of ${node.operation} (identical args, adapter version ${[...versions][0]}, ${span}ms apart within a ${freshnessMs}ms window)`,
      );
    }
  }
  return { eliminated, optimizations };
}
