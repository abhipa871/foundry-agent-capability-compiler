import { customerInput, type ReadOperation } from '../compiler/ir.js';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TrajectoryObserver } from '../exploration/observe.js';
import { replayTrace } from '../exploration/tool-events.js';
import {
  authorizeContext,
  authorizeReads,
  type AdapterRunner,
  type RuntimeContext,
} from '../runtime/adapters/registry.js';
import { resourceSelectionSchema } from '../runtime/selective.js';
import type { ExecutionSelection } from './selection.js';
import {
  dispatch,
  AgentExecutionError,
  type AgentFallback,
  type DispatchOutcome,
  type TaskRequest,
} from '../runtime/dispatcher.js';
import { shadowExecute } from '../runtime/shadow.js';
import { bounded } from '../runtime/bounded.js';
import {
  runtimeArtifact,
  verifyTicket,
  type ClientTelemetry,
  type RuntimeTicket,
} from './protocol.js';
import type { ExecutionCheckpoint } from '../runtime/checkpoint.js';
import { emptyMeasurement } from '../telemetry/measurement.js';

export type CustomerAgent = (
  request: TaskRequest,
  checkpoint: ExecutionCheckpoint | undefined,
  observer: TrajectoryObserver | undefined,
) => ReturnType<AgentFallback>;
export type ClientOptions = {
  tenantId: string;
  principalId: string;
  agentId: string;
  adapters: AdapterRunner;
  context: () => RuntimeContext;
  native: CustomerAgent;
  provider?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  trustedPublicKey?: string;
  fetch?: typeof fetch;
  shareReplayEvidence?: boolean;
  networkTimeoutMs?: number;
};

