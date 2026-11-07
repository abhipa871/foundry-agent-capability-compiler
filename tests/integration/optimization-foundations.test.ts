import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/registry/store.js';
import { createApp } from '../../src/app.js';
import { ApiKeyAuthenticator, localIdentity, withIdentity } from '../../src/security/identity.js';
import { sampleToolTraces } from '../../src/exploration/sample-traces.js';
import { redact } from '../../src/exploration/privacy.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { localContext, mockAdapters } from '../../src/runtime/adapters/registry.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { JitRegistry } from '../../src/registry/jit.js';

describe('optimization foundations', () => {
  it('isolates identical record IDs, deployment names and deletion by tenant', async () => {
    const store = new Store(':memory:');
    try {
      const put = (tenantId: string) =>
        withIdentity({ ...localIdentity, tenantId }, async () => {
          await Promise.resolve();
          store.put('audit', {
            id: 'same',
            actor: tenantId,
            at: '',
            action: 'test',
            target: '',
            detail: '',
          });
          store.deploy('same', 'same');
          expect(store.get('audit', 'same')?.actor).toBe(tenantId);
        });
      await Promise.all([put('a'), put('b')]);
      withIdentity({ ...localIdentity, tenantId: 'a' }, () => store.deleteData());
      withIdentity({ ...localIdentity, tenantId: 'b' }, () =>
        expect(store.deployments()).toEqual({ same: 'same' }),
      );
      expect(store.all('audit')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('authenticates hosted requests and does not grant ingestion credentials approval', async () => {
    const store = new Store(':memory:');
    const token = 'test_credential_only_for_tests_123456';
    const identity = {
      ...localIdentity,
      tenantId: 'tenant-a',
      permissions: ['read', 'observe'] as const,
    };
    const auth = new ApiKeyAuthenticator([
      {
        sha256: createHash('sha256').update(token).digest('hex'),
        identity: { ...identity, permissions: [...identity.permissions] },
      },
    ]);
    const { app } = createApp(store, false, { auth });
    try {
      await request(app).get('/api/v2/state').expect(401);
      await request(app).get('/api/v2/state').set('Authorization', `Bearer ${token}`).expect(200);
      await request(app)
        .post('/api/v2/compile')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);
      await request(app)
        .post('/api/v2/traces')
        .set('Authorization', `Bearer ${token}`)
        .send(sampleToolTraces[0])
        .expect(403);
      await request(app).get('/api/state').set('Authorization', `Bearer ${token}`).expect(404);
    } finally {
      store.close();
    }
  });

  it('removes failed re-verification and stale approval from deployment eligibility', async () => {
    const store = new Store(':memory:');
    const registry = new JitRegistry(store, () => {});
    try {
      registry.seed();
      const verified = await registry.verify(registry.compile().id);
      registry.approve(verified.id, 'Fixture review.');
      const trace = registry.traces()[0];
      store.put('toolTrace', {
        ...trace,
        observableResult: { ...trace.observableResult, orderCount: 99 },
      });
      expect((await registry.verify(verified.id)).status).toBe('draft');
      expect(registry.active()).toEqual([]);
      expect(() => registry.deploy(verified.id)).toThrow();
    } finally {
      store.close();
    }
  });

  it('records real fallback outcomes and never falls back around authorization denial', async () => {
    let calls = 0;
    const agent = async () => {
      calls++;
      return {
        summary: 'Done.',
        resolved: true,
        tokens: 14,
        llmInvocations: 1,
        result: { ok: true },
      };
    };
    const result = await dispatch(
      { kind: 'customer_context', input: { customerId: 'C-101' } },
      [],
      { adapters: mockAdapters(), context: localContext(), agent },
    );
    expect(result.outcome).toBe('success');
    expect(result.result).toEqual({ ok: true });
    expect(result.durationMs).toBeGreaterThan(0);
    const denied = await dispatch(
      { kind: 'customer_context', input: { customerId: 'C-101' } },
      [],
      { adapters: mockAdapters(), context: { ...localContext(), scopes: [] }, agent },
    );
    expect(denied.outcome).toBe('denied');
    expect(calls).toBe(1);
    const unresolved = await dispatch(
      { kind: 'customer_context', input: { customerId: 'C-101' } },
      [],
      { adapters: mockAdapters(), context: localContext() },
    );
    expect(unresolved.outcome).toBe('unresolved');
    expect(unresolved.measurement.modelCalls).toBeNull();
    const failed = await dispatch(
      { kind: 'customer_context', input: { customerId: 'C-101' } },
      [],
      {
        adapters: mockAdapters(),
        context: localContext(),
        agent: async () => {
          throw new Error('secret value');
        },
      },
    );
    expect(failed.outcome).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('secret value');
  });

  it('records explicit tool provenance and unknown usage without raw model data', async () => {
    const observer = new TrajectoryObserver({
      input: { customerId: 'C-101' },
      context: localContext(),
      adapters: mockAdapters(),
      agentId: 'test',
    });
    await observer.modelCall(async () => ({ value: 'private prompt and reasoning' }));
    const crm = await observer.read('crm.getCustomer', { source: 'task_input', key: 'customerId' });
    const order = await observer.read('orders.list', {
      source: 'event_output',
      ref: { producerEventId: crm.eventId, outputPath: 'customerId' },
    });
    const refund = await observer.read('payments.refundHistory', {
      source: 'event_output',
      ref: { producerEventId: crm.eventId, outputPath: 'customerId' },
    });
    const trace = observer.finish({
      customer_id: 'C-101',
      crm_get_customer: crm.value,
      orders_list: order.value,
      payments_refund_history: refund.value,
    });
    expect(trace.measurement?.totalTokens).toBeNull();
    expect(trace.measurement?.modelCalls).toBe(1);
    expect(trace.events[1].args.customerId.source).toBe('event_output');
    expect(JSON.stringify(trace)).not.toContain('private prompt');
    expect(JSON.stringify(observer.exportStructural())).not.toContain('C-101');
    const deeplyNested = { a: { b: { c: { d: { e: { f: { g: { password: 'leak' } } } } } } } };
    expect(JSON.stringify(redact(deeplyNested))).not.toContain('leak');
    expect(redact('person@example.com Bearer abcdefg')).toBe('[redacted] [redacted]');
  });
});
