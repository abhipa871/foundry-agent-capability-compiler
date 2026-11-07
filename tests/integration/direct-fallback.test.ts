import { createHash, generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { it, expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { Store } from '../../src/registry/store.js';
import { FoundryClient, RequestReadCache } from '../../src/integration/client.js';
import { AgentExecutionError } from '../../src/runtime/dispatcher.js';
import {
  localContext,
  mockAdapters,
  fixtureResult,
  type AdapterRunner,
} from '../../src/runtime/adapters/registry.js';
import { ApiKeyAuthenticator, localIdentity } from '../../src/security/identity.js';
import { ArtifactSigner } from '../../src/security/signing.js';
import { emptyMeasurement } from '../../src/telemetry/measurement.js';
import { DomainError } from '../../src/domain.js';

const input = { customerId: 'C-101' };
const task = { kind: 'customer_context', input };
const signal = () => new AbortController().signal;
it('reuses only validated successful reads within a caller-declared freshness window', async () => {
  let calls = 0;
  let now = Date.now();
  const context = { ...localContext(), observedAt: now };
  const cache = new RequestReadCache({
    input,
    freshnessMs: 1000,
    now: () => now,
    adapters: mockAdapters({ onCall: () => calls++ }),
  });
  const first = (await cache.adapters('crm.getCustomer', input, context, signal())) as {
    eligible: boolean;
  };
  first.eligible = false;
  expect(await cache.adapters('crm.getCustomer', input, context, signal())).toMatchObject({
    eligible: true,
  });
  expect(calls).toBe(1);
  now += 1001;
  expect(cache.available({ ...context, observedAt: now })).toEqual({});
  await cache.adapters('crm.getCustomer', input, { ...context, observedAt: now }, signal());
  expect(calls).toBe(2);
});
it('never caches failed, malformed, wrong-customer or wrong-snapshot reads', async () => {
  for (const fault of ['malformed', 'wrong_customer', 'wrong_snapshot'] as const) {
    const cache = new RequestReadCache({
      input,
      freshnessMs: 1000,
      adapters: mockAdapters({ fault }),
    });
    await expect(
      cache.adapters('crm.getCustomer', input, localContext(), signal()),
    ).rejects.toThrow();
    expect(cache.available(localContext())).toEqual({});
  }
  let attempts = 0;
  const adapters: AdapterRunner = async (operation, args) => {
    if (++attempts === 1) throw new Error('Unavailable');
    return fixtureResult(operation, args.customerId);
  };
  const cache = new RequestReadCache({ input, freshnessMs: 1000, adapters });
  await expect(
    cache.adapters('crm.getCustomer', input, localContext(), signal()),
  ).rejects.toThrow();
  await cache.adapters('crm.getCustomer', input, localContext(), signal());
  expect(attempts).toBe(2);
});
it('rechecks authorization and never crosses identity, record, policy, adapter or snapshot bindings', async () => {
  let calls = 0;
  const context = localContext();
  const cache = new RequestReadCache({
    input,
    freshnessMs: 1000,
    adapters: mockAdapters({ onCall: () => calls++ }),
  });
  await cache.adapters('crm.getCustomer', input, context, signal());
  await expect(
    cache.adapters('crm.getCustomer', input, { ...context, scopes: [] }, signal()),
  ).rejects.toThrow('permission');
  await expect(
    cache.adapters('crm.getCustomer', { customerId: 'C-202' }, context, signal()),
  ).rejects.toThrow('bound');
  for (const changed of [
    { ...context, tenantId: 'other' },
    { ...context, principalId: 'other' },
    { ...context, policyVersion: 'other' },
    { ...context, snapshot: 'other' },
    { ...context, adapterVersions: { ...context.adapterVersions, 'crm.getCustomer': '2' } },
    { ...context, observedAt: context.observedAt - 60000 },
  ])
    expect(cache.available(changed)).toEqual({});
  await cache.adapters('crm.getCustomer', input, { ...context, principalId: 'other' }, signal());
  expect(calls).toBe(2);
  expect(() => new RequestReadCache({ input, adapters: mockAdapters(), freshnessMs: 0 })).toThrow(
    'freshness',
  );
});

async function hosted(
  fn: (args: {
    client: (adapters?: AdapterRunner, context?: typeof localContext) => FoundryClient;
    service: ReturnType<typeof createApp>['service'];
    id: string;
    nativeCalls: () => number;
  }) => Promise<void>,
) {
  const keys = generateKeyPairSync('ed25519');
  const signer = new ArtifactSigner(
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  const apiKey = 'defer_test_credential_000000000000000000';
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
            crm_get_customer: fixtureResult('crm.getCustomer', customerId),
            orders_list: fixtureResult('orders.list', customerId),
            payments_refund_history: fixtureResult('payments.refundHistory', customerId),
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
  let nativeCalls = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const call =
      init?.method === 'POST'
        ? request(app)
            .post(path)
            .send(JSON.parse(String(init.body)))
        : request(app).get(path);
    const response = await call.set('Authorization', `Bearer ${apiKey}`);
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  const client = (adapters = mockAdapters(), context = localContext) =>
    new FoundryClient({
      ...localIdentity,
      adapters,
      context,
      native: async () => {
        nativeCalls++;
        return { resolved: false, summary: 'Native', llmInvocations: 0, tokens: 0 };
      },
      endpoint: 'http://127.0.0.1:3001',
      apiKey,
      trustedPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fetch: transport,
    });
  try {
    await fn({ client, service, id: candidate.id, nativeCalls: () => nativeCalls });
  } finally {
    store.close();
  }
}
it('defers quarantine and compatibility misses without launching a context agent; default remains native', async () => {
  await hosted(async ({ client, service, id, nativeCalls }) => {
    const stale = await client(undefined, () => ({
      ...localContext(),
      observedAt: Date.now() - 60000,
    })).execute(task, { fallback: 'defer' });
    expect(stale.outcome).toBe('unresolved');
    expect(stale.measurement.modelCalls).toBe(0);
    service.jit.quarantine(id);
    expect((await client().execute(task, { fallback: 'defer' })).outcome).toBe('unresolved');
    expect(nativeCalls()).toBe(0);
    await client().execute(task);
    expect(nativeCalls()).toBe(1);
  });
});
it('preserves completed safe reads and attempted work on a deferred compiled failure', async () => {
  await hosted(async ({ client, nativeCalls }) => {
    let reads = 0;
    const base = mockAdapters({ onCall: () => reads++ });
    const cache = new RequestReadCache({
      input,
      freshnessMs: 30000,
      adapters: async (operation, ...args) => {
        if (operation === 'payments.refundHistory') {
          reads++;
          throw new Error('Read unavailable');
        }
        return base(operation, ...args);
      },
    });
    const context = localContext();
    const run = await client(cache.adapters, () => context).execute(task, { fallback: 'defer' });
    expect(run.outcome).toBe('unresolved');
    expect(run.checkpoint?.completedNodeIds.length).toBe(2);
    expect(run.measurement).toMatchObject({ modelCalls: 0, totalTokens: 0, toolCalls: 3 });
    expect(nativeCalls()).toBe(0);
    expect(Object.keys(cache.available(context))).toHaveLength(2);
    await cache.adapters('crm.getCustomer', input, context, signal());
    expect(reads).toBe(3);
  });
});
it('keeps adapter and task denials terminal, including during deferred execution', async () => {
  await hosted(async ({ client, nativeCalls }) => {
    const denied = await client(undefined, () => ({
      ...localContext(),
      scopes: ['crm:read'],
    })).execute(task, { fallback: 'defer' });
    expect(denied.outcome).toBe('denied');
    const adapterDenied = await client(async () => {
      throw new DomainError('Access denied', 403);
    }).execute(task, { fallback: 'defer' });
    expect(adapterDenied.outcome).toBe('denied');
    expect(nativeCalls()).toBe(0);
  });
});
it('does not run a compiled shadow without an authoritative native path', async () => {
  await hosted(async ({ client, service, nativeCalls }) => {
    service.jit.configureRouting({ mode: 'shadow', rolloutPercent: 100 });
    let reads = 0;
    const result = await client(mockAdapters({ onCall: () => reads++ })).execute(task, {
      fallback: 'defer',
    });
    expect(result.outcome).toBe('unresolved');
    expect(reads).toBe(0);
    expect(nativeCalls()).toBe(0);
  });
});
it('preserves completed provider usage supplied with a failed native execution', async () => {
  const measurement = {
    ...emptyMeasurement(),
    outcome: 'failed' as const,
    inputTokens: 10,
    outputTokens: 3,
    totalTokens: 13,
    modelCalls: 1,
  };
  const client = new FoundryClient({
    ...localIdentity,
    context: localContext,
    adapters: mockAdapters(),
    native: async () => {
      throw new AgentExecutionError(measurement);
    },
  });
  expect((await client.execute(task)).measurement).toMatchObject({
    inputTokens: 10,
    totalTokens: 13,
    modelCalls: 1,
    outcome: 'failed',
  });
});
