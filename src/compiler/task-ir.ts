import { z } from 'zod';
import { DomainError } from '../domain.js';
import {
  contractId,
  digest,
  json,
  replayJson,
  stable,
  type Json,
  type ContractRegistry,
} from './contracts.js';

const path = z
  .array(
    z
      .string()
      .min(1)
      .max(96)
      .refine((key) => !['__proto__', 'prototype', 'constructor'].includes(key)),
  )
  .max(16);
export type Binding =
  | { source: 'input'; path: string[] }
  | { source: 'ref'; node: string; path: string[] }
  | { source: 'literal'; value: Json };
export const bindingSchema: z.ZodType<Binding> = z.discriminatedUnion('source', [
  z.object({ source: z.literal('input'), path }).strict(),
  z.object({ source: z.literal('ref'), node: contractId, path }).strict(),
  z.object({ source: z.literal('literal'), value: z.unknown().transform(json) }).strict(),
]);
export const taskNodeSchema = z
  .object({
    id: contractId,
    tool: contractId,
    args: z.record(z.string().min(1).max(96), bindingSchema),
    contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type TaskNode = z.infer<typeof taskNodeSchema>;
export const taskPlanSchema = z
  .object({
    format: z.literal('foundry-task-ir-v1'),
    compilerVersion: z.literal('task-ir-v1'),
    name: contractId,
    kind: contractId,
    taskDigest: z.string().regex(/^[a-f0-9]{64}$/),
    tenantId: z.string().min(1).max(80),
    principalId: z.string().min(1).max(80),
    policyVersion: z.string().min(1).max(80),
    snapshot: z.string().min(1).max(128),
    nodes: z.array(taskNodeSchema).min(1).max(64),
    output: z.record(z.string().min(1).max(96), bindingSchema),
    evidence: z.array(z.string().uuid()).min(2).max(32),
  })
  .strict();
export type TaskPlan = z.infer<typeof taskPlanSchema>;

export function at(value: unknown, keys: string[]): Json {
  let cursor = value;
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, key))
      throw new DomainError('Binding path is unavailable.', 409);
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return json(cursor);
}
export function resolve(binding: Binding, input: Json, values: Map<string, Json>): Json {
  if (binding.source === 'literal') return json(binding.value);
  if (binding.source === 'input') return at(input, binding.path);
  if (!values.has(binding.node)) throw new DomainError('Binding dependency is unavailable.', 409);
  return at(values.get(binding.node), binding.path);
}
export function materialize(
  bindings: Record<string, Binding>,
  input: Json,
  values: Map<string, Json>,
): Json {
  return json(
    Object.fromEntries(
      Object.entries(bindings).map(([key, binding]) => [key, resolve(binding, input, values)]),
    ),
  );
}
export const dependencies = (node: TaskNode) =>
  [
    ...new Set(
      Object.values(node.args).flatMap((binding) =>
        binding.source === 'ref' ? [binding.node] : [],
      ),
    ),
  ].sort();
export function levels(plan: TaskPlan): TaskNode[][] {
  const done = new Set<string>();
  const result: TaskNode[][] = [];
  while (done.size < plan.nodes.length) {
    const ready = plan.nodes
      .filter((node) => !done.has(node.id) && dependencies(node).every((id) => done.has(id)))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) throw new DomainError('Cyclic or missing plan dependency.', 409);
    result.push(ready);
    ready.forEach((node) => done.add(node.id));
  }
  return result;
}
export function validateTaskPlan(raw: unknown, registry: ContractRegistry): TaskPlan {
  const plan = taskPlanSchema.parse(json(raw));
  const task = registry.task(plan.kind);
  if (plan.taskDigest !== digest(registry.taskManifest(plan.kind)))
    throw new DomainError('Task contract changed.', 409);
  const ids = new Set(plan.nodes.map((node) => node.id));
  if (new Set(plan.nodes.flatMap((node) => registry.tool(node.tool).scopes)).size > 256)
    throw new DomainError('Plan scope budget exceeded.', 409);
  if (ids.size !== plan.nodes.length || new Set(plan.evidence).size !== plan.evidence.length)
    throw new DomainError('Duplicate node or evidence ID.', 409);
  for (const node of plan.nodes) {
    if (!registry.toolManifest(node.tool).replaySafe)
      throw new DomainError('Tool is not approved for replay evidence.', 409);
    if (!task.tools.includes(node.tool))
      throw new DomainError('Plan tool is outside task contract.', 403);
    if (node.contractDigest !== digest(registry.toolManifest(node.tool)))
      throw new DomainError('Tool contract changed.', 409);
    if (dependencies(node).some((id) => !ids.has(id) || id === node.id))
      throw new DomainError('Invalid dependency.', 409);
  }
  if (!Object.keys(plan.output).length)
    throw new DomainError('An output projection is required.', 409);
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    const node = plan.nodes.find((entry) => entry.id === id);
    if (!node) throw new DomainError('Unknown output dependency.', 409);
    reachable.add(id);
    dependencies(node).forEach(visit);
  };
  Object.values(plan.output).forEach((binding) => {
    if (binding.source === 'ref') visit(binding.node);
  });
  if (reachable.size !== plan.nodes.length) throw new DomainError('Unreachable plan nodes.', 409);
  levels(plan);
  return plan;
}

