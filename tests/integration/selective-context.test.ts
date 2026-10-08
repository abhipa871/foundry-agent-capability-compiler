import { createHash, generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { Store } from '../../src/registry/store.js';
import {
  FoundryClient,
  RequestReadCache,
  defineContextContract,
  selectExecution,
  type ContextContract,
} from '../../src/integration/client.js';
import { checkGuards, type TaskRequest } from '../../src/runtime/dispatcher.js';
import { DeoptimizationError, interpret, interpretSelected } from '../../src/runtime/interpret.js';
import {
  planSelection,
  resourceSelectionSchema,
  subsetContextProjection,
} from '../../src/runtime/selective.js';
import {
  authorizeReads,
  fixtureResult,
  localContext,
  mockAdapters,
  type AdapterFault,
  type AdapterRunner,
  type RuntimeContext,
} from '../../src/runtime/adapters/registry.js';
import { validateIR, type CapabilityIR, type ReadOperation } from '../../src/compiler/ir.js';
import { ApiKeyAuthenticator, localIdentity } from '../../src/security/identity.js';
import { ArtifactSigner } from '../../src/security/signing.js';
import { DomainError } from '../../src/domain.js';

const all: ReadOperation[] = ['crm.getCustomer', 'orders.list', 'payments.refundHistory'];
const input = { customerId: 'C-101' };
const task: TaskRequest = { kind: 'customer_context', input };
const keysOf = (value: unknown) => Object.keys(value as object).sort();

// Every adapter call is authorized per resource and counted against a per-request retry budget
// shared by compiled execution and any agent continuation, as in the support-agent harness.
function recorder(
  faults: Partial<
    Record<ReadOperation, (attempt: number) => Error | AdapterFault | undefined>
  > = {},
  budget = 2,
) {
  const reads: { operation: ReadOperation; status: 'success' | 'failed' }[] = [];
  const attempts = new Map<ReadOperation, number>();
  const adapters: AdapterRunner = async (operation, args, context, signal) => {
    authorizeReads(context, args, [operation]);
    const attempt = (attempts.get(operation) ?? 0) + 1;
    attempts.set(operation, attempt);
    if (attempt > budget) throw new DomainError('Read retry budget exhausted.', 503);
    const fault = faults[operation]?.(attempt);
    try {
      if (fault instanceof Error) throw fault;
      const value = await mockAdapters({ fault: fault ?? 'none' })(
        operation,
        args,
        context,
        signal,
      );
      reads.push({ operation, status: 'success' });
      return value;
    } catch (error) {
      reads.push({ operation, status: 'failed' });
      throw error;
    }
  };
  return {
    adapters,
    reads,
    attempted: () => reads.map((read) => read.operation),
    successful: () => reads.filter((read) => read.status === 'success').map((r) => r.operation),
  };
}

function compiledIR(): CapabilityIR {
  const store = new Store(':memory:');
  try {
    const { service } = createApp(store, false);
    service.jit.seed();
    return service.jit.compile().ir;
  } finally {
    store.close();
  }
}
// The demo plan reads orders and refunds through the customer record (a genuine dependency).
// The independent variant binds every read to task input, as the support-agent traces do.
const dependent = compiledIR();
const independent = validateIR({
  ...dependent,
  concurrency: 3,
  nodes: dependent.nodes.map((node) =>
    node.opcode === 'adapter.read'
      ? { ...node, deps: [], args: { customerId: { kind: 'input', key: 'customerId' } } }
      : node,
  ),
} as CapabilityIR);
const execution = (adapters: AdapterRunner, context: Partial<RuntimeContext> = {}) => ({
  adapters,
  context: {
    ...localContext(),
    tenantId: dependent.guards.tenantId,
    principalId: dependent.guards.principalId ?? localContext().principalId,
    ...context,
  },
});

describe('selective context contracts', () => {
  it('selects subset prefetch from a registered contract, in canonical order', () => {
    const select = (reads: ReadOperation[], context = localContext()) =>
      selectExecution(defineContextContract({ requirement: 'subset', reads }), input, context);
    expect(select(['payments.refundHistory', 'crm.getCustomer'])).toMatchObject({
      mode: 'compiled_prefetch',
      reason: 'trusted_contract_requires_resource_subset',
      resources: ['crm.getCustomer', 'payments.refundHistory'],
    });
    for (const single of all)
      expect(select([single])).toMatchObject({ mode: 'compiled_prefetch', resources: [single] });
    expect(select([...all].reverse())).toMatchObject({
      mode: 'compiled_prefetch',
      reason: 'trusted_contract_requires_complete_context',
      resources: all,
    });
  });
  it('rejects empty, duplicate and unknown resources and ignores untrusted metadata', () => {
    expect(() => defineContextContract({ requirement: 'subset', reads: [] })).toThrow();
    expect(() =>
      defineContextContract({ requirement: 'subset', reads: ['orders.list', 'orders.list'] }),
    ).toThrow();
    expect(() =>
      defineContextContract({
        requirement: 'subset',
        reads: ['billing.invoices' as ReadOperation],
      }),
    ).toThrow();
    for (const raw of [[], ['orders.list', 'orders.list'], ['crm.getCustomer', 'secrets.read']])
      expect(resourceSelectionSchema.safeParse(raw).success).toBe(false);
    const copied = JSON.parse(
      JSON.stringify(defineContextContract({ requirement: 'subset', reads: ['orders.list'] })),
    ) as ContextContract;
    expect(selectExecution(copied, input, localContext())).toMatchObject({
      mode: 'normal',
      reason: 'untrusted_task_metadata',
      resources: [],
    });
  });
  it('authorizes only the requested resources and keeps existing modes unchanged', () => {
    const ordersOnly = { ...localContext(), scopes: ['orders:read'] };
    const subset = (reads: ReadOperation[]) =>
      defineContextContract({ requirement: 'subset', reads });
    expect(selectExecution(subset(['orders.list']), input, ordersOnly).mode).toBe(
      'compiled_prefetch',
    );
    expect(selectExecution(subset(['payments.refundHistory']), input, ordersOnly).mode).toBe(
      'denied',
    );
    expect(
      selectExecution(subset(['orders.list']), input, {
        ...localContext(),
        allowedCustomerIds: ['C-202'],
      }).mode,
    ).toBe('denied');
    const known = (reads: ReadOperation[]) =>
      defineContextContract({ requirement: 'known', reads });
    expect(selectExecution(known(['orders.list']), input, localContext()).mode).toBe('normal');
    expect(selectExecution(known([]), input, localContext()).mode).toBe('normal');
    expect(selectExecution(known(all), input, localContext()).mode).toBe('compiled_prefetch');
    expect(
      selectExecution(
        defineContextContract({ requirement: 'agent_decides', reads: all }),
        input,
        localContext(),
      ).mode,
    ).toBe('compiled_tool');
  });
});

describe('selective compiled execution', () => {
  it('reads one resource and returns exactly it', async () => {
    for (const ir of [dependent, independent]) {
      const reads = recorder();
      const run = await interpretSelected(ir, input, {
        ...execution(reads.adapters),
        resources: ['crm.getCustomer'],
      });
      expect(reads.attempted()).toEqual(['crm.getCustomer']);
      expect(keysOf(run.result)).toEqual(['crm_get_customer', 'customer_id']);
      expect(run).toMatchObject({ prerequisites: [], adapterCalls: 1, llmInvocations: 0 });
    }
  });
  it('executes a genuine prerequisite without returning it, and nothing else', async () => {
    const reads = recorder();
    const run = await interpretSelected(dependent, input, {
      ...execution(reads.adapters),
      resources: ['orders.list'],
    });
    expect(reads.attempted()).toEqual(['crm.getCustomer', 'orders.list']);
    expect(run.prerequisites).toEqual(['crm.getCustomer']);
    expect(keysOf(run.result)).toEqual(['customer_id', 'orders_list']);
    const full = await interpret(dependent, input, execution(mockAdapters()));
    expect(run.result).toEqual(
      subsetContextProjection({ customer_id: 'C-101', orders_list: full.result.orders_list }, [
        'orders.list',
      ]),
    );
    expect(() => subsetContextProjection(full.result, ['orders.list'])).toThrow();
  });
  it('reads independent resources in parallel without unrequested reads', async () => {
    for (const resources of [
      ['orders.list'],
      ['orders.list', 'payments.refundHistory'],
      ['crm.getCustomer', 'payments.refundHistory'],
    ] as ReadOperation[][]) {
      const reads = recorder();
      const run = await interpretSelected(independent, input, {
        ...execution(reads.adapters),
        resources,
      });
      expect(reads.attempted().sort()).toEqual([...resources].sort());
      expect(run.prerequisites).toEqual([]);
      expect(run.peakParallel).toBe(resources.length);
    }
  });
  it('matches the existing complete result when every resource is requested', async () => {
    for (const ir of [dependent, independent]) {
      const full = await interpret(ir, input, execution(mockAdapters()));
      const reads = recorder();
      const run = await interpretSelected(ir, input, {
        ...execution(reads.adapters),
        resources: all,
      });
      expect(run.result).toEqual(subsetContextProjection(full.result, all));
      expect(reads.attempted()).toHaveLength(3);
    }
  });
  it('rejects unknown resources and plans that cannot produce a resource before any read', async () => {
    const reads = recorder();
    for (const resources of [[], ['payments.chargebacks'], ['orders.list', 'orders.list']])
      await expect(
        interpretSelected(dependent, input, {
          ...execution(reads.adapters),
          resources: resources as ReadOperation[],
        }),
      ).rejects.toThrow();
    const withoutRefunds = {
      ...dependent,
      nodes: dependent.nodes.filter((node) => node.id !== 'payments_refund_history'),
    } as CapabilityIR;
    expect(() => planSelection(withoutRefunds, ['payments.refundHistory'])).toThrow(
      'exactly one payments.refundHistory',
    );
    expect(reads.attempted()).toEqual([]);
  });
  it('fails closed on identity, tenant and snapshot mismatch', async () => {
    for (const fault of ['wrong_customer', 'wrong_snapshot', 'malformed'] as const)
      await expect(
        interpretSelected(independent, input, {
          ...execution(recorder({ 'orders.list': () => fault }).adapters),
          resources: ['orders.list'],
        }),
      ).rejects.toBeInstanceOf(DeoptimizationError);
    await expect(
      interpretSelected(independent, input, {
        ...execution(mockAdapters(), { tenantId: 'other-tenant' }),
        resources: ['orders.list'],
      }),
    ).rejects.toThrow('tenant');
    expect(() =>
      subsetContextProjection({ customer_id: 'C-101', orders_list: { customerId: 'C-202' } }, [
        'orders.list',
      ]),
    ).toThrow();
  });
  it('never returns missing or extra evidence', () => {
    expect(() => subsetContextProjection({ customer_id: 'C-101' }, ['orders.list'])).toThrow(
      'requested subset',
    );
    expect(() =>
      subsetContextProjection({ customer_id: 'C-101', orders_list: null, crm_get_customer: null }, [
        'orders.list',
      ]),
    ).toThrow('requested subset');
  });
  it('checkpoints successful reads when another selected read fails', async () => {
    const reads = recorder({
      'payments.refundHistory': () => new DomainError('Unavailable', 503),
    });
    const failure = await interpretSelected(independent, input, {
      ...execution(reads.adapters),
      resources: ['orders.list', 'payments.refundHistory'],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeoptimizationError);
    const { detail } = failure as DeoptimizationError;
    expect(detail.completedNodeIds).toEqual(['orders_list']);
    expect(Object.keys(detail.liveValues)).toEqual(['orders_list']);
    expect(reads.attempted()).not.toContain('crm.getCustomer');
  });
});

async function hosted(
  fn: (args: {
    client: (adapters?: AdapterRunner, context?: () => RuntimeContext) => FoundryClient;
    service: ReturnType<typeof createApp>['service'];
    id: string;
    checks: { name: string; passed: boolean; detail: string }[];
    nativeTasks: TaskRequest[];
    telemetry: { status: number; body: Record<string, unknown> }[];
  }) => Promise<void>,
) {
  const keys = generateKeyPairSync('ed25519');
  const signer = new ArtifactSigner(
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  const apiKey = 'selective_test_credential_00000000000000';
  const store = new Store(':memory:');
  const { app, service } = createApp(store, false, {
    signer,
    auth: new ApiKeyAuthenticator([
      { sha256: createHash('sha256').update(apiKey).digest('hex'), identity: localIdentity },
    ]),
    runtime: {
      agent: async (req) => {
        const { customerId } = req.input as typeof input;
        return {
          resolved: true,
          summary: 'Fixture oracle',
          llmInvocations: 0,
          tokens: 0,
          result: {
            customer_id: customerId,
            ...Object.fromEntries(
              all.map((operation) => [
                {
                  'crm.getCustomer': 'crm_get_customer',
                  'orders.list': 'orders_list',
                  'payments.refundHistory': 'payments_refund_history',
                }[operation],
                fixtureResult(operation, customerId),
              ]),
            ),
          },
        };
      },
    },
  });
  service.jit.seed();
  const candidate = await service.jit.verify(service.jit.compile().id);
  service.jit.approve(candidate.id, 'Unit sandbox');
  for (const customerId of ['C-101', 'C-202', 'C-303'])
    await service.jit.shadow(candidate.id, { customerId });
  service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
  const nativeTasks: TaskRequest[] = [];
  const telemetry: { status: number; body: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
    const call = body ? request(app).post(path).send(body) : request(app).get(path);
    const response = await call.set('Authorization', `Bearer ${apiKey}`);
    if (path === '/api/v2/telemetry') telemetry.push({ status: response.status, body });
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  const client = (adapters: AdapterRunner = mockAdapters(), context = localContext) =>
    new FoundryClient({
      ...localIdentity,
      adapters,
      context,
      native: async (req) => {
        nativeTasks.push(req);
        return { resolved: false, summary: 'Native', llmInvocations: 0, tokens: 0 };
      },
      endpoint: 'http://127.0.0.1:3001',
      apiKey,
      trustedPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fetch: transport,
    });
  try {
    await fn({
      client,
      service,
      id: candidate.id,
      checks: candidate.checks,
      nativeTasks,
      telemetry,
    });
  } finally {
    store.close();
  }
}

describe('selective prefetch through the SDK', () => {
  it('verifies every selectable subset before approval', async () => {
    await hosted(async ({ checks }) => {
      expect(
        checks.find((check) => check.name === 'Selected resources match the full plan'),
      ).toMatchObject({ passed: true, detail: expect.stringContaining('7 of 7') });
    });
  });
  it('serves a validated subset from the signed approved artifact and records it', async () => {
    await hosted(async ({ client, nativeTasks, telemetry }) => {
      const reads = recorder();
      const selection = selectExecution(
        defineContextContract({ requirement: 'subset', reads: ['crm.getCustomer'] }),
        input,
        localContext(),
      );
      const run = await client(reads.adapters).execute(task, {
        resources: selection.resources,
        selection,
      });
      expect(run).toMatchObject({
        mode: 'compiled',
        outcome: 'success',
        selection: { resources: ['crm.getCustomer'], prerequisites: [] },
      });
      expect(keysOf(run.result)).toEqual(['crm_get_customer', 'customer_id']);
      expect(run.observable).toBeUndefined();
      expect(reads.attempted()).toEqual(['crm.getCustomer']);
      expect(nativeTasks).toEqual([]);
      expect(telemetry.at(-1)).toMatchObject({
        status: 201,
        body: {
          runtimeStatus: 'compiled',
          selection: {
            mode: 'compiled_prefetch',
            reason: 'trusted_contract_requires_resource_subset',
            resources: ['crm.getCustomer'],
            prerequisites: [],
          },
        },
      });
      expect(telemetry.at(-1)!.body.selection).toHaveProperty('durationMs');
    });
  });
  it('keeps complete requests and telemetry unchanged when no resources are given', async () => {
    await hosted(async ({ client, telemetry }) => {
      const reads = recorder();
      const run = await client(reads.adapters).execute(task);
      expect(run.mode).toBe('compiled');
      expect(keysOf(run.result)).toEqual([
        'crm_get_customer',
        'customer_id',
        'orders_list',
        'payments_refund_history',
      ]);
      expect(run.observable).toBeDefined();
      expect(run.selection).toBeUndefined();
      expect(reads.attempted()).toHaveLength(3);
      expect(telemetry.at(-1)!.body).not.toHaveProperty('selection');
    });
  });
  it('serves a request for every resource through the existing complete prefetch path', async () => {
    await hosted(async ({ client, telemetry }) => {
      const run = await client().execute(task, { resources: [...all].reverse() });
      expect(run.mode).toBe('compiled');
      expect(run.observable).toBeDefined();
      expect(run.selection).toBeUndefined();
      expect(telemetry.at(-1)!.body).toMatchObject({
        runtimeStatus: 'compiled',
        selection: { resources: all, prerequisites: [] },
      });
    });
  });
  it('denies an unauthorized subset terminally, without native fallback or reads', async () => {
    await hosted(async ({ client, nativeTasks }) => {
      const crmOnly = () => ({ ...localContext(), scopes: ['crm:read'] });
      for (const resources of [['orders.list'], ['crm.getCustomer', 'payments.refundHistory']]) {
        const reads = recorder();
        const run = await client(reads.adapters, crmOnly).execute(task, {
          resources: resources as ReadOperation[],
        });
        expect(run.outcome).toBe('denied');
        expect(reads.attempted()).toEqual([]);
      }
      const otherRecord = await client(undefined, () => ({
        ...localContext(),
        allowedCustomerIds: ['C-202'],
      })).execute(task, { resources: ['crm.getCustomer'] });
      expect(otherRecord.outcome).toBe('denied');
      expect(nativeTasks).toEqual([]);
      const permitted = await client(recorder().adapters, crmOnly).execute(task, {
        resources: ['crm.getCustomer'],
      });
      expect(permitted.mode).toBe('compiled');
      expect((await client(undefined, crmOnly).execute(task)).outcome).toBe('denied');
    });
  });
  it('treats an adapter denial during subset execution as terminal', async () => {
    await hosted(async ({ client, nativeTasks }) => {
      const run = await client(async () => {
        throw new DomainError('Access denied', 403);
      }).execute(task, { resources: ['orders.list'] });
      expect(run.outcome).toBe('denied');
      expect(nativeTasks).toEqual([]);
    });
  });
  it('falls back natively when a prerequisite is unauthorized, without counting a capability fault', async () => {
    await hosted(async ({ client, nativeTasks, telemetry }) => {
      const reads = recorder();
      const run = await client(reads.adapters, () => ({
        ...localContext(),
        scopes: ['orders:read'],
      })).execute(task, { resources: ['orders.list'] });
      expect(run.outcome).not.toBe('denied');
      expect(run.mode).toBe('agent');
      expect(run.guards.find((entry) => entry.name === 'resource_selection')).toMatchObject({
        ok: false,
        detail: 'prerequisite read not authorized',
      });
      expect(reads.attempted()).toEqual([]);
      expect(nativeTasks).toEqual([{ ...task, resources: ['orders.list'] }]);
      expect(telemetry.at(-1)!.body).toMatchObject({
        runtimeStatus: 'native',
        selection: { resources: ['orders.list'], fallbackReason: 'guard_miss' },
      });
    });
  });
  it('uses the existing safe fallback for quarantined, incompatible and stale artifacts', async () => {
    await hosted(async ({ client, service, id, nativeTasks }) => {
      const contexts = [
        () => ({
          ...localContext(),
          adapterVersions: { ...localContext().adapterVersions, 'orders.list': '2' },
        }),
        () => ({ ...localContext(), observedAt: Date.now() - 60000 }),
      ];
      for (const context of contexts) {
        const reads = recorder();
        const run = await client(reads.adapters, context).execute(task, {
          resources: ['orders.list'],
          fallback: 'defer',
        });
        expect(run).toMatchObject({
          mode: 'agent',
          outcome: 'unresolved',
          fallbackReason: 'guard_miss',
        });
        expect(reads.attempted()).toEqual([]);
      }
      service.jit.quarantine(id);
      const reads = recorder();
      const quarantined = await client(reads.adapters).execute(task, {
        resources: ['orders.list'],
      });
      expect(quarantined.mode).toBe('agent');
      expect(reads.attempted()).toEqual([]);
      expect(nativeTasks).toHaveLength(1);
    });
  });
  it('never runs a compiled shadow for a subset', async () => {
    await hosted(async ({ client, service, nativeTasks }) => {
      service.jit.configureRouting({ mode: 'shadow', rolloutPercent: 100 });
      const reads = recorder();
      const run = await client(reads.adapters).execute(task, { resources: ['crm.getCustomer'] });
      expect(run.mode).toBe('agent');
      expect(reads.attempted()).toEqual([]);
      expect(nativeTasks).toHaveLength(1);
    });
  });
  it('hands valid reads and a checkpoint to direct fallback, reusing successes and retrying only the failure', async () => {
    await hosted(async ({ client, nativeTasks }) => {
      const reads = recorder({
        'payments.refundHistory': (attempt) =>
          attempt === 1 ? new DomainError('Unavailable', 503) : undefined,
      });
      const cache = new RequestReadCache({ input, freshnessMs: 30000, adapters: reads.adapters });
      const context = localContext();
      const run = await client(cache.adapters, () => context).execute(task, {
        resources: ['orders.list', 'payments.refundHistory'],
        fallback: 'defer',
      });
      expect(run.outcome).toBe('unresolved');
      expect(run.selection).toEqual({
        resources: ['orders.list', 'payments.refundHistory'],
        prerequisites: ['crm.getCustomer'],
      });
      expect(run.checkpoint?.completedNodeIds.sort()).toEqual(['crm_get_customer', 'orders_list']);
      expect(Object.keys(cache.available(context)).sort()).toEqual([
        'crm.getCustomer',
        'orders.list',
      ]);
      const signal = new AbortController().signal;
      await cache.adapters('orders.list', input, context, signal);
      await cache.adapters('payments.refundHistory', input, context, signal);
      expect(reads.successful().sort()).toEqual([
        'crm.getCustomer',
        'orders.list',
        'payments.refundHistory',
      ]);
      expect(reads.attempted().filter((op) => op === 'payments.refundHistory')).toHaveLength(2);
      expect(nativeTasks).toEqual([]);
    });
  });
  it('never presents a permanently failed read as available and stops at the retry budget', async () => {
    await hosted(async ({ client }) => {
      const reads = recorder({
        'payments.refundHistory': () => new DomainError('Unavailable', 503),
      });
      const cache = new RequestReadCache({ input, freshnessMs: 30000, adapters: reads.adapters });
      const context = localContext();
      const run = await client(cache.adapters, () => context).execute(task, {
        resources: ['payments.refundHistory'],
        fallback: 'defer',
      });
      expect(run.outcome).toBe('unresolved');
      expect(run.result).toBeUndefined();
      const signal = new AbortController().signal;
      await expect(
        cache.adapters('payments.refundHistory', input, context, signal),
      ).rejects.toThrow('Unavailable');
      await expect(
        cache.adapters('payments.refundHistory', input, context, signal),
      ).rejects.toThrow('budget');
      expect(cache.available(context)).not.toHaveProperty('payments.refundHistory');
      expect(reads.successful()).toEqual(['crm.getCustomer']);
    });
  });
  it('reports the unservable subset guard without weakening other guards', () => {
    const artifact = {
      ir: dependent,
      status: 'approved',
      digest: 'x',
      approvedDigest: 'x',
      verifiedDigest: 'x',
      checks: [],
      taskKind: 'customer_context',
    } as unknown as Parameters<typeof checkGuards>[0];
    const guards = checkGuards(artifact, task, localContext(), Date.now(), ['orders.list']);
    expect(guards.find((entry) => entry.name === 'resource_selection')?.ok).toBe(true);
    expect(guards.find((entry) => entry.name === 'artifact_digest')?.ok).toBe(false);
    expect(guards.find((entry) => entry.name === 'validation')?.ok).toBe(false);
    expect(checkGuards(artifact, task, localContext()).map((entry) => entry.name)).not.toContain(
      'resource_selection',
    );
  });
});
