import { randomUUID } from 'node:crypto';
import { redact } from '../exploration/tool-events.js';
import type { IRArtifact } from '../compiler/ir.js';
import type { CompiledRun, DeoptReason } from './interpret.js';

// A read-only capability commits no external effects, so `completedEffects` is empty by
// construction. The field exists because the ledger is where write capabilities will record
// provider receipts; an empty list here is a fact about this capability, not a guarantee that
// external writes are reversible.
export type EffectReceipt = {
  operation: string;
  idempotencyKey: string;
  state: 'planned' | 'in_flight' | 'confirmed' | 'unknown' | 'compensated' | 'failed';
  providerReference?: string;
};
export type ExecutionCheckpoint = {
  id: string;
  runId: string;
  capabilityId: string;
  capabilityName: string;
  capabilityVersion: number;
  capabilityDigest: string;
  createdAt: string;
  taskKind: string;
  input: unknown;
  failedNodeId?: string;
  completedNodeIds: string[];
  nextNodeIds: string[];
  liveValues: Record<string, unknown>;
  observedResourceVersions: CompiledRun['observedResources'];
  completedEffects: EffectReceipt[];
  pendingEffects: EffectReceipt[];
  reason: DeoptReason;
  detail: string;
  resolution?: { at: string; by: 'agent' | 'operator'; note: string; traceId?: string };
};

export function buildCheckpoint(input: {
  runId: string;
  artifact: IRArtifact;
  taskInput: unknown;
  reason: DeoptReason;
  detail: string;
  failedNodeId?: string;
  completedNodeIds?: string[];
  nextNodeIds?: string[];
  liveValues?: Record<string, unknown>;
  observedResourceVersions?: CompiledRun['observedResources'];
}): ExecutionCheckpoint {
  return {
    id: randomUUID(),
    runId: input.runId,
    capabilityId: input.artifact.id,
    capabilityName: input.artifact.name,
    capabilityVersion: input.artifact.version,
    capabilityDigest: input.artifact.digest,
    createdAt: new Date().toISOString(),
    taskKind: input.artifact.taskKind,
    input: input.taskInput,
    failedNodeId: input.failedNodeId,
    completedNodeIds: input.completedNodeIds ?? [],
    nextNodeIds: input.nextNodeIds ?? input.artifact.ir.nodes.map((node) => node.id),
    liveValues: (redact(input.liveValues ?? {}) ?? {}) as Record<string, unknown>,
    observedResourceVersions: input.observedResourceVersions ?? [],
    completedEffects: [],
    pendingEffects: [],
    reason: input.reason,
    detail: input.detail,
  };
}
