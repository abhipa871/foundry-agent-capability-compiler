import { z } from 'zod';
import { DomainError } from '../domain.js';
import { operationSchema, type CapabilityIR, type ReadOperation } from '../compiler/ir.js';
import { contracts } from './adapters/registry.js';

const canonicalOrder = operationSchema.options;
export const resourceSelectionSchema = z
  .array(operationSchema)
  .min(1)
  .max(canonicalOrder.length)
  .refine((value) => new Set(value).size === value.length, 'Duplicate resource.')
  .transform((value) => canonicalOrder.filter((operation) => value.includes(operation)));
export const resourceKeys = {
  'crm.getCustomer': 'crm_get_customer',
  'orders.list': 'orders_list',
  'payments.refundHistory': 'payments_refund_history',
} as const satisfies Record<ReadOperation, string>;

export type SelectionPlan = {
  resources: ReadOperation[];
  prerequisites: ReadOperation[];
  nodeIds: string[];
  rootIds: Partial<Record<ReadOperation, string>>;
};

// The executable part of an approved plan for a requested subset: each requested read node and
// every read it transitively depends on, exactly as approved. Nothing is added or rewritten.
export function planSelection(ir: CapabilityIR, raw: readonly ReadOperation[]): SelectionPlan {
  const resources = resourceSelectionSchema.parse(raw);
  const byId = new Map(ir.nodes.map((node) => [node.id, node]));
  const join = byId.get(ir.outputNode);
  if (join?.opcode !== 'join') throw new DomainError('Capability has no output join.', 409);
  const rootIds: SelectionPlan['rootIds'] = {};
  for (const operation of resources) {
    const matches = ir.nodes.filter(
      (node) => node.opcode === 'adapter.read' && node.operation === operation,
    );
    if (matches.length !== 1)
      throw new DomainError(`Capability does not produce exactly one ${operation} read.`, 409);
    if (
      !Object.values(join.args).some(
        (expr) => expr.kind === 'ref' && expr.node === matches[0].id && expr.path === '',
      )
    )
      throw new DomainError(`Capability does not output ${operation}.`, 409);
    rootIds[operation] = matches[0].id;
  }
  const closure = new Set<string>();
  const visit = (id: string) => {
    if (closure.has(id)) return;
    const node = byId.get(id);
    if (node?.opcode !== 'adapter.read')
      throw new DomainError('Selected reads may depend only on reads.', 409);
    closure.add(id);
    node.deps.forEach(visit);
  };
  Object.values(rootIds).forEach(visit);
  const executed = ir.nodes.flatMap((node) =>
    closure.has(node.id) && node.opcode === 'adapter.read' ? [node.operation] : [],
  );
  return {
    resources,
    prerequisites: canonicalOrder.filter(
      (operation) => executed.includes(operation) && !resources.includes(operation),
    ),
    nodeIds: ir.nodes.filter((node) => closure.has(node.id)).map((node) => node.id),
    rootIds,
  };
}

export type SubsetContext = { customer_id: string } & Partial<
  Record<(typeof resourceKeys)[ReadOperation], unknown>
>;

// Strict: exactly the requested resources, no prerequisite or unrequested values.
export function subsetContextProjection(
  raw: unknown,
  requested: readonly ReadOperation[],
): SubsetContext {
  const resources = resourceSelectionSchema.parse(requested);
  const parsed = z
    .object({
      customer_id: z.string().regex(/^C-\d{3}$/),
      ...Object.fromEntries(
        resources.map((operation) => [resourceKeys[operation], contracts[operation].output]),
      ),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success) throw new DomainError('Output does not satisfy the requested subset.', 409);
  const value = parsed.data as Record<string, unknown> & { customer_id: string };
  const parts = resources.map(
    (operation) =>
      value[resourceKeys[operation]] as {
        customerId: string;
        tenantId: string;
        snapshot: string;
        orders?: { id: string }[];
        refunds?: { id: string }[];
      },
  );
  if (
    parts.some(
      (part) =>
        part.customerId !== value.customer_id ||
        part.tenantId !== parts[0].tenantId ||
        part.snapshot !== parts[0].snapshot,
    )
  )
    throw new DomainError('Context identity mismatch.', 409);
  for (const part of parts) {
    const items = part.orders ?? part.refunds;
    if (items && new Set(items.map((item) => item.id)).size !== items.length)
      throw new DomainError('Duplicate context resource identity.', 409);
  }
  const sorted = (items: { id: string }[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => [
      key,
      key === 'orders_list'
        ? { ...(part as object), orders: sorted((part as { orders: { id: string }[] }).orders) }
        : key === 'payments_refund_history'
          ? {
              ...(part as object),
              refunds: sorted((part as { refunds: { id: string }[] }).refunds),
            }
          : part,
    ]),
  ) as SubsetContext;
}
