import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../../src/domain.js';
import { compile } from '../../src/compiler/compile.js';
import {
  captureRaw,
  pruneAgenticBranches,
  sampleRawAgentTrajectory,
} from '../../src/exploration/capture.js';
import { verify } from '../../src/verification/verify.js';

describe('agentic branch pruning', () => {
  it('keeps only the successful causal tool path', () => {
    const trace = captureRaw(sampleRawAgentTrajectory, 'import');

    expect(trace.steps.map((step) => step.operation)).toEqual([
      'shipments.list',
      'credits.issue',
      'crm.update',
      'notifications.send',
    ]);
    expect(trace.branchAnalysis?.strategy).toBe('lineage');
    expect(trace.branchAnalysis?.keptEventIds).toEqual([
      'shipments_success',
      'credit_success',
      'crm_success',
      'notify_success',
    ]);
    expect(trace.branchAnalysis?.discarded.map((event) => event.eventId)).toContain(
      'crm_wrong_tool',
    );
    expect(trace.branchAnalysis?.discarded.map((event) => event.eventId)).toContain(
      'spreadsheet_branch',
    );
  });

  it('turns discarded raw branches into capability provenance and verification', () => {
    const trace = captureRaw(sampleRawAgentTrajectory, 'import');
    const cap = compile(trace, defaultPolicy, 1, 1);
    const checks = verify(cap, 1);

    expect(cap.sourceEventIds).toEqual(trace.branchAnalysis?.keptEventIds);
    expect(cap.discardedBranches?.length).toBe(trace.branchAnalysis?.discarded.length);
    const branchCheck = checks.find(
      (check) => check.name === 'Failed and abandoned raw branches excluded',
    );
    expect(branchCheck?.passed).toBe(true);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it('rejects raw logs that never reach the full supported path', () => {
    const incomplete = {
      ...sampleRawAgentTrajectory,
      events: sampleRawAgentTrajectory.events.map((event) =>
        event.id === 'crm_success' ? { ...event, status: 'failed' as const } : event,
      ),
    };

    expect(() => pruneAgenticBranches(incomplete)).toThrow('complete successful causal path');
  });
});
