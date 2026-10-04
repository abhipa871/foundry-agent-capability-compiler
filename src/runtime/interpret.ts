import { performance } from 'node:perf_hooks';
import { DomainError } from '../domain.js';
import {
  customerInput,
  validateIR,
  resolveExpression,
  type CapabilityIR,
  type IRNode,
} from '../compiler/ir.js';
import type { ObservableResult } from '../exploration/tool-events.js';
import { schedule } from '../compiler/passes/schedule.js';
import { contracts, type AdapterRunner, type RuntimeContext } from './adapters/registry.js';
import { bounded } from './bounded.js';
import { contextProjection, normalizeObservable } from './observable.js';

export type NodeTiming = { id: string; operation?: string; startMs: number; endMs: number };
export type CompiledRun = {
  result: Record<string, unknown>;
  observable: ObservableResult;
  executedNodeIds: string[];
  nodeTimings: NodeTiming[];
  adapterCalls: number;
  peakParallel: number;
  llmInvocations: 0;
  durationMs: number;
  observedResources: { system: string; kind: string; key: string; observedVersion: string }[];
};
export type DeoptReason = 'guard_miss' | 'adapter_drift' | 'unsupported_state' | 'runtime_failure';
export class DeoptimizationError extends Error {
  constructor(
    message: string,
    readonly detail: {
      nodeId: string;
      reason: DeoptReason;
      completedNodeIds: string[];
      nextNodeIds: string[];
      liveValues: Record<string, unknown>;
      observedResources: CompiledRun['observedResources'];
      status: number;
      adapterCalls: number;
      peakParallel: number;
      nodeTimings: NodeTiming[];
      durationMs: number;
    },
  ) {
    super(message);
  }
}

