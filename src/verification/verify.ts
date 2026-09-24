import { performance } from 'node:perf_hooks';
import { defaultPolicy, type Capability, type Check } from '../domain.js';
import { executePlan } from '../runtime/execute.js';

export function verify(cap: Capability, contractVersion: number): Check[] {
  const input = { delay_days: 5, credit_amount: Math.min(20, cap.policy.maxCredit) };
  const safe = { ...cap, policy: { ...defaultPolicy } };
  const checks: Check[] = [];
  function check(name: string, category: Check['category'], fn: () => boolean) {
    const start = performance.now();
    try {
      const passed = fn();
      checks.push({
        name,
        category,
        passed,
        detail: passed ? 'Expected invariant satisfied' : 'Unexpected result',
        durationMs: performance.now() - start,
      });
    } catch (error) {
      checks.push({
        name,
        category,
        passed: false,
        detail: error instanceof Error ? error.message : 'Check failed',
        durationMs: performance.now() - start,
      });
    }
  }
  function rejects(fn: () => unknown, message: string) {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof Error && e.message.includes(message);
    }
  }
  const opts = { contractVersion };
  check('Valid inputs and eligible customers', 'sandbox', () => {
    const result = executePlan(cap, input, opts);
    return result.customers === 3 && result.totalCredit === 3 * input.credit_amount;
  });
  check('Malformed input rejected', 'schema', () =>
    rejects(() => executePlan(cap, { delay_days: -1, credit_amount: '20' }, opts), ''),
  );
  check('Unknown input properties rejected', 'schema', () =>
    rejects(() => executePlan(cap, { ...input, command: 'run' }, opts), ''),
  );
  check('Tampered operation plan rejected', 'schema', () =>
    rejects(
      () =>
        executePlan(
          { ...cap, operations: ['shipments.list'] as typeof cap.operations },
          input,
          opts,
        ),
      'compiler-owned',
    ),
  );
  check('Missing permissions denied', 'policy', () =>
    rejects(
      () => executePlan({ ...safe, policy: { ...defaultPolicy, scopes: [] } }, input, opts),
      'Missing permissions',
    ),
  );
  check('Credit limit enforced', 'policy', () =>
    rejects(() => executePlan(safe, { ...input, credit_amount: 51 }, opts), 'Per-customer'),
  );
  check('Aggregate budget enforced', 'policy', () =>
    rejects(
      () => executePlan({ ...safe, policy: { ...defaultPolicy, maxTotal: 10 } }, input, opts),
      'Total credit',
    ),
  );
  check('Timeout fails closed', 'failure', () =>
    rejects(() => executePlan(cap, input, { ...opts, fault: 'timeout' }), 'timed out'),
  );
  check('Partial failure returns no effects', 'failure', () =>
    rejects(
      () => executePlan(cap, input, { ...opts, fault: 'partial' }),
      'staged writes discarded',
    ),
  );
  check('Stale data rejected', 'failure', () =>
    rejects(() => executePlan(cap, input, { ...opts, fault: 'stale' }), 'Stale'),
  );
  check(
    'Transient error retries within bound',
    'failure',
    () => executePlan(cap, input, { ...opts, fault: 'transient' }).attempts === 2,
  );
  check(
    'Already credited shipments skipped',
    'regression',
    () =>
      executePlan(cap, input, { ...opts, existing: new Set(['SHP-1001', 'SHP-1002', 'SHP-1003']) })
        .customers === 0,
  );
  check('Strict delay boundary and eligibility', 'regression', () => {
    const result = executePlan(cap, input, opts);
    return result.effects.every((e) => ['SHP-1001', 'SHP-1002', 'SHP-1003'].includes(e.shipmentId));
  });
  if (cap.discardedBranches?.length) {
    check('Failed and abandoned raw branches excluded', 'regression', () => {
      const sourceEventIds = new Set(cap.sourceEventIds ?? []);
      return cap.discardedBranches!.every((event) => !sourceEventIds.has(event.eventId));
    });
  }
  return checks;
}
