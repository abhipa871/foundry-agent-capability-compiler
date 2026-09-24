import { performance } from 'node:perf_hooks';
import type { Check } from '../domain.js';
import { irDigest, validateIR, type CapabilityIR, type IRArtifact } from '../compiler/ir.js';
import { traceScopeIds, type StoredToolTrace } from '../exploration/tool-events.js';
import { localContext, mockAdapters, type RuntimeContext } from '../runtime/adapters/registry.js';
import { checkGuards } from '../runtime/dispatcher.js';
import { DeoptimizationError, interpret } from '../runtime/interpret.js';
import { differences } from './equivalence.js';

// Verification tests the candidate artifact itself: the IR that will execute, under the adapter
// contracts it pins. It compares normalized observable results against the source traces and
// against independently stated invariants, then proves the unsafe paths fail closed.
export async function verifyIR(
  artifact: IRArtifact,
  traces: StoredToolTrace[],
  options: { adapters?: typeof mockAdapters } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const build = options.adapters ?? mockAdapters;
  const supporting = traces.filter((trace) =>
    artifact.ir.provenance.traceIds.includes(trace.traceId),
  );
  async function check(name: string, category: Check['category'], fn: () => Promise<string>) {
    const start = performance.now();
    try {
      const detail = await fn();
      checks.push({
        name,
        category,
        passed: true,
        detail: summarize(detail),
        durationMs: performance.now() - start,
      });
    } catch (error) {
      checks.push({
        name,
        category,
        passed: false,
        detail: summarize(error instanceof Error ? error.message : 'Check failed'),
        durationMs: performance.now() - start,
      });
    }
  }
  const expect = (condition: boolean, message: string, detail: string) => {
    if (!condition) throw new Error(message);
    return detail;
  };
  const run = (
    ir: CapabilityIR,
    input: unknown,
    ctx?: Partial<RuntimeContext>,
    adapters = build(),
  ) => interpret(ir, input, { adapters, context: { ...localContext(), ...ctx } });
  const rejects = async (fn: () => Promise<unknown>, expected: string | string[]) => {
    const wanted = [expected].flat();
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return expect(
        wanted.some((term) => message.toLowerCase().includes(term.toLowerCase())),
        `Expected a rejection mentioning ${wanted.join(' or ')} but got: ${message}`,
        `rejected: ${message}`,
      );
    }
    throw new Error(
      `Expected a rejection mentioning ${wanted.join(' or ')} but the run succeeded.`,
    );
  };

  await check('IR structure and digest are intact', 'schema', async () => {
    validateIR(artifact.ir);
    return expect(
      irDigest(artifact.ir) === artifact.digest,
      'Artifact digest does not match its IR.',
      `digest ${artifact.digest.slice(0, 12)} matches the validated IR`,
    );
  });
  await check('Tampered IR changes the digest', 'schema', async () => {
    const tampered = {
      ...artifact.ir,
      guards: { ...artifact.ir.guards, maxAgeMs: artifact.ir.guards.maxAgeMs + 1 },
    };
    return expect(
      irDigest(tampered) !== artifact.digest,
      'Digest did not change after mutating the IR.',
      'a one-field mutation produces a different digest',
    );
  });
  for (const trace of supporting) {
    await check(
      `Observable result matches trace ${trace.taskInput.customerId}`,
      'sandbox',
      async () => {
        const result = await run(artifact.ir, trace.taskInput);
        const diff = differences(result.observable, trace.observableResult);
        return expect(
          diff.length === 0,
          `Compiled output diverged from the recorded trace: ${diff.join('; ')}`,
          `${JSON.stringify(result.observable)} equals the recorded observable result`,
        );
      },
    );
  }
  await check('Compiled region invokes no model', 'sandbox', async () => {
    const result = await run(artifact.ir, supporting[0]?.taskInput ?? { customerId: 'C-101' });
    return expect(
      result.llmInvocations === 0,
      'Compiled execution reported model invocations.',
      'LLM calls inside compiled portion: 0',
    );
  });
  await check('Distinct inputs produce distinct outputs', 'sandbox', async () => {
    const [a, b] = await Promise.all([
      run(artifact.ir, { customerId: 'C-101' }),
      run(artifact.ir, { customerId: 'C-202' }),
    ]);
    return expect(
      JSON.stringify(a.observable) !== JSON.stringify(b.observable),
      'The plan returned identical output for different customers.',
      'the same artifact returns customer-specific results',
    );
  });
  await check('Duplicate reads were eliminated', 'regression', async () => {
    const reads = artifact.ir.nodes.filter((node) => node.opcode === 'adapter.read').length;
    const result = await run(artifact.ir, { customerId: 'C-101' });
    return expect(
      result.adapterCalls === reads,
      `Expected ${reads} adapter calls, observed ${result.adapterCalls}.`,
      `${result.adapterCalls} adapter calls for ${reads} read nodes`,
    );
  });
  await check('Parallel schedule preserves results', 'regression', async () => {
    const parallel = await run(artifact.ir, { customerId: 'C-202' });
    const sequential = await run({ ...artifact.ir, concurrency: 1 }, { customerId: 'C-202' });
    return expect(
      differences(parallel.observable, sequential.observable).length === 0,
      'Parallel and sequential schedules disagree.',
      `concurrency ${artifact.ir.concurrency} matched a sequential run (peak parallel ${parallel.peakParallel})`,
    );
  });
  await check('Malformed input rejected', 'schema', () =>
    rejects(() => run(artifact.ir, { customerId: 'nope', extra: 1 }), 'invalid'),
  );
  await check('Missing scope denied', 'policy', () =>
    rejects(
      () => run(artifact.ir, { customerId: 'C-101' }, { scopes: ['crm:read'] }),
      'missing scope',
    ),
  );
  await check('Adapter drift rejected at the guard', 'policy', async () => {
    const promoted: IRArtifact = {
      ...artifact,
      status: 'approved',
      approvedDigest: artifact.digest,
    };
    const context = localContext();
    const guards = checkGuards(
      promoted,
      { kind: artifact.taskKind, input: { customerId: 'C-101' } },
      { ...context, adapterVersions: { ...context.adapterVersions, 'orders.list': '2' } },
    );
    return expect(
      guards.some((guard) => guard.name === 'adapter_versions' && !guard.ok),
      'A drifted adapter version passed the guard.',
      'adapter_versions guard fails closed on drift',
    );
  });
  await check('Stale observation rejected at the guard', 'policy', async () => {
    const promoted: IRArtifact = {
      ...artifact,
      status: 'approved',
      approvedDigest: artifact.digest,
    };
    const context = localContext();
    const guards = checkGuards(
      promoted,
      { kind: artifact.taskKind, input: { customerId: 'C-101' } },
      { ...context, observedAt: context.observedAt - artifact.ir.guards.maxAgeMs - 1000 },
    );
    return expect(
      guards.some((guard) => guard.name === 'data_freshness' && !guard.ok),
      'A stale observation passed the freshness guard.',
      `data_freshness guard enforces the ${artifact.ir.guards.maxAgeMs}ms window`,
    );
  });
  await check('Read timeout fails closed', 'failure', () =>
    rejects(
      () =>
        run(
          { ...artifact.ir, timeoutMs: 40 },
          { customerId: 'C-101' },
          undefined,
          build({ fault: 'timeout' }),
        ),
      'abort',
    ),
  );
  await check('Malformed adapter output rejected', 'failure', () =>
    rejects(
      () => run(artifact.ir, { customerId: 'C-101' }, undefined, build({ fault: 'malformed' })),
      'outside',
    ),
  );
  await check('Cross-customer response rejected', 'failure', () =>
    rejects(
      () =>
        run(artifact.ir, { customerId: 'C-101' }, undefined, build({ fault: 'wrong_customer' })),
      'customer_id_matches',
    ),
  );
  await check('Wrong data snapshot rejected', 'failure', () =>
    rejects(
      () =>
        run(artifact.ir, { customerId: 'C-101' }, undefined, build({ fault: 'wrong_snapshot' })),
      ['snapshot_matches', 'outside customer.v1'],
    ),
  );
  await check('Unsupported customer deoptimizes without a result', 'regression', async () => {
    try {
      await run(artifact.ir, { customerId: 'C-404' });
    } catch (error) {
      const deopt = error instanceof DeoptimizationError ? error : undefined;
      return expect(
        deopt?.detail.reason === 'unsupported_state' && deopt.detail.completedNodeIds.length === 0,
        `Expected an unsupported_state checkpoint, got: ${String(error)}`,
        `checkpoint reason ${deopt?.detail.reason} with ${deopt?.detail.completedNodeIds.length} completed nodes`,
      );
    }
    throw new Error('An unsupported customer produced a compiled result.');
  });
  await check('No privilege expansion beyond the traces', 'policy', async () => {
    const observed = traceScopeIds(supporting);
    const extra = artifact.ir.requiredScopes.filter((scope) => !observed.includes(scope));
    return expect(
      extra.length === 0,
      `Artifact requests scopes absent from the evidence: ${extra.join(', ')}`,
      `required scopes ${artifact.ir.requiredScopes.join(', ')} were all exercised in the traces`,
    );
  });
  await check('Effect declaration is read-only', 'policy', async () =>
    expect(
      artifact.ir.nodes.every((node) => node.effect === 'read' || node.effect === 'pure'),
      'A non-read effect reached a read-only capability.',
      'every node declares a read or pure effect',
    ),
  );
  return checks;
}

function summarize(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length > 220 ? `${flat.slice(0, 217)}...` : flat;
}