export const traceEventSchema = taskNodeSchema
  .extend({
    argsValue: z.unknown().transform(json),
    result: z.unknown().transform(json),
  })
  .strict();
export const taskTraceSchema = z
  .object({
    id: z.string().uuid(),
    kind: contractId,
    taskDigest: z.string().regex(/^[a-f0-9]{64}$/),
    tenantId: z.string().min(1).max(80),
    principalId: z.string().min(1).max(80),
    policyVersion: z.string().min(1).max(80),
    snapshot: z.string().min(1).max(128),
    input: z.unknown().transform(json),
    events: z.array(traceEventSchema).min(1).max(64),
    output: z.record(z.string().min(1).max(96), bindingSchema),
    result: z.unknown().transform(json),
  })
  .strict();
export type TaskTrace = z.infer<typeof taskTraceSchema>;

export function compileTask(
  rawTraces: unknown[],
  name: string,
  registry: ContractRegistry,
): TaskPlan {
  if (rawTraces.length < 2 || rawTraces.length > 32)
    throw new DomainError('Two to 32 traces required.', 409);
  const traces = rawTraces.map((trace) => taskTraceSchema.parse(replayJson(trace)));
  const first = traces[0];
  const shape = (trace: TaskTrace) =>
    stable({
      kind: trace.kind,
      taskDigest: trace.taskDigest,
      tenantId: trace.tenantId,
      principalId: trace.principalId,
      policyVersion: trace.policyVersion,
      snapshot: trace.snapshot,
      nodes: trace.events
        .map(({ argsValue: _argsValue, result: _result, ...node }) => node)
        .sort((a, b) => a.id.localeCompare(b.id)),
      output: trace.output,
    });
  if (new Set(traces.map((trace) => stable(trace.input))).size < 2)
    throw new DomainError('Evidence must cover at least two distinct task inputs.', 409);
  if (traces.some((trace) => shape(trace) !== shape(first)))
    throw new DomainError(
      'Evidence does not agree on provenance, contracts, or access context.',
      409,
    );
  const plan = validateTaskPlan(
    {
      format: 'foundry-task-ir-v1',
      compilerVersion: 'task-ir-v1',
      name,
      kind: first.kind,
      taskDigest: first.taskDigest,
      tenantId: first.tenantId,
      principalId: first.principalId,
      policyVersion: first.policyVersion,
      snapshot: first.snapshot,
      nodes: first.events.map(({ argsValue: _argsValue, result: _result, ...node }) => node),
      output: first.output,
      evidence: traces.map((trace) => trace.id),
    },
    registry,
  );
  for (const trace of traces) {
    const input = json(registry.task(trace.kind).input.parse(trace.input));
    const values = new Map<string, Json>();
    for (const batch of levels(plan))
      for (const node of batch) {
        const event = trace.events.find((entry) => entry.id === node.id)!;
        const tool = registry.tool(node.tool);
        const args = materialize(node.args, input, values);
        tool.input.parse(args);
        if (stable(args) !== stable(event.argsValue))
          throw new DomainError('Argument provenance mismatch.', 409);
        values.set(node.id, json(tool.output.parse(event.result)));
      }
    const result = materialize(plan.output, input, values);
    registry.task(trace.kind).output.parse(result);
    if (stable(result) !== stable(trace.result))
      throw new DomainError('Observable evidence mismatch.', 409);
  }
  return plan;
}
