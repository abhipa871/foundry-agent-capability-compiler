import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { authorizeReads, type RuntimeContext } from '../runtime/adapters/registry.js';
import type { ReadOperation } from '../compiler/ir.js';

const reads = ['crm.getCustomer', 'orders.list', 'payments.refundHistory'] as const;
const schema = z
  .object({
    requirement: z.enum(['known', 'agent_decides']),
    reads: z.array(z.enum(reads)).max(3),
  })
  .strict();
const registered = new WeakSet<object>();
declare const validated: unique symbol;
export type ContextContract = Readonly<z.infer<typeof schema>> & { readonly [validated]: true };

// Register application-owned metadata in code. JSON supplied by a user/model is not a trusted
// contract. The schema validates shape; the application is responsible for its task semantics.
export function defineContextContract(raw: z.input<typeof schema>): ContextContract {
  const value = schema.parse(raw);
  if (new Set(value.reads).size !== value.reads.length) throw new Error('Duplicate contract read.');
  Object.freeze(value.reads);
  Object.freeze(value);
  registered.add(value);
  return value as ContextContract;
}
export type ExecutionSelection = {
  mode: 'normal' | 'compiled_tool' | 'compiled_prefetch' | 'denied';
  reason: string;
  durationMs: number;
};
export function selectExecution(
  contract: ContextContract,
  input: unknown,
  context: RuntimeContext,
): ExecutionSelection {
  const began = performance.now();
  const result = (mode: ExecutionSelection['mode'], reason: string) => ({
    mode,
    reason,
    durationMs: performance.now() - began,
  });
  if (!registered.has(contract)) return result('normal', 'untrusted_task_metadata');
  try {
    authorizeReads(context, input, contract.reads);
  } catch {
    return result('denied', 'task_authorization_denied');
  }
  const complete = reads.every((read) => contract.reads.includes(read));
  if (!contract.reads.length) return result('normal', 'contract_requires_no_customer_reads');
  if (!complete) return result('normal', 'compiled_region_exceeds_contract_reads');
  if (contract.requirement === 'agent_decides')
    return result('compiled_tool', 'agent_must_decide_whether_context_is_needed');
  return result('compiled_prefetch', 'trusted_contract_requires_complete_context');
}
export type { ReadOperation };
