import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Store } from '../../src/registry/store.js';

const previousDryRun = process.env.FOUNDRY_CODEX_DRY_RUN;

describe('coding-agent chat deployment flow', () => {
  afterEach(() => {
    if (previousDryRun === undefined) delete process.env.FOUNDRY_CODEX_DRY_RUN;
    else process.env.FOUNDRY_CODEX_DRY_RUN = previousDryRun;
  });

  it('records a chat trajectory and measures token usage after deployment', async () => {
    process.env.FOUNDRY_CODEX_DRY_RUN = 'true';
    const store = new Store(':memory:');
    try {
      const { app } = createApp(store, false);
      const session = await request(app)
        .post('/api/agent/sessions')
        .set('X-Foundry-Client', 'local-ui')
        .send({
          task: 'Add a small documentation note about branch pruning for coding-agent runs.',
          providerId: 'codex-cli-gpt-5-5-high',
        })
        .expect(201);

      expect(session.body.status).toBe('success');
      expect(session.body.usageBefore.totalTokens).toBe(570);
      expect(session.body.branchAnalysis.discarded).toHaveLength(1);

      await request(app)
        .post(`/api/agent/sessions/${session.body.id}/deploy`)
        .set('X-Foundry-Client', 'local-ui')
        .send({})
        .expect(409);
      const initial = (await request(app).get('/api/state')).body.codingCapabilities[0];
      const configured = await request(app)
        .post(`/api/coding-capabilities/${initial.id}/policy`)
        .set('X-Foundry-Client', 'local-ui')
        .send({ ...initial.policy, assertions: [{ kind: 'file_exists', path: 'package.json' }] })
        .expect(201);
      const capId = configured.body.id;
      await request(app)
        .post(`/api/coding-capabilities/${capId}/verify`)
        .set('X-Foundry-Client', 'local-ui')
        .send({})
        .expect(200);
      await request(app)
        .post(`/api/coding-capabilities/${capId}/approve`)
        .set('X-Foundry-Client', 'local-ui')
        .send({ note: 'Reviewed safe simulation and checks.' })
        .expect(200);

      const deployment = await request(app)
        .post(`/api/agent/sessions/${session.body.id}/deploy`)
        .set('X-Foundry-Client', 'local-ui')
        .send({})
        .expect(201);

      expect(deployment.body.status).toBe('success');
      expect(deployment.body.usage.totalTokens).toBe(156);
      expect(deployment.body.tokenDelta).toBe(414);
      expect(deployment.body.tokenReductionPercent).toBeCloseTo(72.6);

      const state = await request(app).get('/api/state').expect(200);
      expect(state.body.agentSessions).toHaveLength(1);
      expect(state.body.agentDeployments).toHaveLength(1);
      expect(state.body.agentProviders[0].id).toBe('codex-cli-gpt-5-5-high');
      expect(state.body.codingCapabilities).toHaveLength(2);
      expect(state.body.deployments[configured.body.name]).toBe(capId);
      expect(deployment.body.capabilityId).toBe(capId);
      expect(deployment.body.simulated).toBe(true);
    } finally {
      store.close();
    }
  });
});
