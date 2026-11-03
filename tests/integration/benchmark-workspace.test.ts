import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { BenchmarkWorkspace, retainedEvidence } from '../../src/benchmarks/workspace.js';
import type { BenchmarkRequest } from '../../src/benchmarks/contracts.js';
import { Store } from '../../src/registry/store.js';
import { ApiKeyAuthenticator, localIdentity, withIdentity } from '../../src/security/identity.js';
import type { CustomerContextAgent } from '../../scripts/experiments/customer-agent.js';
import type { AgentTask } from '../../scripts/experiments/customer-agent.js';
import type { SelectiveResponse } from '../../scripts/experiments/selective-task.js';

const task: BenchmarkRequest = {
  prompt: 'Review my eligibility, all orders and prior refunds.',
  customerId: 'C-101',
  scope: 'complete',
  execution: 'preview',
  repeats: 1,
};
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('local paired benchmark workspace', () => {
  it('runs the actual compiled fixture plan without claiming inference savings', async () => {
    const result = await new BenchmarkWorkspace().run(task);
    expect(result.setup.checks).toBeGreaterThanOrEqual(22);
    expect(result.setup.modelCalls).toBe(0);
    expect(result.pairs[0].equivalence).toBe('match');
    expect(result.pairs[0].foundry.mode).toBe('compiled_prefetch');
    for (const arm of [result.pairs[0].normal, result.pairs[0].foundry]) {
      expect(arm.reads).toHaveLength(3);
      expect(arm.response).toMatchObject({
        customerId: 'C-101',
        selectedOrderId: 'O-101',
        action: 'refund_review',
      });
      expect(Object.values(arm.checks).every(Boolean)).toBe(true);
      expect(arm.measurement).toMatchObject({
        origin: 'fixture',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
        modelCalls: null,
        costUsd: null,
      });
      expect(arm.estimatedCostUsd).toBeNull();
    }
  });

  it('selective contracts do not read unrelated resources, and no-context tasks read nothing', async () => {
    const workspace = new BenchmarkWorkspace();
    const orders = await workspace.run({ ...task, scope: 'orders', repeats: 2 });
    expect(orders.pairs[0].order).toEqual([...orders.pairs[1].order].reverse());
    for (const pair of orders.pairs) {
      for (const arm of [pair.normal, pair.foundry]) {
        expect(arm.reads.map((read) => read.operation)).toEqual(['orders.list']);
        expect(arm.response?.eligible).toBeNull();
        expect(arm.response?.refunds).toBeNull();
      }
    }
    const publicTask = await workspace.run({ ...task, scope: 'policy' });
    expect(publicTask.pairs[0].normal.reads).toEqual([]);
    expect(publicTask.pairs[0].foundry.reads).toEqual([]);
    expect(publicTask.pairs[0].foundry.mode).toBe('normal');
  });

  it('agent-decided tasks are offered a compiled tool and never labeled intent-verified', async () => {
    const result = await new BenchmarkWorkspace().run({ ...task, scope: 'agent_decides' });
    expect(result.pairs[0].foundry.mode).toBe('compiled_tool');
    expect(result.pairs[0].foundry.verification).toBe('facts_only');
  });

  it('honors a server-configured cost veto in actual routing without fabricating measured savings', async () => {
    let profileLookups = 0;
    const result = await new BenchmarkWorkspace({
      // Synthetic policy input, not a provider measurement or an inference benchmark result.
      prefetchCostComparison: () => {
        profileLookups++;
        return { pairedRequests: 8, baselineMeanCostUsd: 0.01, prefetchMeanCostUsd: 0.02 };
      },
    }).run({ ...task, scope: 'orders' });
    const pair = result.pairs[0];
    expect(pair.foundry.mode).toBe('normal');
    expect(pair.foundry.reason).toBe('measured_prefetch_cost_not_lower');
    expect(pair.foundry.fallback).toBe(false);
    expect(pair.equivalence).toBe('match');
    expect(pair.foundry.reads.map((read) => read.operation)).toEqual(['orders.list']);
    expect(Object.values(pair.foundry.checks).every(Boolean)).toBe(true);
    expect(pair.foundry.measurement.costUsd).toBeNull();
    expect(profileLookups).toBe(1);
    expect(pair.normal.selectorMs).toBe(0);
  });

  it('does not widen an existing caller customer allowlist or fall back around denial', async () => {
    const workspace = new BenchmarkWorkspace();
    await workspace.run(task);
    const result = await withIdentity(
      { ...localIdentity, tenantId: 'denied-tenant', customerIds: [] },
      () => workspace.run({ ...task, scope: 'orders' }),
    );
    for (const arm of [result.pairs[0].normal, result.pairs[0].foundry]) {
      expect(arm.measurement.outcome).toBe('denied');
      expect(arm.measurement.modelCalls).toBe(0);
      expect(arm.reads).toEqual([]);
      expect(arm.fallback).toBe(false);
    }
  });

  it('rejects concurrent batches and unsafe inputs before running a provider', async () => {
    const workspace = new BenchmarkWorkspace();
    const running = workspace.run(task);
    await expect(workspace.run(task)).rejects.toThrow('already running');
    await running;
    await expect(workspace.run({ ...task, repeats: 4 })).rejects.toThrow();
    await expect(workspace.run({ ...task, customerId: 'C-999' })).rejects.toThrow();
    await expect(workspace.run({ ...task, tenantId: 'another-tenant' })).rejects.toThrow();
    await expect(
      new BenchmarkWorkspace({ liveEnabled: false }).run({ ...task, execution: 'live' }),
    ).rejects.toThrow('disabled');
  });

  it('retains failures in both arms and leaves missing provider usage unknown', async () => {
    let closed = 0;
    const workspace = new BenchmarkWorkspace({
      liveEnabled: true,
      agentFactory: () =>
        ({
          start: async () => {
            throw new Error('Provider unavailable');
          },
          close: async () => {
            closed++;
          },
        }) as unknown as CustomerContextAgent,
    });
    const result = await workspace.run({ ...task, execution: 'live' });
    expect(closed).toBe(2);
    expect(result.pairs[0].equivalence).toBe('unavailable');
    for (const arm of [result.pairs[0].normal, result.pairs[0].foundry]) {
      expect(arm.measurement.outcome).toBe('failed');
      expect(arm.measurement.totalTokens).toBeNull();
      expect(arm.estimatedCostUsd).toBeNull();
      expect(arm.failure).toBeTruthy();
    }
    expect(result.pairs[0].foundry.reads).toHaveLength(3);
  });

  it('serves retained provider evidence instead of fabricating dashboard statistics', async () => {
    const evidence = await retainedEvidence();
    expect(evidence.requests).toBe(128);
    expect(evidence.arms.normal.mean.totalTokens).toBe(8856.28125);
    expect(evidence.arms.selective_direct.mean.totalTokens).toBe(5876.28125);
    expect(evidence.arms.handwritten_selective.mean.totalTokens!).toBeLessThan(
      evidence.arms.selective_direct.mean.totalTokens!,
    );
  });

  it('pins the same configured model for both arms and refuses unrelated model pricing', async () => {
    const models: (string | undefined)[] = [];
    const workspace = new BenchmarkWorkspace({
      liveEnabled: true,
      model: 'gpt-6.1-sol',
      agentFactory: (options) => {
        models.push(options.model);
        // Scripted usage exercises accounting only; this is not live-model evidence.
        return {
          start: async () => {},
          close: async () => {},
          runTask: async (agentTask: AgentTask<SelectiveResponse>) => {
            for (const tool of agentTask.tools)
              await agentTask.executeTool(agentTask.observer!, tool.name, {});
            agentTask.observer!.recordModelResponse(
              { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
              0,
              1,
            );
            const result: SelectiveResponse = {
              customerId: 'C-101',
              eligible: null,
              orders: [{ id: 'O-101', daysLate: 8 }],
              refunds: null,
              selectedOrderId: 'O-101',
              action: 'order_status',
              reply:
                'Your most delayed order is O-101, which is 8 days late. No external action has been taken.',
            };
            return { result, measurement: agentTask.complete(result, agentTask.observer!) };
          },
        } as unknown as CustomerContextAgent;
      },
    });
    const result = await workspace.run({ ...task, scope: 'orders', execution: 'live' });
    expect(models).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
    expect(result.model).toBe('gpt-6.1-sol');
    expect(result.pricing.applicable).toBe(false);
    expect(result.pairs[0].equivalence).toBe('match');
    for (const arm of [result.pairs[0].normal, result.pairs[0].foundry]) {
      expect(arm.measurement.totalTokens).toBe(120);
      expect(arm.estimatedCostUsd).toBeNull();
      expect(arm.measurement.costUsd).toBeNull();
    }
  });

  it('keeps the sandbox isolated from the registry and behind local mutation protections', async () => {
    const store = new Store(':memory:');
    stores.push(store);
    const { app } = createApp(store, false);
    await request(app).post('/api/benchmarks/runs').send(task).expect(403);
    await request(app)
      .post('/api/benchmarks/runs')
      .set('X-Foundry-Client', 'local-ui')
      .set('Origin', 'https://external.example')
      .send(task)
      .expect(403);
    const run = await request(app)
      .post('/api/benchmarks/runs')
      .set('X-Foundry-Client', 'local-ui')
      .send(task)
      .expect(201);
    expect(run.body.pairs[0].equivalence).toBe('match');
    expect(store.all('irArtifact')).toHaveLength(0);
    expect(store.all('toolTrace')).toHaveLength(0);
    await request(app).get('/api/benchmarks/config').expect(200);
    await request(app)
      .post('/api/benchmarks/runs')
      .set('X-Foundry-Client', 'local-ui')
      .send({ ...task, prompt: 'x' })
      .expect(400);
  });

  it('does not expose local benchmark execution through the hosted API', async () => {
    const store = new Store(':memory:');
    stores.push(store);
    const { app } = createApp(store, false, { auth: new ApiKeyAuthenticator([]) });
    await request(app).get('/api/benchmarks/config').expect(404);
    await request(app).post('/api/benchmarks/runs').send(task).expect(404);
  });
});
