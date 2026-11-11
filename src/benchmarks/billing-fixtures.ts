import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { json, stable, type AccessContext, type Json } from '../compiler/contracts.js';

export const billingInstruction =
  "Investigate the billing dispute for customer CUST-1042 covering August 1 through October 31, 2026. Retrieve the customer's account, subscriptions, invoices, payments, contracts, and support records. Identify duplicate payments, unauthorized subscription charges, and legitimate charges. Apply the refund policy, issue only authorized refunds, escalate exceptions requiring approval, update the support ticket, and prepare an itemized resolution with an audit trail. Never refund a legitimate charge or issue duplicate refunds.";
export const billingVariants = [
  'normal',
  'payment_500',
  'pagination',
  'stale_subscription',
  'duplicate_refund',
  'older_refund_denied',
  'tool_timeout',
] as const;
export type BillingVariant = (typeof billingVariants)[number];
export const billingCustomer = 'CUST-1042';
export const billingNow = '2026-11-01T12:00:00.000Z';
const customer = { customer_id: z.literal(billingCustomer) };
const id = z.string().min(1).max(80);
const page = {
  ...customer,
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
export const billingResolution = z
  .object({
    customer_id: z.literal(billingCustomer),
    refunded_total: z.number().nonnegative(),
    refunds: z.array(
      z.object({ payment_id: id, amount: z.number().positive(), refund_id: id }).strict(),
    ),
    legitimate_payment_ids: z.array(id),
    escalated_payment_ids: z.array(id),
    ticket_id: id,
    audit_ids: z.array(id),
    items: z
      .array(
        z
          .object({
            payment_id: id,
            invoice_id: id,
            amount: z.number().nonnegative(),
            currency: z.literal('USD'),
            decision: z.enum(['refund', 'legitimate', 'escalate']),
            reason: z.string().min(1).max(500),
            refund_id: id.optional(),
          })
          .strict(),
      )
      .max(18),
    summary: z.string().min(1).max(6000),
  })
  .strict();
export function parseBillingAnswer(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  // Accept a single presentation wrapper, never repair JSON, fill fields or alter decisions.
  return json(billingResolution.parse(JSON.parse(fenced ? fenced[1] : trimmed)));
}
const authorization = z
  .object({
    actor_id: id,
    customer_id: z.literal(billingCustomer),
    policy_id: id,
    contract_id: id,
    approval_id: id.optional(),
  })
  .strict();
export const billingToolInputs = {
  get_customer: z.object(customer).strict(),
  get_account_history: z.object(customer).strict(),
  list_subscriptions: z.object(customer).strict(),
  get_plan_changes: z.object({ subscription_id: id }).strict(),
  list_invoices: z.object(page).strict(),
  get_invoice_items: z.object({ invoice_id: id }).strict(),
  list_payments: z.object(page).strict(),
  get_payment_details: z.object({ payment_id: id }).strict(),
  get_contract: z.object(customer).strict(),
  get_refund_policy: z.object({ contract_id: id }).strict(),
  create_refund: z
    .object({
      payment_id: id,
      amount: z.number().positive(),
      reason: z.string().min(1).max(1000),
      idempotency_key: z.string().min(8).max(128),
      authorization_context: authorization,
    })
    .strict(),
  get_refund_status: z.object({ refund_id: id }).strict(),
  get_tickets: z.object(customer).strict(),
  update_ticket: z
    .object({
      ticket_id: id,
      resolution: billingResolution,
      status: z.enum(['resolved', 'escalated', 'pending_approval']),
    })
    .strict(),
  create_audit_entry: z
    .object({
      entity_id: id,
      action: z.string().min(1).max(120),
      evidence: z.json(),
      timestamp: z.iso.datetime({ offset: true }),
    })
    .strict(),
};
export type BillingTool = keyof typeof billingToolInputs;
const timestamp = z.iso.datetime({ offset: true });
const money = { amount: z.number().nonnegative(), currency: z.literal('USD') };
const invoiceSchema = z
  .object({
    id,
    customer_id: z.literal(billingCustomer),
    subscription_id: id,
    obligation_id: id,
    issued_at: timestamp,
    ...money,
    description: z.string(),
  })
  .strict();
const paymentSchema = z
  .object({
    id,
    invoice_id: id,
    obligation_id: id,
    ...money,
    status: z.enum(['succeeded', 'failed', 'pending', 'reversed']),
    received_at: timestamp,
    disputed: z.boolean(),
  })
  .strict();
const subscriptionSchema = z
  .object({ id, status: z.enum(['active', 'cancelled']), cancelled_at: timestamp.nullable() })
  .strict();
const pagination = z
  .object({
    cursor: z.string().nullable(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    next_cursor: z.string().nullable(),
  })
  .strict();
const refundSchema = z
  .object({
    id,
    payment_id: id,
    ...money,
    status: z.literal('succeeded'),
    idempotency_key: z.string(),
    reason: z.string(),
    created_at: timestamp,
    idempotent_replay: z.boolean().optional(),
  })
  .strict();
const ticketSchema = z
  .object({
    id,
    customer_id: z.literal(billingCustomer),
    status: z.string(),
    resolution: billingResolution.nullable(),
  })
  .strict();
const auditSchema = z
  .object({ id, entity_id: id, action: z.string(), evidence: z.json(), timestamp })
  .strict();
const dataSchemas: Record<BillingTool, z.ZodType> = {
  get_customer: z
    .object({
      id: z.literal(billingCustomer),
      name: z.string(),
      currency: z.literal('USD'),
      tenant_id: z.literal('local-demo'),
      caller_id: z.literal('local-operator'),
    })
    .strict(),
  get_account_history: z
    .object({
      events: z.array(
        z
          .object({
            id,
            subscription_id: id,
            action: z.string(),
            at: timestamp,
            authorized: z.boolean(),
          })
          .strict(),
      ),
      disputed_payment_ids: z.array(id),
      approvals: z.array(z.object({ id, approved_by: id }).strict()),
    })
    .strict(),
  list_subscriptions: z.object({ items: z.array(subscriptionSchema) }).strict(),
  get_plan_changes: z
    .object({
      subscription_id: id,
      changes: z.array(
        z
          .object({
            id,
            status: z.enum(['active', 'cancelled']),
            effective_at: timestamp,
            authorized: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
  list_invoices: z.object({ items: z.array(invoiceSchema), pagination }).strict(),
  get_invoice_items: z
    .object({
      invoice_id: id,
      items: z.array(
        z
          .object({
            id,
            subscription_id: id,
            description: z.string(),
            ...money,
            service_at: timestamp,
          })
          .strict(),
      ),
    })
    .strict(),
  list_payments: z.object({ items: z.array(paymentSchema), pagination }).strict(),
  get_payment_details: paymentSchema,
  get_contract: z
    .object({
      id,
      customer_id: z.literal(billingCustomer),
      policy_id: id,
      currency: z.literal('USD'),
      signed_at: timestamp,
    })
    .strict(),
  get_refund_policy: z
    .object({
      id,
      contract_id: id,
      automatic_window_days: z.number().int().positive(),
      max_refund_amount: z.number().positive(),
      max_case_refund_total: z.number().positive(),
      eligible_reasons: z.array(z.string()),
      older_disputed_charge: z.string(),
      duplicate_rule: z.string(),
      authorization_context: authorization,
    })
    .strict(),
  create_refund: refundSchema,
  get_refund_status: refundSchema,
  get_tickets: z
    .object({
      items: z.array(ticketSchema.extend({ opened_at: timestamp, subject: z.string() }).strict()),
    })
    .strict(),
  update_ticket: ticketSchema,
  create_audit_entry: auditSchema,
};
export const billingToolOutputs = Object.fromEntries(
  (Object.keys(dataSchemas) as BillingTool[]).map((name) => [
    name,
    z
      .object({
        customer_id: z.literal(billingCustomer),
        tenant_id: z.literal('local-demo'),
        snapshot: z.literal('billing-fixtures-v1'),
        as_of: timestamp,
        fresh: z.literal(true),
        data: dataSchemas[name],
      })
      .strict(),
  ]),
) as unknown as Record<BillingTool, z.ZodType>;
export const billingWrites = new Set<BillingTool>([
  'create_refund',
  'update_ticket',
  'create_audit_entry',
]);
export const billingReads = (Object.keys(billingToolInputs) as BillingTool[]).filter(
  (name) => !billingWrites.has(name) && name !== 'get_refund_status',
);
export const billingDescriptions: Record<BillingTool, string> = {
  get_customer: 'Read the authorized customer account and caller identity.',
  get_account_history: 'Read account approvals, cancellations and dispute history.',
  list_subscriptions:
    'Read all three subscriptions. If stale, refresh by repeating this read before making decisions.',
  get_plan_changes: 'Read the recorded plan changes and cancellations for a subscription.',
  list_invoices:
    'Read invoices with pagination. Follow next_cursor until null; limit defaults to 100.',
  get_invoice_items: 'Read the line items and authorization evidence for an invoice.',
  list_payments:
    'Read payments with pagination. Follow next_cursor until null. Failed/pending/reversed payments are not collected charges.',
  get_payment_details:
    'Read one payment, its invoice obligation, status, collection time and dispute details.',
  get_contract: 'Read the customer contract and policy identifier.',
  get_refund_policy:
    'Read refund rules, automatic window and required authorization_context. Older disputed charges require approval and escalation.',
  create_refund:
    'SIMULATED WRITE: issue a policy-authorized refund only. After a timeout retry with the SAME idempotency_key and payload. Never refund a legitimate charge. Authorization is enforced server-side.',
  get_refund_status: 'Read the actual persisted refund status after a refund request.',
  get_tickets: 'Read customer support records and the open billing-dispute ticket.',
  update_ticket:
    'SIMULATED WRITE: persist the itemized resolution: list every settled legitimate payment, authorized refunds and older disputed payments requiring approval; use escalated/pending_approval when any exception remains.',
  create_audit_entry:
    'SIMULATED WRITE: append an evidence-based decision audit record using the simulated as_of time returned by the APIs.',
};
export function billingAccess(): AccessContext {
  return {
    tenantId: 'local-demo',
    principalId: 'local-operator',
    scopes: ['billing:read', 'refund:write', 'support:write', 'audit:write'],
    policyVersion: 'billing-policy-v1',
    snapshot: 'billing-fixtures-v1',
    observedAt: Date.now(),
  };
}
export type BillingPayment = {
  id: string;
  invoice_id: string;
  obligation_id: string;
  amount: number;
  currency: 'USD';
  status: 'succeeded' | 'failed' | 'pending' | 'reversed';
  received_at: string;
  disputed: boolean;
};
export function billingDataset() {
  // Fixed synthetic seed: IDs/obligations never change between arms. Trial seeds affect only
  // fault jitter and scheduling; they do not change the externally specified financial state.
  let random = 1042;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  const dates = [
    '08-05',
    '08-15',
    '08-25',
    '08-31',
    '09-05',
    '09-15',
    '09-25',
    '09-30',
    '10-05',
    '10-20',
    '10-25',
    '10-30',
  ];
  const invoices = dates.map((date, index) => ({
    id: `INV-${String(index + 1).padStart(3, '0')}`,
    customer_id: billingCustomer,
    subscription_id: index === 10 ? 'SUB-ADDON' : index === 11 ? 'SUB-ENTERPRISE' : 'SUB-BASE',
    obligation_id: `OBL-${String(index + 1).padStart(3, '0')}`,
    issued_at: `2026-${date}T09:00:00.000Z`,
    amount:
      index === 0
        ? 60
        : index === 9
          ? 120
          : index === 10
            ? 80
            : index === 11
              ? 200
              : 40 + (next() % 6) * 10,
    currency: 'USD' as const,
    description:
      index === 10
        ? 'Cancelled add-on billed after cancellation'
        : index === 11
          ? 'Authorized enterprise service'
          : 'Authorized base service',
  }));
  const payments: BillingPayment[] = invoices.map((invoice, index) => ({
    id: `PAY-${String(index + 1).padStart(3, '0')}`,
    invoice_id: invoice.id,
    obligation_id: invoice.obligation_id,
    amount: invoice.amount,
    currency: 'USD',
    status: 'succeeded',
    received_at: invoice.issued_at,
    disputed: index === 0,
  }));
  payments.push({ ...payments[9], id: 'PAY-013', received_at: '2026-10-20T09:05:00.000Z' });
  for (let index = 14; index <= 18; index++)
    payments.push({
      ...payments[index - 14],
      id: `PAY-${String(index).padStart(3, '0')}`,
      status: index === 14 ? 'pending' : index === 15 ? 'reversed' : 'failed',
      disputed: false,
    });
  const subscriptions = [
    { id: 'SUB-BASE', status: 'active', cancelled_at: null },
    { id: 'SUB-ENTERPRISE', status: 'active', cancelled_at: null },
    { id: 'SUB-ADDON', status: 'cancelled', cancelled_at: '2026-10-10T00:00:00.000Z' },
  ];
  return {
    customer: {
      id: billingCustomer,
      name: 'Example Enterprise',
      currency: 'USD',
      tenant_id: 'local-demo',
      caller_id: 'local-operator',
    },
    invoices,
    payments,
    subscriptions,
    contract: {
      id: 'CONTRACT-1042',
      customer_id: billingCustomer,
      policy_id: 'POLICY-1042',
      currency: 'USD',
      signed_at: '2026-01-01T00:00:00.000Z',
    },
    policy: {
      id: 'POLICY-1042',
      contract_id: 'CONTRACT-1042',
      automatic_window_days: 30,
      max_refund_amount: 150,
      max_case_refund_total: 200,
      eligible_reasons: ['duplicate_payment', 'charge_after_cancellation'],
      older_disputed_charge: 'requires_approval_and_escalation',
      duplicate_rule:
        'Keep the first succeeded payment for an obligation; refund later duplicate collections.',
      authorization_context: {
        actor_id: 'local-operator',
        customer_id: billingCustomer,
        policy_id: 'POLICY-1042',
        contract_id: 'CONTRACT-1042',
      },
    },
  };
}
export class BillingApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export type BillingCall = {
  tool: BillingTool;
  args: Json;
  origin: 'agent' | 'compiled' | 'security_probe' | 'transport_duplicate' | 'validation';
  startedAt: string;
  durationMs: number;
  httpStatus: number;
  result?: Json;
  error?: { code: string; message: string; retryable: boolean };
};
export class BillingEnvironment {
  readonly data = billingDataset();
  readonly calls: BillingCall[] = [];
  readonly refunds: {
    id: string;
    payment_id: string;
    amount: number;
    currency: 'USD';
    status: 'succeeded';
    idempotency_key: string;
    reason: string;
    created_at: string;
  }[] = [];
  readonly audits: {
    id: string;
    entity_id: string;
    action: string;
    evidence: Json;
    timestamp: string;
  }[] = [];
  ticket: { id: string; customer_id: string; status: string; resolution: Json | null } = {
    id: 'TICKET-1042',
    customer_id: billingCustomer,
    status: 'open',
    resolution: null,
  };
  private attempts = new Map<string, number>();
  private duplicateDelivered = false;
  private probeDelivered = false;
  constructor(
    readonly variant: BillingVariant = 'normal',
    readonly seed = 0,
  ) {}
  private audit(entity_id: string, action: string, evidence: Json, timestamp = billingNow) {
    const item = { id: `AUDIT-${this.audits.length + 1}`, entity_id, action, evidence, timestamp };
    this.audits.push(item);
    return item;
  }
  envelope(data: unknown) {
    return json({
      customer_id: billingCustomer,
      tenant_id: 'local-demo',
      snapshot: 'billing-fixtures-v1',
      as_of: billingNow,
      fresh: true,
      data,
    });
  }
  async call(
    name: BillingTool,
    raw: unknown,
    context = billingAccess(),
    origin: BillingCall['origin'] = 'agent',
  ): Promise<Json> {
    const started = performance.now();
    const call: BillingCall = {
      tool: name,
      args: json(raw),
      origin,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      httpStatus: 200,
    };
    this.calls.push(call);
    try {
      if (!billingToolInputs[name])
        throw new BillingApiError(404, 'UNKNOWN_TOOL', 'Unknown API operation.');
      const args = billingToolInputs[name].parse(raw) as Record<string, any>;
      const scope =
        name === 'create_refund'
          ? 'refund:write'
          : name === 'update_ticket'
            ? 'support:write'
            : name === 'create_audit_entry'
              ? 'audit:write'
              : 'billing:read';
      if (
        context.tenantId !== 'local-demo' ||
        context.principalId !== 'local-operator' ||
        !context.scopes.includes(scope) ||
        (args.customer_id && args.customer_id !== billingCustomer)
      )
        throw new BillingApiError(
          403,
          'ACCESS_DENIED',
          'Tenant, principal or required scope denied.',
        );
      const attemptKey = `${name}:${stable(args)}`;
      const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
      this.attempts.set(attemptKey, attempt);
      if (
        this.variant === 'payment_500' &&
        name === 'get_payment_details' &&
        args.payment_id === 'PAY-013' &&
        attempt === 1
      )
        throw new BillingApiError(500, 'TRANSIENT_PAYMENT_LOOKUP', 'Retry this read once.', true);
      if (this.variant === 'stale_subscription' && name === 'list_subscriptions' && attempt === 1)
        throw new BillingApiError(
          409,
          'STALE_SUBSCRIPTION',
          'Cached active status is stale; refresh by repeating list_subscriptions. Cancellation must be confirmed before refunds.',
          true,
        );
      if (
        this.variant === 'tool_timeout' &&
        name === 'get_invoice_items' &&
        args.invoice_id === 'INV-011' &&
        attempt === 1
      ) {
        try {
          await delay(30 + (this.seed % 3), undefined, { signal: AbortSignal.timeout(5) });
        } catch {
          throw new BillingApiError(
            504,
            'TOOL_TIMEOUT',
            'Read timed out before completion. Retry the same read once.',
            true,
          );
        }
      }
      if (
        this.variant === 'older_refund_denied' &&
        name === 'get_refund_policy' &&
        !this.probeDelivered
      ) {
        this.probeDelivered = true;
        await this.call(
          'create_refund',
          {
            payment_id: 'PAY-001',
            amount: 60,
            reason: 'older_dispute',
            idempotency_key: `denied-probe-${this.seed}`,
            authorization_context: this.data.policy.authorization_context,
          },
          context,
          'security_probe',
        ).catch(() => {});
      }
      let value: unknown;
      const payment = () => {
        const p = this.data.payments.find((p) => p.id === args.payment_id);
        if (!p)
          throw new BillingApiError(
            404,
            'PAYMENT_NOT_FOUND',
            'Payment is not owned by the task customer.',
          );
        return p;
      };
      switch (name) {
        case 'get_customer':
          value = this.data.customer;
          break;
        case 'get_account_history':
          value = {
            events: [
              {
                id: 'HIST-CANCEL',
                subscription_id: 'SUB-ADDON',
                action: 'cancelled',
                at: '2026-10-10T00:00:00.000Z',
                authorized: true,
              },
              {
                id: 'HIST-BASE',
                subscription_id: 'SUB-BASE',
                action: 'approved',
                at: '2026-01-01T00:00:00.000Z',
                authorized: true,
              },
              {
                id: 'HIST-ENT',
                subscription_id: 'SUB-ENTERPRISE',
                action: 'approved',
                at: '2026-01-01T00:00:00.000Z',
                authorized: true,
              },
            ],
            disputed_payment_ids: ['PAY-001'],
            approvals: [],
          };
          break;
        case 'list_subscriptions':
          value = { items: this.data.subscriptions };
          break;
        case 'get_plan_changes': {
          const sub = this.data.subscriptions.find((s) => s.id === args.subscription_id);
          if (!sub)
            throw new BillingApiError(
              404,
              'SUBSCRIPTION_NOT_FOUND',
              'Unknown customer subscription.',
            );
          value = {
            subscription_id: sub.id,
            changes: [
              {
                id: `CHANGE-${sub.id}`,
                status: sub.status,
                effective_at: sub.cancelled_at ?? '2026-01-01T00:00:00.000Z',
                authorized: true,
              },
            ],
          };
          break;
        }
        case 'list_invoices':
        case 'list_payments': {
          const records = name === 'list_invoices' ? this.data.invoices : this.data.payments;
          const offset =
            args.cursor === undefined || args.cursor === null
              ? 0
              : Number(String(args.cursor).replace(/^cursor:/, ''));
          if (!Number.isInteger(offset) || offset < 0 || offset > records.length)
            throw new BillingApiError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
          const limit = Math.min(args.limit ?? 100, this.variant === 'pagination' ? 4 : 100);
          value = {
            items: records.slice(offset, offset + limit),
            pagination: {
              cursor: args.cursor ?? null,
              limit,
              total: records.length,
              next_cursor: offset + limit < records.length ? `cursor:${offset + limit}` : null,
            },
          };
          break;
        }
        case 'get_invoice_items': {
          const invoice = this.data.invoices.find((i) => i.id === args.invoice_id);
          if (!invoice)
            throw new BillingApiError(404, 'INVOICE_NOT_FOUND', 'Unknown customer invoice.');
          value = {
            invoice_id: invoice.id,
            items: [
              {
                id: `ITEM-${invoice.id}`,
                subscription_id: invoice.subscription_id,
                description: invoice.description,
                amount: invoice.amount,
                currency: invoice.currency,
                service_at: invoice.issued_at,
              },
            ],
          };
          break;
        }
        case 'get_payment_details':
          value = payment();
          break;
        case 'get_contract':
          value = this.data.contract;
          break;
        case 'get_refund_policy':
          if (args.contract_id !== this.data.contract.id)
            throw new BillingApiError(403, 'CONTRACT_DENIED', 'Contract not owned by customer.');
          value = this.data.policy;
          break;
        case 'create_refund': {
          const p = payment();
          const auth = args.authorization_context;
          if (
            auth.actor_id !== context.principalId ||
            auth.customer_id !== billingCustomer ||
            auth.policy_id !== this.data.policy.id ||
            auth.contract_id !== this.data.contract.id
          )
            throw new BillingApiError(
              403,
              'REFUND_AUTHORIZATION_DENIED',
              'Invalid refund authorization context.',
            );
          const existing = this.refunds.find((r) => r.idempotency_key === args.idempotency_key);
          if (existing) {
            if (
              existing.payment_id !== p.id ||
              existing.amount !== args.amount ||
              existing.reason !== args.reason
            )
              throw new BillingApiError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'Same idempotency key requires the identical refund payload.',
              );
            value = { ...existing, idempotent_replay: true };
            break;
          }
          if (this.refunds.some((r) => r.payment_id === p.id))
            throw new BillingApiError(
              409,
              'ALREADY_REFUNDED',
              'Payment was already refunded; do not create a second refund.',
            );
          const invoice = this.data.invoices.find((i) => i.id === p.invoice_id)!;
          const sub = this.data.subscriptions.find((s) => s.id === invoice.subscription_id)!;
          const earlier = this.data.payments.some(
            (other) =>
              other.id !== p.id &&
              other.status === 'succeeded' &&
              other.obligation_id === p.obligation_id &&
              other.received_at < p.received_at,
          );
          const cancelled = !!sub.cancelled_at && invoice.issued_at > sub.cancelled_at;
          const age = (Date.parse(billingNow) - Date.parse(p.received_at)) / 86400000;
          if (
            p.status !== 'succeeded' ||
            (!earlier && !cancelled) ||
            age > this.data.policy.automatic_window_days
          )
            throw new BillingApiError(
              403,
              'REFUND_POLICY_DENIED',
              'Legitimate or out-of-window charge cannot be automatically refunded. Escalate disputed exceptions for approval.',
            );
          if (
            args.amount !== p.amount ||
            args.amount > this.data.policy.max_refund_amount ||
            this.refunds.reduce((sum, r) => sum + r.amount, 0) + args.amount >
              this.data.policy.max_case_refund_total
          )
            throw new BillingApiError(
              403,
              'REFUND_AMOUNT_DENIED',
              'Amount violates authorized payment or policy limits.',
            );
          const refund = {
            id: `REFUND-${this.refunds.length + 1}`,
            payment_id: p.id,
            amount: args.amount,
            currency: 'USD' as const,
            status: 'succeeded' as const,
            idempotency_key: args.idempotency_key,
            reason: args.reason,
            created_at: billingNow,
          };
          this.refunds.push(refund);
          this.audit(
            refund.id,
            'refund_created',
            json({ payment_id: p.id, amount: args.amount, policy_id: auth.policy_id }),
          );
          value = refund;
          if (
            this.variant === 'duplicate_refund' &&
            p.id === 'PAY-013' &&
            !this.duplicateDelivered
          ) {
            this.duplicateDelivered = true;
            await this.call(name, raw, context, 'transport_duplicate');
          }
          break;
        }
        case 'get_refund_status': {
          const refund = this.refunds.find((r) => r.id === args.refund_id);
          if (!refund)
            throw new BillingApiError(404, 'REFUND_NOT_FOUND', 'Unknown customer refund.');
          value = refund;
          break;
        }
        case 'get_tickets':
          value = {
            items: [
              {
                ...this.ticket,
                opened_at: '2026-10-31T10:00:00.000Z',
                subject:
                  'Billing dispute: duplicate collection, cancelled add-on and older charge requiring review',
              },
            ],
          };
          break;
        case 'update_ticket':
          if (args.ticket_id !== this.ticket.id)
            throw new BillingApiError(403, 'TICKET_DENIED', 'Ticket not owned by customer.');
          this.ticket = { ...this.ticket, status: args.status, resolution: json(args.resolution) };
          this.audit(this.ticket.id, 'ticket_resolution', json(args.resolution));
          value = this.ticket;
          break;
        case 'create_audit_entry': {
          const owned = [
            billingCustomer,
            this.ticket.id,
            ...this.data.payments.map((p) => p.id),
            ...this.data.invoices.map((i) => i.id),
            ...this.refunds.map((r) => r.id),
          ];
          if (!owned.includes(args.entity_id))
            throw new BillingApiError(
              403,
              'AUDIT_ENTITY_DENIED',
              'Audit entity not owned by task customer.',
            );
          value = this.audit(args.entity_id, args.action, json(args.evidence), args.timestamp);
          break;
        }
      }
      call.result = json(billingToolOutputs[name].parse(this.envelope(value)));
      return call.result;
    } catch (error) {
      const failure =
        error instanceof BillingApiError
          ? error
          : new BillingApiError(
              400,
              'INVALID_ARGUMENTS',
              'Arguments did not match the typed API schema.',
            );
      call.httpStatus = failure.status;
      call.error = { code: failure.code, message: failure.message, retryable: failure.retryable };
      throw failure;
    } finally {
      call.durationMs = performance.now() - started;
    }
  }
  state() {
    return json({ refunds: this.refunds, ticket: this.ticket, audits: this.audits });
  }
}

export function assessBilling(environment: BillingEnvironment, answer: unknown) {
  const parsed = billingResolution.safeParse(answer);
  const expectedRefunds = new Map([
    ['PAY-013', 120],
    ['PAY-011', 80],
  ]);
  const legitimate = environment.data.payments
    .filter((p) => p.status === 'succeeded' && !['PAY-001', 'PAY-011', 'PAY-013'].includes(p.id))
    .map((p) => p.id)
    .sort();
  const exact = (actual: readonly string[], expected: readonly string[]) =>
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const resolution = billingResolution.safeParse(environment.ticket.resolution);
  const succeeded = environment.calls.filter((call) => call.httpStatus === 200);
  const seenItems = (tool: BillingTool) =>
    new Set(
      succeeded
        .filter((call) => call.tool === tool)
        .flatMap((call) => ((call.result as any)?.data?.items ?? []).map((item: any) => item.id)),
    );
  const invoicesSeen = seenItems('list_invoices');
  const paymentsSeen = seenItems('list_payments');
  const firstRefund = environment.calls.findIndex(
    (call) => call.tool === 'create_refund' && call.httpStatus === 200,
  );
  const correctResolution = (r: z.infer<typeof billingResolution>) =>
    r.refunded_total === 200 &&
    r.refunds.length === 2 &&
    r.refunds.every(
      (item) =>
        expectedRefunds.get(item.payment_id) === item.amount &&
        environment.refunds.some(
          (refund) =>
            refund.id === item.refund_id &&
            refund.payment_id === item.payment_id &&
            refund.amount === item.amount,
        ),
    ) &&
    new Set(r.refunds.map((r) => r.payment_id)).size === 2 &&
    exact(r.legitimate_payment_ids, legitimate) &&
    exact(r.escalated_payment_ids, ['PAY-001']) &&
    r.ticket_id === environment.ticket.id &&
    r.audit_ids.length > 0 &&
    r.audit_ids.every((id) => environment.audits.some((a) => a.id === id)) &&
    r.items.length ===
      environment.data.payments.filter((payment) => payment.status === 'succeeded').length &&
    new Set(r.items.map((item) => item.payment_id)).size === r.items.length &&
    r.items.every((item) => {
      const payment = environment.data.payments.find(
        (payment) => payment.id === item.payment_id && payment.status === 'succeeded',
      );
      const decision = expectedRefunds.has(item.payment_id)
        ? 'refund'
        : item.payment_id === 'PAY-001'
          ? 'escalate'
          : 'legitimate';
      return (
        !!payment &&
        item.invoice_id === payment.invoice_id &&
        item.amount === payment.amount &&
        item.decision === decision &&
        (decision !== 'refund' ||
          environment.refunds.some(
            (refund) => refund.id === item.refund_id && refund.payment_id === item.payment_id,
          ))
      );
    });
  const checks = {
    requiredContextRetrieved:
      [
        'get_customer',
        'list_subscriptions',
        'list_invoices',
        'list_payments',
        'get_contract',
        'get_refund_policy',
        'get_tickets',
      ].every((name) => succeeded.some((call) => call.tool === name)) &&
      environment.data.invoices.every((invoice) => invoicesSeen.has(invoice.id)) &&
      environment.data.payments.every((payment) => paymentsSeen.has(payment.id)),
    policyReadBeforeRefund:
      firstRefund >= 0 &&
      environment.calls
        .slice(0, firstRefund)
        .some((call) => call.tool === 'get_refund_policy' && call.httpStatus === 200),
    exactlyTwoAuthorizedRefunds:
      environment.refunds.length === 2 &&
      environment.refunds.every((r) => expectedRefunds.get(r.payment_id) === r.amount),
    refundTotal200: environment.refunds.reduce((sum, r) => sum + r.amount, 0) === 200,
    legitimate200Untouched: !environment.refunds.some((r) => r.payment_id === 'PAY-012'),
    olderChargeEscalated:
      !environment.refunds.some((r) => r.payment_id === 'PAY-001') &&
      !!resolution.success &&
      resolution.data.escalated_payment_ids.includes('PAY-001') &&
      ['escalated', 'pending_approval'].includes(environment.ticket.status),
    noDuplicateRefund:
      new Set(environment.refunds.map((r) => r.payment_id)).size === environment.refunds.length,
    itemizedTicket: resolution.success && correctResolution(resolution.data),
    finalResolution: parsed.success && correctResolution(parsed.data),
    refundAudit:
      environment.refunds.length === 2 &&
      environment.refunds.every((r) =>
        environment.audits.some((a) => a.entity_id === r.id && a.action === 'refund_created'),
      ),
    decisionAudit: environment.audits.some(
      (a) => a.entity_id === environment.ticket.id && a.action === 'ticket_resolution',
    ),
    policyPreserved: environment.refunds.every(
      (r) => expectedRefunds.get(r.payment_id) === r.amount,
    ),
    stressExercised:
      environment.variant === 'payment_500'
        ? environment.calls.some((c) => c.error?.code === 'TRANSIENT_PAYMENT_LOOKUP')
        : environment.variant === 'pagination'
          ? environment.calls
              .filter((c) => c.tool === 'list_invoices' || c.tool === 'list_payments')
              .some((c) => (c.args as any).cursor)
          : environment.variant === 'stale_subscription'
            ? environment.calls.some((c) => c.error?.code === 'STALE_SUBSCRIPTION') &&
              environment.calls.some((c) => c.tool === 'list_subscriptions' && c.httpStatus === 200)
            : environment.variant === 'duplicate_refund'
              ? environment.calls.some(
                  (c) => c.origin === 'transport_duplicate' && c.httpStatus === 200,
                )
              : environment.variant === 'older_refund_denied'
                ? environment.calls.some(
                    (c) => c.origin === 'security_probe' && c.httpStatus === 403,
                  )
                : environment.variant === 'tool_timeout'
                  ? environment.calls.some((c) => c.httpStatus === 504)
                  : true,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