// One application integration owns both paths. Compiler, matcher, registry policy and validation
// intelligence stay server-side. Caller tool credentials remain inside the supplied adapters.
export class FoundryClient {
  constructor(private readonly options: ClientOptions) {
    if (options.endpoint) {
      const url = new URL(options.endpoint);
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        throw new Error('Optimization endpoint requires HTTPS or loopback.');
      if (url.username || url.password || url.search || url.hash)
        throw new Error('Endpoint cannot contain credentials or query data.');
      if (!options.apiKey || !options.trustedPublicKey)
        throw new Error('API key and pinned Ed25519 public key required.');
    }
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const signal = AbortSignal.timeout(this.options.networkTimeoutMs ?? 1000);
    const response = await bounded(
      () =>
        (this.options.fetch ?? fetch)(`${this.options.endpoint}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal,
          redirect: 'error',
        }),
      signal,
    );
    if (!response.ok) throw new Error('Optimization API unavailable.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Optimization response body missing.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await bounded(() => reader.read(), signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 131072) throw new Error('Optimization response exceeds budget.');
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  // `resources` opts into selective execution of the approved capability; `selection` is the
  // application's selector decision, recorded in telemetry only.
  async execute(
    request: TaskRequest,
    execution: {
      fallback?: 'native' | 'defer';
      resources?: readonly ReadOperation[];
      selection?: ExecutionSelection;
    } = {},
  ): Promise<DispatchOutcome> {
    const started = performance.now();
    const resources =
      execution.resources === undefined
        ? undefined
        : resourceSelectionSchema.parse(execution.resources);
    let apiCalls = 0;
    const remote = (path: string, body?: unknown) => {
      apiCalls += 1;
      return this.request(path, body);
    };
    const context = this.options.context();
    // Caller identity is not inferred from the task or a downloaded artifact.
    if (
      context.tenantId !== this.options.tenantId ||
      context.principalId !== this.options.principalId
    )
      throw new Error('Customer runtime identity mismatch.');
    const parsedInput = customerInput.safeParse(request.input);
    const observer =
      request.kind === 'customer_context' && parsedInput.success
        ? new TrajectoryObserver({
            input: parsedInput.data!,
            context,
            adapters: this.options.adapters,
            agentId: this.options.agentId,
            provider: this.options.provider,
            model: this.options.model,
            allowedOperations: resources,
          })
        : undefined;
    const native: AgentFallback = async (task, checkpoint) => {
      if (execution.fallback === 'defer')
        return {
          resolved: false,
          summary: 'Caller retains authoritative agent execution.',
          llmInvocations: 0,
          tokens: 0,
          toolCalls: 0,
          measurement: { ...emptyMeasurement(), outcome: 'unresolved' },
        };
      let result: Awaited<ReturnType<CustomerAgent>>;
      try {
        result = await this.options.native(task, checkpoint, observer);
      } catch (error) {
        if (error instanceof AgentExecutionError) throw error;
        if (!observer) throw new Error('Native execution failed.');
        const measured = observer.finishFailure().measurement!;
        throw new AgentExecutionError({
          ...measured,
          modelCalls: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
        });
      }
      if (result.resolved && result.result && observer?.events.length) {
        let trace;
        try {
          trace = observer.finish(result.result);
        } catch {
          return result;
        } // Optional telemetry must not replace an authoritative native result.
        trace.measurement =
          result.measurement ??
          (observer.modelEvents.length >= result.llmInvocations
            ? trace.measurement
            : {
                ...trace.measurement!,
                inputTokens: null,
                outputTokens: null,
                cachedInputTokens: null,
                totalTokens: result.tokens,
                modelCalls: result.llmInvocations,
                costUsd: null,
              });
        trace.measurement!.toolCalls = observer.events.length;
        if (this.options.endpoint && this.options.shareReplayEvidence)
          try {
            await remote('/api/v2/traces', replayTrace(trace));
          } catch {
            /* best effort */
          }
        return {
          ...result,
          measurement: trace.measurement,
          toolCalls: trace.measurement?.toolCalls ?? undefined,
        };
      }
      return observer?.events.length ? { ...result, toolCalls: observer.events.length } : result;
    };
    let ticket: RuntimeTicket | undefined;
    try {
      if (resources) authorizeReads(context, request.input, resources);
      else authorizeContext(context, request.input);
      if (request.kind === 'customer_context' && this.options.endpoint)
        ticket = verifyTicket(
          await remote('/api/v2/runtime/capability'),
          this.options.trustedPublicKey!,
          this.options,
        );
    } catch {
      /* API and artifact failures select the guarded native path below. */
    }
    const bucket =
      parseInt(createHash('sha256').update(randomUUID()).digest('hex').slice(0, 8), 16) % 100;
    const selected =
      ticket?.artifact && bucket < ticket.rolloutPercent
        ? runtimeArtifact(ticket.artifact)
        : undefined;
    let result: DispatchOutcome;
    let shadowStatus: ClientTelemetry['shadowStatus'];
    // Shadow evidence compares full contexts, so a subset request never runs a compiled shadow.
    if (ticket?.mode === 'shadow' && selected && execution.fallback !== 'defer' && !resources) {
      const run = await shadowExecute(request, selected, {
        adapters: this.options.adapters,
        context,
        agent: native,
      });
      result = run.authoritative;
      shadowStatus = run.shadow.status;
    } else {
      result = await dispatch(request, ticket?.mode === 'live' && selected ? [selected] : [], {
        adapters: this.options.adapters,
        context,
        agent: native,
        resources,
      });
    }
    // An approved plan that cannot serve a subset was not attempted; it is not a capability fault.
    const selectionMiss = result.guards.some(
      (entry) => entry.name === 'resource_selection' && !entry.ok,
    );
    if (result.measurement.apiCalls !== null) result.measurement.apiCalls += apiCalls;
    result.durationMs = performance.now() - started;
    result.measurement.durationMs = result.durationMs;
    if (this.options.endpoint && observer) {
      const summary = observer.exportStructural();
      if (result.measurement.apiCalls !== null) result.measurement.apiCalls += 1;
      const telemetry: ClientTelemetry = {
        ...summary,
        taskKind: 'customer_context',
        principalId: this.options.principalId,
        agentId: this.options.agentId,
        measurement: result.measurement,
        routingMode: ticket?.mode ?? 'observe',
        capabilityId: selected?.id,
        capabilityDigest: selected?.digest,
        runtimeStatus:
          result.outcome === 'denied'
            ? 'denied'
            : result.mode === 'compiled'
              ? 'compiled'
              : ticket?.mode === 'live' && selected && !selectionMiss
                ? 'fallback'
                : 'native',
        shadowStatus,
        events: summary.events as ClientTelemetry['events'],
        // Older control planes reject unknown telemetry fields, so they are sent only on opt-in.
        ...(resources || execution.selection
          ? {
              selection: {
                ...(execution.selection
                  ? {
                      mode: execution.selection.mode,
                      reason: execution.selection.reason.slice(0, 80),
                      durationMs: execution.selection.durationMs,
                    }
                  : {}),
                resources: result.selection?.resources ?? resources ?? [],
                prerequisites: result.selection?.prerequisites ?? [],
                ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
              },
            }
          : {}),
      };
      try {
        await remote('/api/v2/telemetry', telemetry);
      } catch {
        /* never fail customer work for telemetry */
      }
    }
    result.durationMs = performance.now() - started;
    result.measurement.durationMs = result.durationMs;
    return result;
  }
}
export type { TaskRequest, DispatchOutcome, AdapterRunner, RuntimeContext };
export { TrajectoryObserver };
export { defineContextContract, selectExecution } from './selection.js';
export type { ContextContract, ExecutionSelection } from './selection.js';
export { RequestReadCache } from './request-reads.js';
export { planSelection, subsetContextProjection } from '../runtime/selective.js';
export type { SelectionPlan, SubsetContext } from '../runtime/selective.js';
