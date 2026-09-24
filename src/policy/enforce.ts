import { DomainError, scopes, type Policy, type Shipment, type WorkflowInput } from '../domain.js';

export function authorize(policy: Policy, input: WorkflowInput, shipments: Shipment[]) {
  const missing = scopes.filter((scope) => !policy.scopes.includes(scope));
  if (missing.length) throw new DomainError(`Missing permissions: ${missing.join(', ')}`, 403);
  if (input.credit_amount > policy.maxCredit)
    throw new DomainError(`Per-customer credit exceeds $${policy.maxCredit} policy limit.`, 403);
  const total = Math.round(input.credit_amount * 100) * shipments.length;
  if (total > Math.round(policy.maxTotal * 100))
    throw new DomainError(`Total credit exceeds $${policy.maxTotal} policy limit.`, 403);
}
