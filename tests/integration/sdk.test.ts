import { createHash, generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { FoundryClient, type CustomerAgent } from '../../src/integration/client.js';
import { verifyTicket } from '../../src/integration/protocol.js';
import { ArtifactSigner } from '../../src/security/signing.js';
import { ApiKeyAuthenticator, localIdentity } from '../../src/security/identity.js';
import { localContext, mockAdapters, fixtureResult } from '../../src/runtime/adapters/registry.js';
import { Store } from '../../src/registry/store.js';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signer = new ArtifactSigner(privateKey);
const apiKey = 'test_credential_00000000000000000000000';
const native: CustomerAgent = async (task, _checkpoint, observer) => {
  const { customerId } = task.input as { customerId: string };
  const crm = await observer!.read('crm.getCustomer', { source: 'task_input', key: 'customerId' });
  const binding = {
    source: 'event_output' as const,
    ref: { producerEventId: crm.eventId, outputPath: 'customerId' as const },
  };
  const orders = await observer!.read('orders.list', binding);
  const refunds = await observer!.read('payments.refundHistory', binding);
  return {
    resolved: true,
    summary: 'Native sandbox result',
    llmInvocations: 0,
    tokens: 0,
    result: {
      customer_id: customerId,
      crm_get_customer: crm.value,
      orders_list: orders.value,
      payments_refund_history: refunds.value,
    },
  };
};
it('integrates once: observes privately, shadows natively, then uses a signed gated capability', async () => {
  const store = new Store(':memory:');
  const auth = new ApiKeyAuthenticator([
    { sha256: createHash('sha256').update(apiKey).digest('hex'), identity: localIdentity },
  ]);
  const { app, service } = createApp(store, false, {
    auth,
    signer,
    runtime: {
      agent: async (task) => {
        const { customerId } = task.input as { customerId: string };
        return {
          resolved: true,
          summary: 'Sandbox reference',
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
  const bodies: unknown[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body) bodies.push(body);
    const call =
      init?.method === 'POST' ? request(app).post(path).send(body) : request(app).get(path);
    const response = await call.set('Authorization', `Bearer ${apiKey}`);
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  const client = new FoundryClient({
    ...localIdentity,
    context: localContext,
    native,
    adapters: mockAdapters(),
    endpoint: 'http://127.0.0.1:3001',
    apiKey,
    trustedPublicKey: publicKey,
    fetch: transport,
  });
  try {
    expect(
      (await client.execute({ kind: 'customer_context', input: { customerId: 'C-101' } })).mode,
    ).toBe('agent');
    expect(store.all('toolTrace')).toEqual([]);
    expect(JSON.stringify(bodies)).not.toContain('C-101');
    service.jit.seed();
    const candidate = await service.jit.verify(service.jit.compile().id);
    service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
    service.jit.approve(candidate.id, 'Sandbox approval');
    expect(service.jit.runtimeTicket().mode).toBe('observe');
    service.jit.configureRouting({ mode: 'shadow', rolloutPercent: 100 });
    for (let n = 0; n < 3; n++)
      expect(
        (await client.execute({ kind: 'customer_context', input: { customerId: 'C-101' } })).mode,
      ).toBe('agent');
    expect(service.jit.health(candidate.id).status).toBe('healthy');
    // Customer-reported matches cannot authorize promotion.
    expect(service.jit.shadowStatus(candidate.id).ready).toBe(false);
    for (const customerId of ['C-101', 'C-202', 'C-303'])
      await service.jit.shadow(candidate.id, { customerId });
    service.jit.configureRouting({ mode: 'live', rolloutPercent: 100 });
    expect(
      (await client.execute({ kind: 'customer_context', input: { customerId: 'C-202' } })).mode,
    ).toBe('compiled');
    expect(store.all('telemetry')).toHaveLength(5);
  } finally {
    store.close();
  }
});
it('rejects tampering, replay after expiry, and cross-tenant signed tickets', () => {
  const ticket = signer.sign({
    format: 'foundry-runtime-v1',
    tenantId: 'local-demo',
    principalId: 'local-operator',
    issuedAt: 1000,
    expiresAt: 61000,
    mode: 'observe',
    rolloutPercent: 0,
  });
  expect(verifyTicket(ticket, publicKey, localIdentity, 1001).mode).toBe('observe');
  expect(() =>
    verifyTicket(
      { ...ticket, payload: ticket.payload.replace('observe', 'live') },
      publicKey,
      localIdentity,
      1001,
    ),
  ).toThrow(/signature/);
  expect(() => verifyTicket(ticket, publicKey, localIdentity, 61001)).toThrow(/lease/);
  expect(() =>
    verifyTicket(ticket, publicKey, { ...localIdentity, tenantId: 'other' }, 1001),
  ).toThrow(/identity/);
});
it('falls back on outage and enforces caller permissions without native execution', async () => {
  let runs = 0;
  const options = {
    ...localIdentity,
    context: localContext,
    native: async (...args: Parameters<CustomerAgent>) => {
      runs++;
      return native(...args);
    },
    adapters: mockAdapters(),
    endpoint: 'https://sandbox.example',
    apiKey,
    trustedPublicKey: publicKey,
    fetch: (async () => {
      throw new Error('Offline');
    }) as typeof fetch,
  };
  const result = await new FoundryClient(options).execute({
    kind: 'customer_context',
    input: { customerId: 'C-101' },
  });
  expect(result.mode).toBe('agent');
  expect(result.outcome).toBe('success');
  expect(runs).toBe(1);
  const denied = await new FoundryClient({
    ...options,
    context: () => ({ ...localContext(), scopes: ['crm:read'] }),
  }).execute({ kind: 'customer_context', input: { customerId: 'C-101' } });
  expect(denied.outcome).toBe('denied');
  expect(runs).toBe(1);
  expect(() => new FoundryClient({ ...options, endpoint: 'http://external.example' })).toThrow(
    /HTTPS/,
  );
});
it('retains reported model usage when only tool calls were wrapped', async () => {
  const client = new FoundryClient({
    ...localIdentity,
    context: localContext,
    adapters: mockAdapters(),
    native: async (...args) => ({ ...(await native(...args)), llmInvocations: 2, tokens: 321 }),
  });
  const result = await client.execute({ kind: 'customer_context', input: { customerId: 'C-101' } });
  expect(result.measurement.modelCalls).toBe(2);
  expect(result.measurement.totalTokens).toBe(321);
  expect(result.measurement.inputTokens).toBeNull();
});

it('uses wrapped provider usage even when a legacy callback reports default zero counters', async () => {
  const client = new FoundryClient({
    ...localIdentity,
    context: localContext,
    adapters: mockAdapters(),
    native: async (...args) => {
      await args[2]!.modelCall(async () => ({
        value: 'sandbox response',
        usage: { inputTokens: 12, outputTokens: 3 },
      }));
      return native(...args);
    },
  });
  const result = await client.execute({ kind: 'customer_context', input: { customerId: 'C-101' } });
  expect(result.measurement.modelCalls).toBe(1);
  expect(result.measurement.totalTokens).toBe(15);
});
