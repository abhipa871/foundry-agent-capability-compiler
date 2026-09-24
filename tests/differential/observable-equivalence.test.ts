import { describe, expect, it } from 'vitest';
import { compileIR } from '../../src/compiler/compile-ir.js';
import { assertDigest, emitArtifact } from '../../src/compiler/emit.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { captureToolTrace } from '../../src/exploration/tool-events.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import { interpret } from '../../src/runtime/interpret.js';
import { differences } from '../../src/verification/equivalence.js';
import { verifyIR } from '../../src/verification/verify-ir.js';

const traces = () => sampleToolTraces.map((trace) => captureToolTrace(trace, 'demo'));
function candidate() {
  const stored = traces();
  const { ir, report } = compileIR(stored);
  return { stored, artifact: emitArtifact(ir, report, { version: 1 }) };
}

describe('compiled versus recorded behaviour', () => {
  it('reproduces the observable result of every supporting trace', async () => {
    const { stored, artifact } = candidate();

    for (const trace of stored) {
      const run = await interpret(artifact.ir, trace.taskInput, {
        adapters: mockAdapters(),
        context: localContext(),
      });
      expect(differences(run.observable, trace.observableResult)).toEqual([]);
    }
  });

  it('uses fewer tool calls than the trajectories it was compiled from', async () => {
    const { stored, artifact } = candidate();
    const recordedReads = stored[0].events.filter(
      (event) => event.status === 'success' && event.effect === 'read',
    ).length;
    const run = await interpret(
      artifact.ir,
      { customerId: 'C-101' },
      {
        adapters: mockAdapters(),
        context: localContext(),
      },
    );

    expect(recordedReads).toBe(4);
    expect(run.adapterCalls).toBe(3);
    expect(run.llmInvocations).toBe(0);
  });

  it('passes the full verification suite against the candidate artifact', async () => {
    const { stored, artifact } = candidate();
    const checks = await verifyIR(artifact, stored);

    expect(checks.length).toBeGreaterThan(15);
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    expect(new Set(checks.map((check) => check.category))).toEqual(
      new Set(['schema', 'sandbox', 'policy', 'failure', 'regression']),
    );
  });

  it('detects a tampered artifact before it can run', () => {
    const { artifact } = candidate();

    expect(() =>
      assertDigest({ ...artifact, ir: { ...artifact.ir, concurrency: 1 } }),
    ).toThrowError(/digest/);
    expect(assertDigest(artifact).digest).toBe(artifact.digest);
  });

  it('keeps the recorded trace cost separate from the compiled cost', () => {
    const { stored } = candidate();

    // The traces carry their own exploration cost; it is evidence about the agent path, never
    // a measurement of the compiled path, which performs no inference at all.
    expect(stored.every((trace) => trace.llmInvocations > 0)).toBe(true);
    expect(stored.every((trace) => trace.agentTokens > 0)).toBe(true);
  });
});
