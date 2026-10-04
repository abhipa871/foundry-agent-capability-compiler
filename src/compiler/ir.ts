import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Check } from '../domain.js';
import { tenantIdSchema } from '../security/identity.js';

export const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v));
export const customerInput = z.object({ customerId: z.string().regex(/^C-\d{3}$/) }).strict();
export type CustomerInput = z.infer<typeof customerInput>;
export const expressionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), key: z.literal('customerId') }).strict(),
  z.object({ kind: z.literal('ref'), node: identifier, path: z.enum(['', 'customerId']) }).strict(),
  z.object({ kind: z.literal('literal'), value: z.string().max(100) }).strict(),
]);
export type Expression = z.infer<typeof expressionSchema>;
export const operationSchema = z.enum(['crm.getCustomer', 'orders.list', 'payments.refundHistory']);
export type ReadOperation = z.infer<typeof operationSchema>;
export const nodeSchema = z.discriminatedUnion('opcode', [
  z
    .object({
      id: identifier,
      opcode: z.literal('adapter.read'),
      operation: operationSchema,
      args: z.object({ customerId: expressionSchema }).strict(),
      deps: z.array(identifier).max(32),
      effect: z.literal('read'),
      requiredScopes: z.array(z.string()).max(3),
      outputSchemaId: z.string(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      opcode: z.literal('join'),
      args: z.record(identifier, expressionSchema),
      deps: z.array(identifier).max(32),
      effect: z.literal('pure'),
      requiredScopes: z.array(z.string()).length(0),
      outputSchemaId: z.literal('context.v1'),
    })
    .strict(),
]);
export type IRNode = z.infer<typeof nodeSchema>;
export const irSchema = z
  .object({
    name: identifier,
    taskKind: identifier,
    compilerVersion: z.literal('read-ir-v1'),
    inputsSchemaId: z.literal('customer_input.v1'),
    outputsSchemaId: z.literal('context.v1'),
    nodes: z.array(nodeSchema).min(2).max(33),
    outputNode: identifier,
    adapterVersions: z.partialRecord(operationSchema, z.string()),
    policyVersion: z.literal('read-policy-v1'),
    guards: z
      .object({
        tenantId: tenantIdSchema,
        principalId: z.string().max(80).optional(),
        snapshot: z.literal('fixtures-v1'),
        maxAgeMs: z.number().int().min(1).max(60000),
      })
      .strict(),
    requiredScopes: z.array(z.string()).max(3),
    concurrency: z.number().int().min(1).max(3),
    timeoutMs: z.number().int().min(5).max(5000),
    invariants: z.tuple([
      z.literal('customer_id_matches'),
      z.literal('tenant_matches'),
      z.literal('snapshot_matches'),
    ]),
    provenance: z
      .object({
        traceIds: z.array(z.string().uuid()).min(2),
        eventIds: z.array(z.string().uuid()).min(2),
        exceptionEventIds: z.array(z.string().uuid()),
      })
      .strict(),
    optimizations: z.array(z.string().max(160)).max(64),
  })
  .strict();
export type CapabilityIR = z.infer<typeof irSchema>;

// What the compiler observed while building the IR. Persisted with the artifact so a reviewer can
// see the evidence (support count, pruned branches, applied passes) instead of trusting the output.
export type CompileReport = {
  taskKind: string;
  signature: string;
  supportingTraceIds: string[];
  parameters: { arg: string; binding: 'input' | 'literal' | 'ref'; evidence: string }[];
  optimizations: string[];
  prunedEvents: { eventId: string; operation: string; reason: string; detail: string }[];
  rejectedNodes: { operation: string; reason: string }[];
};
export type IRArtifact = {
  id: string;
  name: string;
  version: number;
  taskKind: string;
  createdAt: string;
  status: 'draft' | 'verified' | 'approved' | 'revoked';
  ir: CapabilityIR;
  digest: string;
  report: CompileReport;
  checks: Check[];
  verifiedDigest?: string;
  approvedDigest?: string;
  verifiedAt?: string;
  approvedAt?: string;
  reviewNote?: string;
  revision?: number;
  validationVersion?: string;
  patternId?: string;
  measurementOrigin?: 'observed' | 'fixture' | 'estimated';
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function irDigest(ir: CapabilityIR): string {
  return createHash('sha256').update(canonical(ir)).digest('hex');
}
export function references(args: Record<string, Expression>): string[] {
  return [
    ...new Set(Object.values(args).flatMap((arg) => (arg.kind === 'ref' ? [arg.node] : []))),
  ].sort();
}
export function resolveExpression(
  expr: Expression,
  input: CustomerInput,
  values: Map<string, unknown>,
): unknown {
  if (expr.kind === 'input') return input[expr.key];
  if (expr.kind === 'literal') return expr.value;
  if (!values.has(expr.node)) throw new DomainError(`Missing dependency: ${expr.node}`, 409);
  const value = values.get(expr.node);
  if (!expr.path) return value;
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, expr.path))
    throw new DomainError('Invalid result reference.', 409);
  return (value as Record<string, unknown>)[expr.path];
}

export function validateIR(value: unknown): CapabilityIR {
  const ir = irSchema.parse(value);
  const ids = new Set(ir.nodes.map((n) => n.id));
  if (ids.size !== ir.nodes.length) throw new DomainError('Duplicate IR node ID.', 409);
  const join = ir.nodes.find((n) => n.id === ir.outputNode);
  if (
    !join ||
    join.opcode !== 'join' ||
    !Object.keys(join.args).length ||
    ir.nodes.filter((n) => n.opcode === 'join').length !== 1
  )
    throw new DomainError('IR requires exactly one nonempty output join.', 409);
  for (const node of ir.nodes) {
    if (canonical([...node.deps].sort()) !== canonical(references(node.args)))
      throw new DomainError('Dependencies must match explicit value references.', 409);
    if (node.deps.some((id) => !ids.has(id) || id === node.id))
      throw new DomainError('Invalid dependency.', 409);
    if (node.opcode === 'adapter.read' && !ir.adapterVersions[node.operation])
      throw new DomainError(`IR is missing a pinned adapter version for ${node.operation}.`, 409);
    if (node.requiredScopes.some((scope) => !ir.requiredScopes.includes(scope)))
      throw new DomainError('Node scope is outside the capability scope set.', 409);
  }
  const done = new Set<string>();
  while (done.size < ir.nodes.length) {
    const ready = ir.nodes.filter((n) => !done.has(n.id) && n.deps.every((id) => done.has(id)));
    if (!ready.length) throw new DomainError('Cyclic IR dependencies.', 409);
    ready.forEach((n) => done.add(n.id));
  }
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    ir.nodes.find((n) => n.id === id)!.deps.forEach(visit);
  };
  visit(ir.outputNode);
  if (reachable.size !== ir.nodes.length)
    throw new DomainError('Unreachable IR nodes are not executable.', 409);
  return ir;
}
