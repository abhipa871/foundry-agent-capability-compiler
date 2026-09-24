import {
  DomainError,
  inputSchema,
  operations,
  type Capability,
  type Effect,
  type Shipment,
  type WorkflowOutput,
} from '../domain.js';
import { authorize } from '../policy/enforce.js';

export const shipments: Shipment[] = [
  { id: 'SHP-1001', customer: 'Acme Studio', daysLate: 8, owner: 'Maya Chen', eligible: true },
  { id: 'SHP-1002', customer: 'Northstar Labs', daysLate: 6, owner: 'Theo Brooks', eligible: true },
  { id: 'SHP-1003', customer: 'Meridian Supply', daysLate: 12, owner: 'Maya Chen', eligible: true },
  { id: 'SHP-1004', customer: 'Atlas Works', daysLate: 3, owner: 'Sam Rivera', eligible: true },
  { id: 'SHP-1005', customer: 'Cedar & Co.', daysLate: 5, owner: 'Theo Brooks', eligible: true },
  {
    id: 'SHP-1006',
    customer: 'Archived Account',
    daysLate: 15,
    owner: 'Sam Rivera',
    eligible: false,
  },
];
export type Fault = 'none' | 'timeout' | 'transient' | 'partial' | 'stale';

// This interpreter only accepts compiler-owned operations. No eval, generated code execution,
// network, filesystem access, or production credentials are exposed to candidate plans.
export function executePlan(
  cap: Capability,
  rawInput: unknown,
  options: {
    contractVersion: number;
    existing?: Set<string>;
    fault?: Fault;
    fixture?: Shipment[];
  },
): WorkflowOutput {
  const input = inputSchema.parse(rawInput);
  if (
    cap.operations.length !== operations.length ||
    cap.operations.some((operation, index) => operation !== operations[index])
  ) {
    throw new DomainError(
      'Capability operation plan is not compiler-owned and cannot execute.',
      409,
    );
  }
  if (cap.contractVersion !== options.contractVersion)
    throw new DomainError(
      'Adapter contract changed. Recompile and reverify before execution.',
      409,
    );
  if (options.fault === 'stale')
    throw new DomainError('Stale shipment data: freshness check failed.', 409);
  if (options.fault === 'timeout')
    throw new DomainError('Adapter timed out after 3 bounded attempts.', 504);
  const eligible = (options.fixture ?? shipments).filter(
    (s) => s.eligible && s.daysLate > input.delay_days && !options.existing?.has(s.id),
  );
  authorize(cap.policy, input, eligible);
  const effects: Effect[] = [];
  for (const shipment of eligible) {
    effects.push({
      id: `credit-${shipment.id}`,
      shipmentId: shipment.id,
      customer: shipment.customer,
      amount: input.credit_amount,
      crmStatus: 'Service recovery completed',
      notification: `${shipment.owner}: $${input.credit_amount.toFixed(2)} credit issued for ${shipment.id}.`,
    });
    if (options.fault === 'partial')
      throw new DomainError('CRM adapter failed; staged writes discarded.', 502);
  }
  return {
    customers: effects.length,
    totalCredit: Math.round(effects.length * input.credit_amount * 100) / 100,
    effects,
    attempts: options.fault === 'transient' ? 2 : 1,
  };
}
