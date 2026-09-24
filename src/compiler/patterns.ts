import { DomainError } from '../domain.js';
import type { ProvenanceGraph, ProvenanceNode } from '../exploration/provenance.js';
import { canonical, type ReadOperation } from './ir.js';

export type CanonicalArg =
  | { source: 'task_input'; key: 'customerId' }
  | { source: 'event_output'; producerKey: string; outputPath: 'customerId' }
  | { source: 'literal' };
export type PatternNode = {
  key: string;
  operation: ReadOperation;
  args: Record<string, CanonicalArg>;
  deps: string[];
  occurrences: { traceId: string; eventIds: string[] }[];
};
export type PatternMatch = {
  signature: string;
  support: number;
  traceIds: string[];
  nodes: PatternNode[];
  duplicates: { key: string; traceId: string; eventIds: string[] }[];
  divergentTraceIds: string[];
};

// MVP pattern discovery: a normalized subgraph signature built from opcode, adapter operation,
// argument provenance shape, and dependency topology. Two traces must agree on that signature
// before anything is compiled. This is exact typed matching, not general frequent-subgraph mining.
export function nodeKey(
  node: ProvenanceNode,
  graph: ProvenanceGraph,
  seen = new Set<string>(),
): string {
  if (seen.has(node.eventId)) throw new DomainError('Cyclic trace dependency while keying.', 409);
  seen.add(node.eventId);
  const args = Object.entries(node.args)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, arg]) => {
      if (arg.source === 'task_input') return `${name}=input:${arg.key}`;
      if (arg.source === 'literal') return `${name}=literal`;
      const producer = graph.nodes.find((n) => n.eventId === arg.ref.producerEventId)!;
      return `${name}=${nodeKey(producer, graph, new Set(seen))}.${arg.ref.outputPath}`;
    });
  return `${node.operation}(${args.join(',')})`;
}

export function canonicalNodes(graph: ProvenanceGraph): PatternNode[] {
  const supported = graph.nodes.filter((node) => node.supported);
  const grouped = new Map<string, PatternNode>();
  for (const node of supported) {
    const key = nodeKey(node, graph);
    const args = Object.fromEntries(
      Object.entries(node.args).map(([name, arg]): [string, CanonicalArg] => {
        if (arg.source === 'task_input') return [name, { source: 'task_input', key: arg.key }];
        if (arg.source === 'literal') return [name, { source: 'literal' }];
        const producer = graph.nodes.find((n) => n.eventId === arg.ref.producerEventId)!;
        return [
          name,
          {
            source: 'event_output',
            producerKey: nodeKey(producer, graph),
            outputPath: arg.ref.outputPath,
          },
        ];
      }),
    );
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences[0].eventIds.push(node.eventId);
      continue;
    }
    grouped.set(key, {
      key,
      operation: node.operation as ReadOperation,
      args,
      deps: [
        ...new Set(
          Object.values(args).flatMap((arg) =>
            arg.source === 'event_output' ? [arg.producerKey] : [],
          ),
        ),
      ].sort(),
      occurrences: [{ traceId: graph.traceId, eventIds: [node.eventId] }],
    });
  }
  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function signatureOf(nodes: PatternNode[]): string {
  return canonical(nodes.map((node) => ({ key: node.key, deps: node.deps })));
}

export function minePattern(graphs: ProvenanceGraph[]): PatternMatch {
  if (graphs.length < 2)
    throw new DomainError('Compilation needs at least two structured traces as evidence.', 409);
  const perTrace = graphs.map((graph) => {
    const nodes = canonicalNodes(graph);
    if (!nodes.length) throw new DomainError(`Trace ${graph.traceId} has no supported reads.`, 409);
    return { graph, nodes, signature: signatureOf(nodes) };
  });
  const groups = new Map<string, typeof perTrace>();
  for (const entry of perTrace)
    groups.set(entry.signature, [...(groups.get(entry.signature) ?? []), entry]);
  const [signature, group] = [...groups].sort((a, b) => b[1].length - a[1].length)[0];
  if (group.length < 2)
    throw new DomainError(
      'No reusable subgraph: the traces do not share a normalized structure.',
      409,
    );
  const merged = new Map<string, PatternNode>();
  for (const entry of group) {
    for (const node of entry.nodes) {
      const existing = merged.get(node.key);
      if (!existing) {
        merged.set(node.key, { ...node, occurrences: [...node.occurrences] });
        continue;
      }
      existing.occurrences.push(...node.occurrences);
    }
  }
  const nodes = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {
    signature,
    support: group.length,
    traceIds: group.map((entry) => entry.graph.traceId),
    nodes,
    duplicates: nodes.flatMap((node) =>
      node.occurrences
        .filter((occurrence) => occurrence.eventIds.length > 1)
        .map((occurrence) => ({ key: node.key, ...occurrence })),
    ),
    divergentTraceIds: perTrace
      .filter((entry) => entry.signature !== signature)
      .map((entry) => entry.graph.traceId),
  };
}
