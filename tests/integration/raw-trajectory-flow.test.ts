import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../../src/domain.js';
import { sampleRawAgentTrajectory } from '../../src/exploration/capture.js';
import { Store } from '../../src/registry/store.js';
import { Foundry } from '../../src/service.js';

describe('raw trajectory to deterministic capability flow', () => {
  it('prunes failed branches before deployment and runtime execution', () => {
    const store = new Store(':memory:');
    try {
      const service = new Foundry(store);
      const trace = service.captureRaw(sampleRawAgentTrajectory, 'import');
      const draft = service.compile(trace.id, defaultPolicy);
      const verified = service.verify(draft.id);
      const approved = service.approve(verified.id, 'Reviewed branch pruning and sandbox checks.');
      const run = service.run(approved.id, { delay_days: 5, credit_amount: 20 }, 'raw-flow-1');

      expect(trace.branchAnalysis?.discarded.length).toBeGreaterThan(0);
      expect(approved.discardedBranches?.some((event) => event.status === 'failed')).toBe(true);
      expect(verified.checks.every((check) => check.passed)).toBe(true);
      expect(run.status).toBe('success');
      expect(run.output?.customers).toBe(3);
      expect(store.credited()).toEqual(new Set(['SHP-1001', 'SHP-1002', 'SHP-1003']));
    } finally {
      store.close();
    }
  });
});
