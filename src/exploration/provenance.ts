import { DomainError } from '../domain.js';
import { contracts } from '../runtime/adapters/registry.js';
import type { ArgExpr, StoredToolTrace } from './tool-events.js';

export type ProvenanceNode = {
  eventId: string;
  operation: string;
  adapterId: string;
  adapterVersion: string;
  status: 'success' | 'failed' | 'skipped';
  effect: 'pure' | 'read' | 'write' | 'external_write';
  args: Record<string, ArgExpr>;
  dataDeps: string[];
  effectDeps: string[];
  supported: boolean;
  reason?: string;
};
export type ProvenanceGraph = {
  traceId: string;
  taskKind: string;
  taskInput: { customerId: string };
  nodes: ProvenanceNode[];
  terminalIds: string[];
};

// Dependency rules, in order of authority:
//   1. value provenance  - an arg sourced from another event's output is a real data edge;
//   2. effect ordering   - a write is ordered against anything touching the same resource key;
//   3. nothing else      - `parentSpanId` and wall-clock order are never treated as dependencies.
export function buildProvenance(trace: StoredToolTrace): ProvenanceGraph {
  const byId = new Map(trace.events.map((event) => [event.eventId, event]));
  const nodes: ProvenanceNode[] = trace.events.map((event) => {
    const dataDeps = [
      ...new Set(
        Object.values(event.args).flatMap((arg) =>
          arg.source === 'event_output' ? [arg.ref.producerEventId] : [],
        ),
      ),
    ].sort();
    const touched = [...event.reads, ...event.writes].map((ref) => `${ref.system}/${ref.key}`);
    const effectDeps =
      event.effect === 'write' || event.effect === 'external_write'
        ? trace.events
            .filter(
              (other) =>
                other.eventId !== event.eventId &&
                other.endMs <= event.startMs &&
                [...other.reads, ...other.writes].some((ref) =>
                  touched.includes(`${ref.system}/${ref.key}`),
                ),
            )
            .map((other) => other.eventId)
            .sort()
        : [];
    const reason = unsupportedReason(event.operation, event.status, event.effect, event.args);
    return {
      eventId: event.eventId,
      operation: event.operation,
      adapterId: event.adapterId,
      adapterVersion: event.adapterVersion,
      status: event.status,
      effect: event.effect,
      args: event.args,
      dataDeps,
      effectDeps,
      supported: !reason,
      reason,
    };
  });
  for (const node of nodes) {
    for (const dep of node.dataDeps) {
      const producer = byId.get(dep);
      if (!producer) throw new DomainError(`Unknown data dependency ${dep}.`, 409);
      if (producer.status !== 'success')
        throw new DomainError(`Event ${node.eventId} consumes a value from a failed event.`, 409);
    }
  }
  detectCycle(nodes);
  const consumed = new Set(nodes.filter((node) => node.supported).flatMap((node) => node.dataDeps));
  return {
    traceId: trace.traceId,
    taskKind: trace.taskKind,
    taskInput: trace.taskInput,
    nodes,
    terminalIds: nodes
      .filter((node) => node.supported && !consumed.has(node.eventId))
      .map((node) => node.eventId),
  };
}

function unsupportedReason(
  operation: string,
  status: string,
  effect: string,
  args: Record<string, ArgExpr>,
): string | undefined {
  if (status !== 'success') return `${status}_event`;
  if (!(operation in contracts)) return 'operation_without_contract';
  const contract = contracts[operation as keyof typeof contracts];
  if (effect !== 'read') return 'effect_outside_read_only_compiler';
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'customerId') return 'argument_shape_unsupported';
  return contract ? undefined : 'operation_without_contract';
}

function detectCycle(nodes: ProvenanceNode[]) {
  const pending = new Map(
    nodes.map((node) => [node.eventId, [...node.dataDeps, ...node.effectDeps]]),
  );
  const done = new Set<string>();
  while (done.size < nodes.length) {
    const ready = [...pending].filter(
      ([id, deps]) => !done.has(id) && deps.every((dep) => done.has(dep) || !pending.has(dep)),
    );
    if (!ready.length) throw new DomainError('Cyclic trace dependencies.', 409);
    ready.forEach(([id]) => done.add(id));
  }
}
