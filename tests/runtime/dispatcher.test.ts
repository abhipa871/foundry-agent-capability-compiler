import { describe, expect, it, vi } from 'vitest';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { emitArtifact } from '../../src/compiler/emit.js';
import type { IRArtifact } from '../../src/compiler/ir.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import { checkGuards, dispatch } from '../../src/runtime/dispatcher.js';

function approvedArtifact(): IRArtifact {
  const traces = sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo'));
  const { ir, report } = compileIR(traces);
  const artifact = emitArtifact(ir, report, { version: 1 });
  return { ...artifact, status: 'approved', approvedDigest: artifact.digest };
}
const request = (customerId: string) => ({
  kind: 'customer_context',
  input: { customerId },
});

describe('guarded dispatcher', () => {
  it('runs the compiled fast path when every guard holds', async () => {
    const outcome = await dispatch(request('C-101'), [approvedArtifact()], {
      adapters: mockAdapters(),
      context: localContext(),
    });

    expect(outcome.mode).toBe('compiled');
    expect(outcome.llmInvocations).toBe(0);
    expect(outcome.guards.every((guard) => guard.ok)).toBe(true);
    expect(outcome.observable?.customerId).toBe('C-101');
    expect(outcome.checkpoint).toBeUndefined();
  });

  it('never touches an adapter when a guard fails', async () => {
    const calls = vi.fn();
    const context = localContext();
    const outcome = await dispatch(request('C-101'), [approvedArtifact()], {
      adapters: mockAdapters({ onCall: calls }),
      context: { ...context, adapterVersions: { ...context.adapterVersions, 'orders.list': '2' } },
    });

    expect(outcome.mode).toBe('agent');
    expect(outcome.fallbackReason).toBe('guard_miss');
    expect(outcome.fallbackDetail).toContain('adapter_versions');
    expect(calls).not.toHaveBeenCalled();
  });

  it('refuses an artifact that was never approved', async () => {
    const artifact = approvedArtifact();
    const outcome = await dispatch(
      request('C-101'),
      [{ ...artifact, status: 'draft', approvedDigest: undefined }],
      { adapters: mockAdapters(), context: localContext() },
    );

    expect(outcome.mode).toBe('agent');
    expect(outcome.guards.find((guard) => guard.name === 'artifact_status')?.ok).toBe(false);
  });

  it('refuses an artifact whose IR no longer matches its approved digest', async () => {
    const artifact = approvedArtifact();
    const tampered: IRArtifact = {
      ...artifact,
      ir: { ...artifact.ir, timeoutMs: artifact.ir.timeoutMs + 1 },
    };
    const outcome = await dispatch(request('C-101'), [tampered], {
      adapters: mockAdapters(),
      context: localContext(),
    });

    expect(outcome.mode).toBe('agent');
    expect(outcome.guards.find((guard) => guard.name === 'artifact_digest')?.ok).toBe(false);
  });

  it('falls back without a candidate when the task kind does not match', async () => {
    const outcome = await dispatch(
      { kind: 'refund_decision', input: { customerId: 'C-101' } },
      [approvedArtifact()],
      { adapters: mockAdapters(), context: localContext() },
    );

    expect(outcome.mode).toBe('agent');
    expect(outcome.fallbackReason).toBe('no_candidate');
  });

  it('rejects a stale observation window', () => {
    const artifact = approvedArtifact();
    const context = localContext();
    const guards = checkGuards(artifact, request('C-101'), {
      ...context,
      observedAt: context.observedAt - artifact.ir.guards.maxAgeMs - 1,
    });

    expect(guards.find((guard) => guard.name === 'data_freshness')?.ok).toBe(false);
  });

  it('hands an unsupported input to the agent with a precise checkpoint', async () => {
    const agent = vi.fn().mockResolvedValue({
      summary: 'Operator resolved the unknown account manually.',
      llmInvocations: 4,
      tokens: 5200,
      resolved: true,
    });
    const outcome = await dispatch(request('C-404'), [approvedArtifact()], {
      adapters: mockAdapters(),
      context: localContext(),
      agent,
    });

    expect(outcome.mode).toBe('agent');
    expect(outcome.fallbackReason).toBe('unsupported_state');
    expect(outcome.checkpoint?.completedEffects).toEqual([]);
    expect(outcome.checkpoint?.nextNodeIds).toContain('context');
    expect(outcome.llmInvocations).toBe(4);
    expect(outcome.result).toBeUndefined();
    expect(agent).toHaveBeenCalledWith(request('C-404'), outcome.checkpoint);
  });

  it('reports no model usage of its own when no agent is wired in', async () => {
    const outcome = await dispatch(request('C-404'), [approvedArtifact()], {
      adapters: mockAdapters(),
      context: localContext(),
    });

    expect(outcome.mode).toBe('agent');
    expect(outcome.agentSummary).toBeUndefined();
    expect(outcome.llmInvocations).toBe(0);
    expect(outcome.checkpoint?.reason).toBe('unsupported_state');
  });

  it('prefers the newest approved version', async () => {
    const v1 = approvedArtifact();
    const v2: IRArtifact = { ...v1, id: `${v1.id}-2`, version: 2 };
    const outcome = await dispatch(request('C-202'), [v1, v2], {
      adapters: mockAdapters(),
      context: localContext(),
    });

    expect(outcome.capabilityVersion).toBe(2);
    expect(outcome.mode).toBe('compiled');
  });
});
