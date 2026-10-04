import { emptyMeasurement } from '../../src/telemetry/measurement.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Store } from '../../src/registry/store.js';
import { sampleToolTraceA, sampleToolTraceB } from '../../src/exploration/sample-traces.js';

describe('structured trace to guarded dispatch lifecycle', () => {
  let store: Store;
  let context: ReturnType<typeof createApp>;
  beforeEach(() => {
    store = new Store(':memory:');
    context = createApp(store, false);
  });
  afterEach(() => store.close());
  const post = (path: string, body: unknown = {}) =>
    request(context.app)
      .post(`/api${path}`)
      .set('X-Foundry-Client', 'local-ui')
      .send(body as object);
  const get = (path: string) => request(context.app).get(`/api${path}`);

  async function approved() {
    await post('/v2/traces', sampleToolTraceA).expect(201);
    await post('/v2/traces', sampleToolTraceB).expect(201);
    const compiled = await post('/v2/compile').expect(201);
    const verified = await post(`/v2/capabilities/${compiled.body.id}/verify`).expect(200);
    expect(verified.body.status).toBe('verified');
    return post(`/v2/capabilities/${compiled.body.id}/approve`, {
      note: 'Reviewed the IR, guards and read-only effect declaration.',
    }).expect(200);
  }

  it('compiles, verifies, approves and dispatches without invoking a model', async () => {
    const artifact = (await approved()).body;
    const dispatched = await post('/v2/tasks/dispatch', {
      kind: 'customer_context',
      input: { customerId: 'C-101' },
    }).expect(200);

    expect(artifact.status).toBe('approved');
    expect(artifact.ir.nodes).toHaveLength(4);
    expect(dispatched.body.mode).toBe('compiled');
    expect(dispatched.body.llmInvocations).toBe(0);
    expect(dispatched.body.capabilityVersion).toBe(1);
    expect(dispatched.body.observable).toEqual({
      customerId: 'C-101',
      eligible: true,
      orderCount: 1,
      refundCount: 0,
      refundTotal: 0,
    });
    const run = await get(`/v2/runs/${dispatched.body.runId}`).expect(200);
    expect(run.body.adapterCalls).toBe(3);
  });

  it('serves the executable IR and a downloadable artifact manifest', async () => {
    const artifact = (await approved()).body;
    const ir = await get(`/v2/capabilities/${artifact.id}/ir`).expect(200);
    const download = await get(`/v2/capabilities/${artifact.id}/artifact`).expect(200);

    expect(ir.body.digest).toBe(artifact.digest);
    expect(ir.body.report.parameters.length).toBeGreaterThan(0);
    expect(download.body.format).toBe('agent-jit-ir-v1');
    expect(download.headers['content-disposition']).toContain('load_customer_context-v1.json');
  });

  it('blocks approval and dispatch until verification passes on the same digest', async () => {
    await post('/v2/traces', sampleToolTraceA).expect(201);
    await post('/v2/traces', sampleToolTraceB).expect(201);
    const compiled = await post('/v2/compile').expect(201);

    await post(`/v2/capabilities/${compiled.body.id}/approve`, {
      note: 'Trying to skip verification.',
    }).expect(409);
    const dispatched = await post('/v2/tasks/dispatch', {
      kind: 'customer_context',
      input: { customerId: 'C-101' },
    }).expect(200);
    expect(dispatched.body.mode).toBe('agent');
    expect(dispatched.body.fallbackReason).toBe('no_candidate');
  });

  it('rejects a duplicate trace and an unknown task kind', async () => {
    await post('/v2/traces', sampleToolTraceA).expect(201);
    await post('/v2/traces', sampleToolTraceA).expect(409);
    await post('/v2/traces', { ...sampleToolTraceA, events: [] }).expect(400);
  });

  it('records a checkpoint for an unsupported input and closes it with a recovery note', async () => {
    await approved();
    const dispatched = await post('/v2/tasks/dispatch', {
      kind: 'customer_context',
      input: { customerId: 'C-404' },
    }).expect(200);

    expect(dispatched.body.mode).toBe('agent');
    expect(dispatched.body.fallbackReason).toBe('unsupported_state');
    expect(dispatched.body.checkpoint.completedEffects).toEqual([]);
    expect(dispatched.body.result).toBeUndefined();

    const recovered = await post(`/v2/runs/${dispatched.body.runId}/recover`, {
      by: 'operator',
      note: 'Account sits outside the supported fixture domain; handled by hand.',
    }).expect(200);
    expect(recovered.body.checkpoint.resolution.by).toBe('operator');
    await post(`/v2/runs/${dispatched.body.runId}/recover`, {
      by: 'operator',
      note: 'Second attempt at the same checkpoint.',
    }).expect(409);

    const state = await get('/v2/state').expect(200);
    expect(state.body.checkpoints).toHaveLength(1);
    expect(state.body.profiles[0].fallbacks.unsupported_state).toBe(1);
  });

  it('revokes a version and stops dispatching it', async () => {
    const artifact = (await approved()).body;
    await post(`/v2/capabilities/${artifact.id}/revoke`).expect(200);
    const dispatched = await post('/v2/tasks/dispatch', {
      kind: 'customer_context',
      input: { customerId: 'C-101' },
    }).expect(200);

    expect(dispatched.body.mode).toBe('agent');
    expect(dispatched.body.fallbackReason).toBe('no_candidate');
  });

  it('keeps a profile that separates compiled runs from agent fallbacks', async () => {
    await approved();
    await post('/v2/tasks/dispatch', {
      kind: 'customer_context',
      input: { customerId: 'C-101' },
    }).expect(200);
    await post('/v2/tasks/dispatch', {
      kind: 'customer_context',
      input: { customerId: 'C-404' },
    }).expect(200);

    const profile = await get('/v2/profiles/load_customer_context').expect(200);
    expect(profile.body.compiled).toBe(1);
    expect(profile.body.agent).toBe(1);
    expect(profile.body.compiledLlmInvocations).toBe(0);
    expect(profile.body.recordedTraceBaseline.traces).toBe(2);
    expect(profile.body.recordedTraceBaseline.note).toContain('Not a controlled benchmark');
  });

  it('requires the local client header for v2 mutations', async () => {
    await request(context.app).post('/api/v2/compile').send({}).expect(403);
  });
});

it('preserves fractional fixture averages without presenting them as measured savings', () => {
  const store = new Store(':memory:');
  try {
    const { service } = createApp(store);
    service.jit.compile();
    expect(
      service.jit.profile('load_customer_context').recordedTraceBaseline.avgLlmInvocations,
    ).toBe(6.5);
    for (const trace of service.jit.traces())
      store.put('toolTrace', {
        ...trace,
        measurement: { ...emptyMeasurement(), totalTokens: null, modelCalls: null },
      });
    expect(service.jit.profile('load_customer_context').recordedTraceBaseline.avgTokens).toBeNull();
    expect(
      service.jit.profile('load_customer_context').recordedTraceBaseline.avgLlmInvocations,
    ).toBeNull();
  } finally {
    store.close();
  }
});
