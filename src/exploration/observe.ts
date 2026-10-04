import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DomainError } from '../domain.js';
import { customerInput, type ReadOperation } from '../compiler/ir.js';
import {
  authorizeContext,
  contracts,
  type AdapterRunner,
  type RuntimeContext,
} from '../runtime/adapters/registry.js';
import { bounded } from '../runtime/bounded.js';
import { contextProjection, normalizeObservable } from '../runtime/observable.js';
import {
  emptyMeasurement,
  reportedUsageSchema,
  type Measurement,
  type ReportedUsage,
} from '../telemetry/measurement.js';
import {
  captureToolTrace,
  type ArgExpr,
  type StoredToolTrace,
  type ToolEvent,
  type ToolTrace,
} from './tool-events.js';
import { structuralEvent, type PrivacyMode } from './privacy.js';

// A wrapper resolves explicit expressions itself. Equal strings or model prose never establish
// lineage. Credentials, raw model messages and private reasoning are not captured here.
export class TrajectoryObserver {
  readonly traceId = randomUUID();
  readonly events: ToolEvent[] = [];
  readonly modelEvents: NonNullable<ToolTrace['modelEvents']> = [];
  readonly measurement: Measurement;
  private readonly started = performance.now();
  constructor(
    private readonly options: {
      input: { customerId: string };
      context: RuntimeContext;
      adapters: AdapterRunner;
      agentId: string;
      provider?: string;
      model?: string;
      privacyMode?: PrivacyMode;
      origin?: Measurement['origin'];
    },
  ) {
    customerInput.parse(options.input);
    this.measurement = emptyMeasurement(options.origin);
  }
  async read(
    operation: ReadOperation,
    binding:
      | Omit<Extract<ArgExpr, { source: 'task_input' }>, 'value'>
      | Omit<Extract<ArgExpr, { source: 'event_output' }>, 'value'>,
  ) {
    if (this.events.length >= 100) throw new DomainError('Trajectory tool budget exceeded.', 429);
    authorizeContext(this.options.context, this.options.input);
    let value: string;
    if (binding.source === 'task_input') value = this.options.input.customerId;
    else {
      const producer = this.events.find((event) => event.eventId === binding.ref.producerEventId);
      if (producer?.status !== 'success' || !producer.result)
        throw new DomainError('Missing successful value producer.', 409);
      value = (producer.result.projection as { customerId: string }).customerId;
    }
    const event: ToolEvent = {
      eventId: randomUUID(),
      traceId: this.traceId,
      principalId: this.options.context.principalId,
      startMs: Math.ceil(performance.now() - this.started),
      endMs: 0,
      adapterId: operation.split('.')[0],
      adapterVersion: contracts[operation].version,
      operation,
      args: { customerId: { ...binding, value } },
      status: 'success',
      effect: 'read',
      reads: [
        {
          system: operation.split('.')[0],
          kind: contracts[operation].schemaId,
          key: value,
          observedVersion: this.options.context.snapshot,
        },
      ],
      writes: [],
      policyVersion: this.options.context.policyVersion,
      credentialScopeIds: [contracts[operation].scope],
    };
    this.measurement.toolCalls! += 1;
    try {
      const signal = AbortSignal.timeout(5000);
      const raw = await bounded(
        () => this.options.adapters(operation, { customerId: value }, this.options.context, signal),
        signal,
      );
      const projection = contracts[operation].output.parse(raw);
      if (
        projection.customerId !== value ||
        projection.tenantId !== this.options.context.tenantId ||
        projection.snapshot !== this.options.context.snapshot
      )
        throw new DomainError('Adapter identity mismatch.', 409);
      event.result = { schemaId: contracts[operation].schemaId, projection };
      return { eventId: event.eventId, value: projection };
    } catch (error) {
      event.status = 'failed';
      event.errorClass = 'adapter_failure';
      throw error;
    } finally {
      event.endMs = Math.max(event.startMs, Math.ceil(performance.now() - this.started));
      this.events.push(event);
    }
  }
  async modelCall<T>(fn: () => Promise<{ value: T; usage?: ReportedUsage }>): Promise<T> {
    if (this.modelEvents.length >= 100)
      throw new DomainError('Trajectory model budget exceeded.', 429);
    const event: NonNullable<ToolTrace['modelEvents']>[number] = {
      id: randomUUID(),
      provider: this.options.provider ?? 'unknown',
      model: this.options.model ?? 'unknown',
      startMs: performance.now() - this.started,
      endMs: 0,
      status: 'success',
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
    };
    this.measurement.modelCalls! += 1;
    try {
      const result = await fn();
      if (result.usage) {
        const usage = reportedUsageSchema.parse(result.usage);
        event.inputTokens = usage.inputTokens;
        event.outputTokens = usage.outputTokens;
        event.cachedInputTokens = usage.cachedInputTokens ?? null;
        event.costUsd = usage.costUsd ?? null;
      }
      return result.value;
    } catch (error) {
      event.status = 'failed';
      throw error;
    } finally {
      event.endMs = performance.now() - this.started;
      this.modelEvents.push(event);
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
        this.measurement[key] =
          this.measurement[key] === null || event[key] === null
            ? null
            : this.measurement[key] + event[key];
      }
      this.measurement.totalTokens =
        this.measurement.inputTokens === null || this.measurement.outputTokens === null
          ? null
          : this.measurement.inputTokens + this.measurement.outputTokens;
      this.measurement.costUsd = this.modelEvents.every((entry) => entry.costUsd !== null)
        ? this.modelEvents.reduce((sum, entry) => sum + entry.costUsd!, 0)
        : null;
    }
  }
  finish(result: unknown): StoredToolTrace {
    this.measurement.durationMs = performance.now() - this.started;
    contextProjection(result);
    this.measurement.outcome = 'success';
    return captureToolTrace(
      {
        traceId: this.traceId,
        taskKind: 'customer_context',
        task: 'Observed customer context task.',
        agentModel: this.options.model ?? 'unknown',
        provider: this.options.provider,
        tenantId: this.options.context.tenantId,
        principalId: this.options.context.principalId,
        agentId: this.options.agentId,
        snapshot: this.options.context.snapshot,
        policyVersion: this.options.context.policyVersion,
        taskInput: this.options.input,
        status: 'success',
        llmInvocations: this.measurement.modelCalls ?? 0,
        agentTokens: this.measurement.totalTokens ?? 0,
        durationMs: Math.max(this.measurement.durationMs, 0.001),
        events: this.events,
        modelEvents: this.modelEvents,
        measurement: this.measurement,
        privacyMode: this.options.privacyMode ?? 'minimal',
        observableResult: normalizeObservable(result),
      },
      'import',
    );
  }
  finishFailure(): StoredToolTrace {
    this.measurement.durationMs = performance.now() - this.started;
    this.measurement.outcome = 'failed';
    return captureToolTrace(
      {
        traceId: this.traceId,
        taskKind: 'customer_context',
        task: 'Observed failed customer context task.',
        agentModel: this.options.model ?? 'unknown',
        tenantId: this.options.context.tenantId,
        principalId: this.options.context.principalId,
        agentId: this.options.agentId,
        snapshot: this.options.context.snapshot,
        policyVersion: this.options.context.policyVersion,
        taskInput: this.options.input,
        status: 'failed',
        llmInvocations: this.measurement.modelCalls ?? 0,
        agentTokens: this.measurement.totalTokens ?? 0,
        durationMs: Math.max(this.measurement.durationMs, 0.001),
        events: this.events,
        modelEvents: this.modelEvents,
        measurement: this.measurement,
        observableResult: {
          customerId: this.options.input.customerId,
          eligible: false,
          orderCount: 0,
          refundCount: 0,
          refundTotal: 0,
        },
      },
      'import',
    );
  }
  exportStructural() {
    return {
      traceId: this.traceId,
      tenantId: this.options.context.tenantId,
      taskKind: 'customer_context',
      events: this.events.map(structuralEvent),
      measurement: this.measurement,
    };
  }
}
