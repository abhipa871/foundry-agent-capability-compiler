import { safeText } from '../exploration/privacy.js';
import { performance } from 'node:perf_hooks';
import type { Check } from '../domain.js';
import {
  irDigest,
  operationSchema,
  validateIR,
  type CapabilityIR,
  type IRArtifact,
} from '../compiler/ir.js';
import { planSelection, resourceKeys, subsetContextProjection } from '../runtime/selective.js';
import { validateEvidence } from './evidence.js';
import { contextProjection, sameContext } from '../runtime/observable.js';
import { traceScopeIds, type StoredToolTrace } from '../exploration/tool-events.js';
import {
  fixtureResult,
  localContext,
  mockAdapters,
  type RuntimeContext,
} from '../runtime/adapters/registry.js';
import { checkGuards } from '../runtime/dispatcher.js';
import { DeoptimizationError, interpret, interpretSelected } from '../runtime/interpret.js';
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
  ) =>
    interpret(ir, input, {
      adapters,
      context: {
        ...localContext(),
        tenantId: artifact.ir.guards.tenantId,
        principalId: artifact.ir.guards.principalId ?? localContext().principalId,
        ...ctx,
      },
    });
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
  await check('Complete supporting evidence is present and coherent', 'schema', async () => {
    const ids = artifact.ir.provenance.traceIds;
    const complete =
      supporting.length === ids.length &&
      new Set(ids).size === ids.length &&
      supporting.length >= 2 &&
      new Set(supporting.map((trace) => trace.taskInput.customerId)).size >= 2;
    supporting.forEach(validateEvidence);
    return expect(
      complete &&
        supporting.every(
          (trace) =>
            trace.status === 'success' &&
            trace.tenantId === artifact.ir.guards.tenantId &&
            trace.principalId === artifact.ir.guards.principalId,
        ),
      'Supporting evidence is missing, duplicated or identity-incoherent.',
      'complete distinct source evidence',
    );
  });
  await check(
    'Held-out full context agrees with independent fixture oracle',
    'regression',
    async () => {
      for (const customerId of ['C-101', 'C-202', 'C-303']) {
        const result = await run(artifact.ir, { customerId });
        const reference = Object.fromEntries([
          ['customer_id', customerId],
          ...(['crm.getCustomer', 'orders.list', 'payments.refundHistory'] as const).map(
            (operation) => [
              operation === 'crm.getCustomer'
                ? 'crm_get_customer'
                : operation === 'orders.list'
                  ? 'orders_list'
                  : 'payments_refund_history',
              {
                ...(fixtureResult(operation, customerId) as object),
                tenantId: artifact.ir.guards.tenantId,
              },
            ],
          ),
        ]);
        expect(
          sameContext(result.result, reference),
          'Full context differs from fixture oracle.',
          '',
        );
      }
      return 'all resource identities and values match, including C-303 held out from demo evidence';
    },
  );
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
        const reference = {
          customer_id: trace.taskInput.customerId,
          crm_get_customer: trace.events.find(
            (event) => event.status === 'success' && event.operation === 'crm.getCustomer',
          )?.result?.projection,
          orders_list: trace.events.find(
            (event) => event.status === 'success' && event.operation === 'orders.list',
          )?.result?.projection,
          payments_refund_history: trace.events.find(
            (event) => event.status === 'success' && event.operation === 'payments.refundHistory',
          )?.result?.projection,
        };
        contextProjection(reference);
        if (!sameContext(result.result, reference))
          throw new Error('Full context differs from recorded resource values.');
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
  // Subsets the plan cannot serve are not selectable (they fall back at the guard), not failures.
  await check('Selected resources match the full plan', 'regression', async () => {
    const operations = operationSchema.options;
    const subsets = Array.from({ length: (1 << operations.length) - 1 }, (_, index) =>
      operations.filter((_, bit) => (index + 1) & (1 << bit)),
    );
    const full = await run(artifact.ir, { customerId: 'C-101' });
    let selectable = 0;
    for (const resources of subsets) {
      let plan;
      try {
        plan = planSelection(artifact.ir, resources);
      } catch {
        continue;
      }
      selectable += 1;
      const selected = await interpretSelected(
        artifact.ir,
        { customerId: 'C-101' },
        {
          adapters: build(),
          context: {
            ...localContext(),
            tenantId: artifact.ir.guards.tenantId,
            principalId: artifact.ir.guards.principalId ?? localContext().principalId,
          },
          resources,
        },
      );
      const fullContext = full.result as Record<string, unknown>;
      const reference = Object.fromEntries([
        ['customer_id', 'C-101'],
        ...resources.map((operation) => [
          resourceKeys[operation],
          fullContext[resourceKeys[operation]],
        ]),
      ]);
      const reads = plan.nodeIds.filter(
        (id) => artifact.ir.nodes.find((node) => node.id === id)?.opcode === 'adapter.read',
      );
      expect(
        JSON.stringify(subsetContextProjection(selected.result, resources)) ===
          JSON.stringify(subsetContextProjection(reference, resources)) &&
          selected.adapterCalls === reads.length &&
          [...selected.executedNodeIds].sort().join() === [...plan.nodeIds].sort().join(),
        `Selection ${resources.join('+')} diverged from the full plan or its dependency closure.`,
        '',
      );
    }
    return `${selectable} of ${subsets.length} resource subsets are selectable and match the full plan`;
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
  const flat = safeText(detail).replace(/\s+/g, ' ').trim();
  return flat.length > 220 ? `${flat.slice(0, 217)}...` : flat;
}
