import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createDemoTaskWorkspace } from '../../src/examples/task-workspace.js';
import { Store } from '../../src/registry/store.js';
import { ApiKeyAuthenticator } from '../../src/security/identity.js';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  const demo = createDemoTaskWorkspace();
  const options = {
    tasks: demo.tasks,
    localTaskIdentity: demo.identity,
    taskExamples: demo.examples,
    taskSamples: demo.samples,
  };
  return { store, demo, options, app: createApp(store, false, options).app };
}

describe('contract-driven compiler workspace', () => {
  it('compiles and independently gates multiple task families with their own policies and scopes', async () => {
    const { app, demo } = setup();
    const post = (path: string, body: object) =>
      request(app).post(`/api/v2/tasks${path}`).set('X-Foundry-Client', 'local-ui').send(body);
    const initial = await request(app).get('/api/v2/tasks/workspace').expect(200);
    expect(initial.body.tasks.map((task: { kind: string }) => task.kind).sort()).toEqual([
      'personal_departure',
      'travel_day',
    ]);
    expect(initial.body.identity.principalId).toBe(demo.identity.principalId);
    expect(initial.body.artifacts).toEqual([]);
    for (const kind of initial.body.fixtureKinds as string[]) {
      const sample = await post('/samples', { kind }).expect(201);
      expect(sample.body.modelCalls).toBe(0);
      expect(sample.body.origin).toBe('fixture');
      const draft = (
        await post('/compile', { name: `workspace_${kind}`, traceIds: sample.body.ids }).expect(201)
      ).body;
      await post(`/capabilities/${draft.id}/approve`, {}).expect(409);
      const verified = (await post(`/capabilities/${draft.id}/verify`, {}).expect(200)).body;
      expect(verified.status).toBe('verified');
      expect(verified.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
      await post(`/capabilities/${draft.id}/approve`, {}).expect(200);
      await post(`/capabilities/${draft.id}/deploy`, {}).expect(409);
      for (const example of demo.examples.filter((example) => example.kind === kind)) {
        const shadow = await post(`/capabilities/${draft.id}/shadow`, {
          input: example.input,
        }).expect(200);
        expect(shadow.body.status).toBe('match');
      }
      await post(`/capabilities/${draft.id}/deploy`, {}).expect(200);
      const workspace = (await request(app).get('/api/v2/tasks/workspace').expect(200)).body;
      expect(workspace.active[draft.plan.name]).toBe(draft.id);
      expect(workspace.shadowCoverage[draft.id]).toEqual({
        matchedInputs: 3,
        failed: 0,
        required: 3,
        ready: true,
      });
      expect(
        workspace.traces
          .filter((trace: { kind: string }) => trace.kind === kind)
          .every((trace: { source: string }) => trace.source === 'fixture'),
      ).toBe(true);
      const run = await post('/dispatch', {
        name: draft.plan.name,
        kind,
        input: demo.examples.find((example) => example.kind === kind)!.input,
      }).expect(200);
      expect(run.body.outcome).toBe('success');
      expect(run.body.llmInvocations).toBe(0);
      await post(`/capabilities/${draft.id}/revoke`, {}).expect(200);
      const revoked = (await request(app).get('/api/v2/tasks/workspace').expect(200)).body;
      expect(revoked.active[draft.plan.name]).toBeUndefined();
    }
    await request(app).post('/api/v2/tasks/samples').send({ kind: 'travel_day' }).expect(403);
    await request(app)
      .get('/api/v2/tasks/workspace')
      .set('Origin', 'https://untrusted.example')
      .expect(403);
    await post('/samples', { kind: 'unknown_task' }).expect(404);
  });

  it('keeps authenticated workspaces scoped and never enables local sample capture or identity override', async () => {
    const { store, demo, options, app } = setup();
    await request(app)
      .post('/api/v2/tasks/samples')
      .set('X-Foundry-Client', 'local-ui')
      .send({ kind: 'travel_day' })
      .expect(201);
    const key = 'workspace_readonly_credential_00000000';
    const auth = new ApiKeyAuthenticator([
      {
        sha256: createHash('sha256').update(key).digest('hex'),
        identity: { ...demo.identity, principalId: 'other-reader', permissions: ['read'] },
      },
    ]);
    const hosted = createApp(store, false, { ...options, auth }).app;
    await request(hosted).get('/api/v2/tasks/workspace').expect(401);
    const workspace = (
      await request(hosted)
        .get('/api/v2/tasks/workspace')
        .set('Authorization', `Bearer ${key}`)
        .expect(200)
    ).body;
    expect(workspace.identity.principalId).toBe('other-reader');
    expect(workspace.identity.permissions).toEqual(['read']);
    expect(workspace.traces).toEqual([]);
    expect(workspace.examples).toEqual([]);
    expect(workspace.fixtureKinds).toEqual([]);
    expect(workspace.localDemo).toBe(false);
    await request(hosted)
      .post('/api/v2/tasks/samples')
      .set('Authorization', `Bearer ${key}`)
      .send({ kind: 'travel_day' })
      .expect(403);
    const adminKey = 'workspace_admin_credential_000000000';
    const adminAuth = new ApiKeyAuthenticator([
      { sha256: createHash('sha256').update(adminKey).digest('hex'), identity: demo.identity },
    ]);
    const admin = createApp(store, false, { ...options, auth: adminAuth }).app;
    await request(admin)
      .post('/api/v2/tasks/samples')
      .set('Authorization', `Bearer ${adminKey}`)
      .send({ kind: 'travel_day' })
      .expect(404);
  });
});
