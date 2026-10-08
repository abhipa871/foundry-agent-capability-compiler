import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import {
  irSchema,
  irDigest,
  operationSchema,
  validateIR,
  type IRArtifact,
} from '../compiler/ir.js';
import { tenantIdSchema } from '../security/identity.js';
import { measurementSchema } from '../telemetry/measurement.js';
import { DomainError } from '../domain.js';

export const routingSchema = z
  .object({
    mode: z.enum(['observe', 'shadow', 'live']),
    rolloutPercent: z.number().int().min(0).max(100),
  })
  .strict();
export type RoutingPolicy = z.infer<typeof routingSchema>;
export const wireArtifactSchema = z
  .object({
    id: z.string().uuid(),
    name: z.literal('load_customer_context'),
    version: z.number().int().positive(),
    taskKind: z.literal('customer_context'),
    createdAt: z.string().datetime(),
    ir: irSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['verified', 'approved']),
    verifiedDigest: z.string(),
    approvedDigest: z.string().optional(),
    verifiedAt: z.string().datetime(),
    validationVersion: z.literal('read-validation-v3'),
  })
  .strict();
export const ticketSchema = routingSchema
  .extend({
    format: z.literal('foundry-runtime-v1'),
    tenantId: tenantIdSchema,
    principalId: z.string().min(1).max(80),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    artifact: wireArtifactSchema.optional(),
  })
  .strict();
export type RuntimeTicket = z.infer<typeof ticketSchema>;
export const signedTicketSchema = z
  .object({
    payload: z.string().max(65536),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(128),
  })
  .strict();
export type SignedTicket = z.infer<typeof signedTicketSchema>;
export function verifyTicket(
  raw: unknown,
  publicKey: string,
  binding: { tenantId: string; principalId: string },
  now = Date.now(),
): RuntimeTicket {
  const signed = signedTicketSchema.parse(raw);
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(signed.payload), key, Buffer.from(signed.signature, 'base64'))
  )
    throw new DomainError('Invalid capability signature.', 403);
  const ticket = ticketSchema.parse(JSON.parse(signed.payload));
  if (
    ticket.tenantId !== binding.tenantId ||
    ticket.principalId !== binding.principalId ||
    ticket.issuedAt > now ||
    ticket.expiresAt <= now ||
    ticket.expiresAt - ticket.issuedAt > 60000
  )
    throw new DomainError('Capability identity or lease rejected.', 403);
  if (ticket.artifact) {
    const artifact = ticket.artifact;
    validateIR(artifact.ir);
    if (
      artifact.ir.guards.tenantId !== ticket.tenantId ||
      (artifact.ir.guards.principalId && artifact.ir.guards.principalId !== ticket.principalId) ||
      irDigest(artifact.ir) !== artifact.digest ||
      artifact.verifiedDigest !== artifact.digest ||
      (ticket.mode === 'live' &&
        (artifact.status !== 'approved' || artifact.approvedDigest !== artifact.digest))
    )
      throw new DomainError('Capability validation rejected.', 403);
  } else if (ticket.mode !== 'observe')
    throw new DomainError('Executable routing requires an artifact.', 409);
  return ticket;
}
export function runtimeArtifact(wire: NonNullable<RuntimeTicket['artifact']>): IRArtifact {
  return {
    ...wire,
    report: {
      taskKind: wire.taskKind,
      signature: '',
      supportingTraceIds: [],
      parameters: [],
      optimizations: [],
      prunedEvents: [],
      rejectedNodes: [],
    },
    checks: [
      {
        name: 'Server-signed current validation',
        category: 'policy',
        passed: true,
        detail: 'Trusted control-plane attestation',
        durationMs: 0,
      },
    ],
  };
}

const structuralEventSchema = z
  .object({
    eventId: z.string().uuid(),
    operation: z.enum(['crm.getCustomer', 'orders.list', 'payments.refundHistory']),
    adapterVersion: z.literal('1'),
    effect: z.literal('read'),
    status: z.enum(['success', 'failed', 'skipped']),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    args: z
      .object({
        customerId: z
          .object({ source: z.enum(['task_input', 'event_output', 'literal']) })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine((event) => event.endMs >= event.startMs);
export const telemetrySchema = z
  .object({
    traceId: z.string().uuid(),
    tenantId: tenantIdSchema,
    taskKind: z.literal('customer_context'),
    principalId: z.string().min(1).max(80),
    agentId: z.string().min(1).max(80),
    events: z.array(structuralEventSchema).max(100),
    measurement: measurementSchema,
    routingMode: z.enum(['observe', 'shadow', 'live']),
    capabilityId: z.string().uuid().optional(),
    capabilityDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    runtimeStatus: z.enum(['compiled', 'native', 'fallback', 'denied']),
    shadowStatus: z
      .enum(['match', 'mismatch', 'compiled_failure', 'baseline_unavailable', 'guard_miss'])
      .optional(),
    selection: z
      .object({
        mode: z.enum(['normal', 'compiled_tool', 'compiled_prefetch', 'denied']).optional(),
        reason: z.string().max(80).optional(),
        durationMs: z.number().nonnegative().optional(),
        resources: z.array(operationSchema).max(3),
        prerequisites: z.array(operationSchema).max(3),
        fallbackReason: z
          .enum([
            'no_candidate',
            'guard_miss',
            'adapter_drift',
            'unsupported_state',
            'runtime_failure',
          ])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ClientTelemetry = z.infer<typeof telemetrySchema>;
export type StoredTelemetry = ClientTelemetry & {
  id: string;
  capturedAt: string;
  expiresAt: string;
  trust: 'client_reported';
};
