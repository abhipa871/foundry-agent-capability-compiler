import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain.js';
import { tenantIdSchema } from '../security/identity.js';
import { measurementSchema } from '../telemetry/measurement.js';
import { contracts } from '../runtime/adapters/registry.js';
import { redact, safeText } from './privacy.js';
export { redact } from './privacy.js';
import { canonical, customerInput, identifier } from '../compiler/ir.js';

export const argName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

const uuid = z.string().uuid();
export const resourceRefSchema = z
  .object({
    system: z.string().min(1).max(40),
    kind: z.string().min(1).max(40),
    key: z.string().min(1).max(80),
    observedVersion: z.string().max(40).optional(),
  })
  .strict();
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export const valueRefSchema = z
  .object({ producerEventId: uuid, outputPath: z.enum(['customerId']) })
  .strict();
export type ValueRef = z.infer<typeof valueRefSchema>;

// An argument records where its value came from, not only what it was. `task_input` and
// `event_output` are dependency evidence; `literal` is not, and never becomes a parameter on its own.
export const argExprSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('task_input'),
      key: z.literal('customerId'),
      value: z.string().max(80),
    })
    .strict(),
  z
    .object({ source: z.literal('event_output'), ref: valueRefSchema, value: z.string().max(80) })
    .strict(),
  z.object({ source: z.literal('literal'), value: z.string().max(80) }).strict(),
]);
export type ArgExpr = z.infer<typeof argExprSchema>;
export const toolEventSchema = z
  .object({
    eventId: uuid,
    traceId: uuid,
    parentSpanId: uuid.optional(),
    principalId: z.string().max(80).optional(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    adapterId: z.string().min(1).max(40),
    adapterVersion: z.string().min(1).max(20),
    operation: z.string().min(1).max(80),
    args: z.record(argName, argExprSchema),
    result: z
      .object({ schemaId: z.string().min(1).max(40), projection: z.unknown() })
      .strict()
      .optional(),
    status: z.enum(['success', 'failed', 'skipped']),
    errorClass: z.string().min(1).max(80).optional(),
    effect: z.enum(['pure', 'read', 'write', 'external_write']),
    reads: z.array(resourceRefSchema).max(16),
    writes: z.array(resourceRefSchema).max(16),
    policyVersion: z.string().min(1).max(40),
    credentialScopeIds: z.array(z.string().min(1).max(40)).max(8),
  })
  .strict()
  .refine((event) => event.endMs >= event.startMs, 'Event ended before it started.');
export type ToolEvent = z.infer<typeof toolEventSchema>;
export const observableResultSchema = z
  .object({
    customerId: z.string().max(20),
    eligible: z.boolean(),
    orderCount: z.number().int().nonnegative(),
    refundCount: z.number().int().nonnegative(),
    refundTotal: z.number().nonnegative(),
  })
  .strict();
export type ObservableResult = z.infer<typeof observableResultSchema>;
export const toolTraceSchema = z
  .object({
    traceId: uuid,
    taskKind: identifier,
    task: z.string().min(10).max(1000),
    agentModel: z.string().min(1).max(80),
    tenantId: tenantIdSchema,
    principalId: z.string().min(1).max(80).optional(),
    agentId: z.string().min(1).max(80).optional(),
    provider: z.string().max(80).optional(),
    measurement: measurementSchema.optional(),
    privacyMode: z.enum(['minimal', 'standard', 'full']).optional(),
    modelEvents: z
      .array(
        z
          .object({
            id: uuid,
            provider: z.string().max(80),
            model: z.string().max(80),
            startMs: z.number().nonnegative(),
            endMs: z.number().nonnegative(),
            status: z.enum(['success', 'failed']),
            inputTokens: z.number().int().nonnegative().nullable(),
            outputTokens: z.number().int().nonnegative().nullable(),
            cachedInputTokens: z.number().int().nonnegative().nullable(),
            costUsd: z.number().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
    snapshot: z.literal('fixtures-v1'),
    policyVersion: z.literal('read-policy-v1'),
    taskInput: customerInput,
    status: z.enum(['success', 'failed']),
    llmInvocations: z.number().int().nonnegative().max(1000),
    agentTokens: z.number().int().nonnegative().max(10000000),
    durationMs: z.number().positive().max(3600000),
    finalEventId: uuid.optional(),
    events: z.array(toolEventSchema).max(100),
    observableResult: observableResultSchema,
  })
  .strict();
export type ToolTrace = z.infer<typeof toolTraceSchema>;
export type StoredToolTrace = ToolTrace & {
  id: string;
  capturedAt: string;
  source: 'demo' | 'import' | 'recovery';
  resultHashes: Record<string, string>;
  expiresAt?: string;
};

// Select the wire schema explicitly; storage metadata is never accepted from an SDK caller.
export function replayTrace(trace: StoredToolTrace): ToolTrace {
  return toolTraceSchema.parse(
    Object.fromEntries(
      Object.keys(toolTraceSchema.shape).map((key) => [key, trace[key as keyof ToolTrace]]),
    ),
  );
}

const sensitive = /token|secret|password|authorization|api[_-]?key|credential/i;

export function captureToolTrace(
  value: unknown,
  source: StoredToolTrace['source'],
): StoredToolTrace {
  const trace = toolTraceSchema.parse(value);
  if (trace.status === 'success' && !trace.events.length)
    throw new DomainError('Successful trace needs tool evidence.');
  const ids = new Set<string>();
  for (const event of trace.events) {
    if (event.traceId !== trace.traceId)
      throw new DomainError(`Event ${event.eventId} belongs to another trace.`);
    if (ids.has(event.eventId)) throw new DomainError(`Duplicate event id ${event.eventId}.`);
    ids.add(event.eventId);
  }
  for (const event of trace.events) {
    if (event.parentSpanId && !ids.has(event.parentSpanId))
      throw new DomainError(`Event ${event.eventId} references a missing span parent.`);
    for (const arg of Object.values(event.args)) {
      if (arg.source !== 'event_output') continue;
      const producer = trace.events.find((e) => e.eventId === arg.ref.producerEventId);
      if (!producer) throw new DomainError(`Event ${event.eventId} references a missing producer.`);
      if (producer.endMs > event.startMs)
        throw new DomainError(`Event ${event.eventId} consumes a value produced after it started.`);
    }
  }
  if (trace.finalEventId && !ids.has(trace.finalEventId))
    throw new DomainError('finalEventId is not part of the trace.');
  const events = trace.events.map((event) => ({
    ...event,
    args: Object.fromEntries(
      Object.entries(event.args).map(([key, arg]) => [
        key,
        sensitive.test(key) ? { ...arg, value: '[redacted]' } : arg,
      ]),
    ),
    result: event.result
      ? {
          ...event.result,
          projection:
            event.operation in contracts && event.status === 'success'
              ? contracts[event.operation as keyof typeof contracts].output.parse(
                  event.result.projection,
                )
              : trace.privacyMode === 'full'
                ? redact(event.result.projection)
                : '[omitted]',
        }
      : undefined,
  }));
  const resultHashes = Object.fromEntries(
    events
      .filter((event) => event.result)
      .map((event) => [
        event.eventId,
        createHash('sha256').update(canonical(event.result!.projection)).digest('hex').slice(0, 32),
      ]),
  );
  return {
    ...trace,
    task: trace.privacyMode === 'full' ? safeText(trace.task) : 'Observed customer context task.',
    events,
    id: trace.traceId,
    capturedAt: new Date().toISOString(),
    source,
    resultHashes,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  };
}

export function traceScopeIds(traces: StoredToolTrace[]): string[] {
  return [
    ...new Set(
      traces.flatMap((trace) => trace.events.flatMap((event) => event.credentialScopeIds)),
    ),
  ].sort();
}

export function newTraceId(): string {
  return randomUUID();
}