// The only executor for compiled capabilities. It walks compiler-owned IR through trusted
// adapters: no eval, no generated source, no network, no credentials, and no model calls.
// `llmInvocations` is 0 by construction, not by measurement of a model that was never asked.
export async function interpret(
  ir: CapabilityIR,
  rawInput: unknown,
  options: { adapters: AdapterRunner; context: RuntimeContext; signal?: AbortSignal },
): Promise<CompiledRun> {
  ir = validateIR(ir);
  const input = customerInput.parse(rawInput);
  const started = performance.now();
  const values = new Map<string, unknown>();
  const executedNodeIds: string[] = [];
  const nodeTimings: NodeTiming[] = [];
  const observedResources: CompiledRun['observedResources'] = [];
  const byId = new Map(ir.nodes.map((node) => [node.id, node]));
  const levels = schedule(
    ir.nodes.map((node) => ({ id: node.id, deps: node.deps })),
    ir.concurrency,
  ).levels;
  const timeout = AbortSignal.timeout(ir.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let adapterCalls = 0;
  let inFlight = 0;
  let peakParallel = 0;
  const remaining = () => ir.nodes.filter((node) => !values.has(node.id)).map((node) => node.id);
  const fail = (nodeId: string, error: unknown): never => {
    const status = error instanceof DomainError ? error.status : signal.aborted ? 504 : 500;
    throw new DeoptimizationError(
      error instanceof Error ? error.message : 'Compiled execution failed.',
      {
        nodeId,
        reason: classify(error, signal),
        completedNodeIds: [...executedNodeIds],
        nextNodeIds: remaining(),
        liveValues: Object.fromEntries(values),
        observedResources,
        status,
        adapterCalls,
        peakParallel,
        nodeTimings: [...nodeTimings],
        durationMs: performance.now() - started,
      },
    );
  };
  for (const level of levels) {
    const settled = await runPool(level, ir.concurrency, async (id) => {
      const node = byId.get(id)!;
      const nodeStart = performance.now();
      inFlight += 1;
      peakParallel = Math.max(peakParallel, inFlight);
      try {
        values.set(
          id,
          await runNode(node, input, values, ir, options, signal, () => {
            adapterCalls += 1;
          }),
        );
        if (node.opcode === 'adapter.read')
          observedResources.push({
            system: node.operation.split('.')[0],
            kind: node.outputSchemaId,
            key: input.customerId,
            observedVersion: options.context.snapshot,
          });
        executedNodeIds.push(id);
        nodeTimings.push({
          id,
          operation: node.opcode === 'adapter.read' ? node.operation : 'join',
          startMs: Math.round(nodeStart - started),
          endMs: Math.round(performance.now() - started),
        });
      } finally {
        inFlight -= 1;
      }
    });
    const rejected = settled.find((entry) => entry.status === 'rejected');
    if (rejected && rejected.status === 'rejected')
      fail(level.find((id) => !values.has(id)) ?? level[0], rejected.reason);
  }
  const result = values.get(ir.outputNode) as Record<string, unknown>;
  try {
    contextProjection(result);
    const observable = normalizeObservable(result);
    if (observable.customerId !== input.customerId)
      throw new DomainError('Output invariant customer_id_matches failed.', 409);
    return {
      result,
      observable,
      executedNodeIds,
      nodeTimings,
      adapterCalls,
      peakParallel,
      llmInvocations: 0,
      durationMs: performance.now() - started,
      observedResources,
    };
  } catch (error) {
    return fail(ir.outputNode, error);
  }
}

// Independent nodes run together only up to the concurrency the compiler recorded, which is
// bounded by the adapters' rate-limit contract rather than by how fast the fixtures answer.
async function runPool(
  ids: string[],
  limit: number,
  worker: (id: string) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  const queue = ids.map((id, index) => ({ id, index }));
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, ids.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        await worker(next.id);
        results[next.index] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        results[next.index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

async function runNode(
  node: IRNode,
  input: { customerId: string },
  values: Map<string, unknown>,
  ir: CapabilityIR,
  options: { adapters: AdapterRunner; context: RuntimeContext },
  signal: AbortSignal,
  onAdapterCall: () => void,
): Promise<unknown> {
  if (node.opcode === 'join') {
    return Object.fromEntries(
      Object.entries(node.args).map(([key, expr]) => [key, resolveExpression(expr, input, values)]),
    );
  }
  const contract = contracts[node.operation];
  if (
    !options.context.scopes.includes(contract.scope) ||
    !node.requiredScopes.every((scope) => options.context.scopes.includes(scope))
  )
    throw new DomainError(`Missing scope for ${node.operation}.`, 403);
  const customerId = resolveExpression(node.args.customerId, input, values);
  if (typeof customerId !== 'string')
    throw new DomainError(`Resolved argument for ${node.operation} is not a customer id.`, 409);
  onAdapterCall();
  if (
    options.context.allowedCustomerIds &&
    !options.context.allowedCustomerIds.includes(customerId)
  )
    throw new DomainError('Customer permission denied.', 403);
  const raw = await bounded(
    () => options.adapters(node.operation, { customerId }, options.context, signal),
    signal,
  );
  const parsed = contract.output.safeParse(raw);
  if (!parsed.success)
    throw new DomainError(`${node.operation} returned a value outside ${contract.schemaId}.`, 409);
  const value = parsed.data;
  if (value.customerId !== input.customerId)
    throw new DomainError(`Invariant customer_id_matches failed on ${node.operation}.`, 409);
  if (value.tenantId !== ir.guards.tenantId)
    throw new DomainError(`Invariant tenant_matches failed on ${node.operation}.`, 409);
  if (value.snapshot !== ir.guards.snapshot)
    throw new DomainError(`Invariant snapshot_matches failed on ${node.operation}.`, 409);
  return value;
}

function classify(error: unknown, signal: AbortSignal): DeoptReason {
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError'))
    return 'runtime_failure';
  if (error instanceof DomainError) {
    if (error.status === 403) return 'guard_miss';
    if (error.message.includes('drift')) return 'adapter_drift';
    if (error.message.includes('outside supported')) return 'unsupported_state';
  }
  return 'runtime_failure';
}
