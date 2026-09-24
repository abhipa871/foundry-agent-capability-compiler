import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '../../domain.js';
import { customerInput, type ReadOperation } from '../../compiler/ir.js';

const common = {
  customerId: z.string(),
  tenantId: z.literal('local-demo'),
  snapshot: z.literal('fixtures-v1'),
};
export const contracts = {
  'crm.getCustomer': {
    version: '1',
    scope: 'crm:read',
    schemaId: 'customer.v1',
    output: z.object({ ...common, eligible: z.boolean() }).strict(),
  },
  'orders.list': {
    version: '1',
    scope: 'orders:read',
    schemaId: 'orders.v1',
    output: z
      .object({
        ...common,
        orders: z.array(
          z.object({ id: z.string(), daysLate: z.number().int().nonnegative() }).strict(),
        ),
      })
      .strict(),
  },
  'payments.refundHistory': {
    version: '1',
    scope: 'payments:read',
    schemaId: 'refunds.v1',
    output: z
      .object({
        ...common,
        refunds: z.array(z.object({ id: z.string(), amount: z.number().nonnegative() }).strict()),
      })
      .strict(),
  },
} as const;
export type RuntimeContext = {
  tenantId: string;
  principalId: string;
  scopes: string[];
  policyVersion: string;
  adapterVersions: Record<ReadOperation, string>;
  snapshot: string;
  observedAt: number;
};
export const localContext = (): RuntimeContext => ({
  tenantId: 'local-demo',
  principalId: 'local-operator',
  scopes: Object.values(contracts).map((c) => c.scope),
  policyVersion: 'read-policy-v1',
  adapterVersions: { 'crm.getCustomer': '1', 'orders.list': '1', 'payments.refundHistory': '1' },
  snapshot: 'fixtures-v1',
  observedAt: Date.now(),
});
export function fixtureResult(operation: ReadOperation, customerId: string): unknown {
  customerInput.parse({ customerId });
  if (!['C-101', 'C-202', 'C-303'].includes(customerId))
    throw new DomainError('Customer outside supported fixture domain.', 409);
  const base = { customerId, tenantId: 'local-demo', snapshot: 'fixtures-v1' };
  if (operation === 'crm.getCustomer') return { ...base, eligible: customerId !== 'C-303' };
  if (operation === 'orders.list')
    return {
      ...base,
      orders:
        customerId === 'C-101'
          ? [{ id: 'O-101', daysLate: 8 }]
          : [
              { id: `O-${customerId.slice(2)}`, daysLate: 3 },
              { id: 'O-extra', daysLate: 6 },
            ],
    };
  return { ...base, refunds: customerId === 'C-202' ? [{ id: 'R-202', amount: 5 }] : [] };
}
export type AdapterRunner = (
  operation: ReadOperation,
  args: { customerId: string },
  context: RuntimeContext,
  signal: AbortSignal,
) => Promise<unknown>;
export type AdapterFault = 'none' | 'timeout' | 'wrong_customer' | 'wrong_snapshot' | 'malformed';
export function mockAdapters(
  options: {
    delayMs?: number;
    fault?: AdapterFault;
    faultOperation?: ReadOperation;
    onCall?: (operation: ReadOperation) => void;
  } = {},
): AdapterRunner {
  return async (operation, args, context, signal) => {
    if (context.tenantId !== 'local-demo' || !context.scopes.includes(contracts[operation].scope))
      throw new DomainError('Adapter permission denied.', 403);
    if (context.adapterVersions[operation] !== contracts[operation].version)
      throw new DomainError('Adapter drift.', 409);
    options.onCall?.(operation);
    const fault =
      !options.faultOperation || options.faultOperation === operation ? options.fault : 'none';
    await delay(fault === 'timeout' ? 10000 : (options.delayMs ?? 2), undefined, { signal });
    const result = fixtureResult(operation, args.customerId) as Record<string, unknown>;
    if (fault === 'malformed') return { invalid: true };
    if (fault === 'wrong_customer') result.customerId = 'C-999';
    if (fault === 'wrong_snapshot') result.snapshot = 'wrong';
    return result;
  };
}
