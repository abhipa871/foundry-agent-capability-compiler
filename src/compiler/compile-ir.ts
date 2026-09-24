import { DomainError } from '../domain.js';
import { buildProvenance, type ProvenanceGraph } from '../exploration/provenance.js';
import type { StoredToolTrace } from '../exploration/tool-events.js';
import { contracts } from '../runtime/adapters/registry.js';
import {
  references,
  validateIR,
  type CapabilityIR,
  type CompileReport,
  type Expression,
  type IRNode,
} from './ir.js';
import { bindNode } from './parameterize.js';
import { minePattern, type PatternNode } from './patterns.js';
import { dedupeReads } from './passes/dedupe-reads.js';
import { prune } from './passes/prune.js';
import { schedule } from './passes/schedule.js';

type ReadNode = Extract<IRNode, { opcode: 'adapter.read' }>;
export type CompileOptions = {
  freshnessMs?: number;
  maxAgeMs?: number;
  timeoutMs?: number;
  maxConcurrency?: number;
};
export type CompileResult = {
  ir: CapabilityIR;
  report: CompileReport;
  graphs: ProvenanceGraph[];
};

export function compileIR(traces: StoredToolTrace[], options: CompileOptions = {}): CompileResult {
  const freshnessMs = options.freshnessMs ?? 1000;
  if (traces.length < 2)
    throw new DomainError('Compilation needs at least two structured traces as evidence.', 409);
  const [first] = traces;
  for (const trace of traces) {
    if (trace.taskKind !== first.taskKind)
      throw new DomainError('Traces belong to different task kinds.', 409);
    if (trace.tenantId !== first.tenantId || trace.snapshot !== first.snapshot)
      throw new DomainError('Traces span different tenants or data snapshots.', 409);
    if (trace.policyVersion !== first.policyVersion)
      throw new DomainError('Traces were captured under different policy versions.', 409);
    if (trace.status !== 'success')
      throw new DomainError('Only successful traces are compilation evidence.', 409);
  }
  const graphs = traces.map(buildProvenance);
  const pruned = prune(graphs);
  const match = minePattern(graphs);
  const byId = new Map(traces.map((trace) => [trace.traceId, trace]));
  const dedupe = dedupeReads(match, byId, freshnessMs);
  const ids = assignIds(match.nodes);
  const idFor = (key: string) => {
    const id = ids.get(key);
    if (!id) throw new DomainError(`Unresolved dependency key ${key}.`, 409);
    return id;
  };
  const parameters: CompileReport['parameters'] = [];
  const readNodes: ReadNode[] = match.nodes.map((node) => {
    const contract = contracts[node.operation];
    const bindings = bindNode(node, { idFor, traces: byId });
    const args = Object.fromEntries(
      bindings.map((binding) => [binding.arg, binding.expression]),
    ) as { customerId: Expression };
    if (!args.customerId)
      throw new DomainError(`${node.operation} has no customerId binding.`, 409);
    parameters.push(
      ...bindings.map((binding) => ({
        arg: `${idFor(node.key)}.${binding.arg}`,
        binding: binding.binding,
        evidence: binding.evidence,
      })),
    );
    return {
      id: idFor(node.key),
      opcode: 'adapter.read',
      operation: node.operation,
      args,
      deps: references(args),
      effect: 'read',
      requiredScopes: [contract.scope],
      outputSchemaId: contract.schemaId,
    };
  });
  const anchor = readNodes.find((node) => node.deps.length === 0);
  if (!anchor) throw new DomainError('No parameterized entry read; plan is not executable.', 409);
  const joinArgs: Record<string, Expression> = Object.fromEntries([
    ...readNodes.map((node) => [node.id, { kind: 'ref', node: node.id, path: '' } as Expression]),
    ['customer_id', { kind: 'ref', node: anchor.id, path: 'customerId' } as Expression],
  ]);
  const join: IRNode = {
    id: 'context',
    opcode: 'join',
    args: joinArgs,
    deps: references(joinArgs),
    effect: 'pure',
    requiredScopes: [],
    outputSchemaId: 'context.v1',
  };
  const nodes = [...readNodes, join];
  const scheduled = schedule(
    nodes.map((node) => ({ id: node.id, deps: node.deps })),
    options.maxConcurrency ?? 3,
  );
  const supporting = new Set(match.traceIds);
  const keptEventIds = pruned.keptEventIds.filter((eventId) =>
    graphs.some(
      (graph) =>
        supporting.has(graph.traceId) && graph.nodes.some((node) => node.eventId === eventId),
    ),
  );
  const ir: CapabilityIR = {
    name: 'load_customer_context',
    taskKind: first.taskKind,
    compilerVersion: 'read-ir-v1',
    inputsSchemaId: 'customer_input.v1',
    outputsSchemaId: 'context.v1',
    nodes,
    outputNode: join.id,
    adapterVersions: Object.fromEntries(
      readNodes.map((node) => [node.operation, contracts[node.operation].version]),
    ),
    policyVersion: 'read-policy-v1',
    guards: {
      tenantId: 'local-demo',
      snapshot: 'fixtures-v1',
      maxAgeMs: options.maxAgeMs ?? 30000,
    },
    requiredScopes: [...new Set(readNodes.flatMap((node) => node.requiredScopes))].sort(),
    concurrency: scheduled.concurrency,
    timeoutMs: options.timeoutMs ?? 2000,
    invariants: ['customer_id_matches', 'tenant_matches', 'snapshot_matches'],
    provenance: {
      traceIds: match.traceIds,
      eventIds: keptEventIds,
      exceptionEventIds: pruned.pruned.map((event) => event.eventId),
    },
    optimizations: [
      `extracted ${parameters.filter((p) => p.binding === 'input').length} caller parameter(s) from ${match.support} traces`,
      ...pruned.optimizations,
      ...dedupe.optimizations,
      ...scheduled.optimizations,
    ],
  };
  const report: CompileReport = {
    taskKind: first.taskKind,
    signature: match.signature,
    supportingTraceIds: match.traceIds,
    parameters,
    optimizations: ir.optimizations,
    prunedEvents: pruned.pruned,
    rejectedNodes: match.divergentTraceIds.map((traceId) => ({
      operation: traceId,
      reason: 'trace signature diverged from the compiled subgraph',
    })),
  };
  return { ir: validateIR(ir), report, graphs };
}

function assignIds(nodes: PatternNode[]): Map<string, string> {
  const used = new Set<string>(['context']);
  return new Map(
    nodes.map((node) => {
      const base = node.operation
        .replace(/\./g, '_')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
      let id = base;
      let suffix = 2;
      while (used.has(id)) id = `${base}_${suffix++}`;
      used.add(id);
      return [node.key, id];
    }),
  );
}
