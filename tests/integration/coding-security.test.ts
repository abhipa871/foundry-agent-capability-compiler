import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { Store } from '../../src/registry/store.js';
import { CodingRegistry } from '../../src/registry/coding.js';
import { codingDigest } from '../../src/verification/coding.js';
import type { CodexRun, runCodexTask } from '../../src/agent/codex.js';

describe('coding registry security gates', () => {
  let store: Store;
  let context: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.stubEnv('FOUNDRY_CODEX_DRY_RUN', 'true');
    store = new Store(':memory:');
    context = createApp(store, false);
  });
  afterEach(() => {
    store.close();
    vi.unstubAllEnvs();
  });
  const post = (path: string, body: unknown = {}) =>
    request(context.app)
      .post(`/api${path}`)
      .set('X-Foundry-Client', 'local-ui')
      .send(body as object);
  async function prepared() {
    const session = await context.service.runCodingAgent('Check the project package manifest.');
    const draft = context.service.prepareCodingSession(session.id);
    const cap = context.service.coding.configure(draft.id, {
      ...draft.policy,
      assertions: [{ kind: 'file_exists', path: 'package.json' }],
    });
    context.service.coding.verify(cap.id);
    return cap;
  }

  it('requires assertions, verification and approval; rejects unsafe policy fields', async () => {
    const session = await context.service.runCodingAgent('Check the project package manifest.');
    const cap = context.service.prepareCodingSession(session.id);
    expect(context.service.coding.verify(cap.id).status).toBe('draft');
    await post(`/coding-capabilities/${cap.id}/approve`, { note: 'Should be blocked.' }).expect(
      409,
    );
    await post(`/coding-capabilities/${cap.id}/deploy`).expect(409);
    await post(`/coding-capabilities/${cap.id}/deploy`, { skipVerification: true }).expect(400);
    for (const policy of [
      { ...cap.policy, sandbox: 'danger-full-access' },
      { ...cap.policy, networkAccess: true },
      { ...cap.policy, timeoutMs: -1 },
      { ...cap.policy, maxAttempts: 2 },
      { ...cap.policy, command: 'arbitrary shell input' },
      { ...cap.policy, assertions: [{ kind: 'shell', command: 'anything' }] },
    ])
      await post(`/coding-capabilities/${cap.id}/policy`, policy).expect(400);
    expect(store.all('agentDeployment')).toHaveLength(0);
  });

  it('edits create a new unapproved version and tampered artifacts cannot deploy', async () => {
    const cap = await prepared();
    context.service.coding.approve(cap.id, 'Reviewed assertions and permissions.');
    const edited = context.service.coding.configure(cap.id, { ...cap.policy, timeoutMs: 60000 });
    expect(edited.version).toBe(3);
    expect(edited.status).toBe('draft');
    expect(edited.approvedDigest).toBeUndefined();
    await post(`/coding-capabilities/${edited.id}/deploy`).expect(409);
    const changed = context.service.coding.get(cap.id);
    changed.prompt += '\nUnreviewed task';
    store.put('codingCapability', changed);
    await post(`/coding-capabilities/${cap.id}/deploy`).expect(409);
    expect(context.service.coding.verify(cap.id).status).toBe('draft');
  });

  it('blocks stale verification and simulation-to-real transitions', async () => {
    const cap = await prepared();
    const approved = context.service.coding.approve(cap.id, 'Reviewed assertions and permissions.');
    store.put('codingCapability', { ...approved, verifiedAt: '2000-01-01T00:00:00Z' });
    await post(`/coding-capabilities/${cap.id}/deploy`).expect(409);
    store.put('codingCapability', approved);
    vi.stubEnv('FOUNDRY_CODEX_DRY_RUN', 'false');
    await post(`/coding-capabilities/${cap.id}/deploy`).expect(409);
  });

  it('revokes active tasks and preserves registry evidence on history reset', async () => {
    const cap = await prepared();
    context.service.coding.approve(cap.id, 'Reviewed assertions and permissions.');
    await post(`/coding-capabilities/${cap.id}/deploy`).expect(201);
    expect(store.deployments()[cap.name]).toBe(cap.id);
    await post('/agent/sessions/reset').expect(409);
    await post(`/coding-capabilities/${cap.id}/revoke`).expect(200);
    expect(store.deployments()[cap.name]).toBeUndefined();
    await post(`/coding-capabilities/${cap.id}/deploy`).expect(409);
  });

  it('failed postconditions never publish a deployment and concurrent launches are blocked', async () => {
    const cap = await prepared();
    const configured = context.service.coding.configure(cap.id, {
      ...cap.policy,
      assertions: [{ kind: 'output_contains', text: 'Dry-run' }],
    });
    context.service.coding.verify(configured.id);
    context.service.coding.approve(configured.id, 'Reviewed required output.');
    let finish!: (result: CodexRun) => void;
    const runner = vi.fn<typeof runCodexTask>(
      () =>
        new Promise<CodexRun>((resolve) => {
          finish = resolve;
        }),
    );
    const registry = new CodingRegistry(store, () => {}, runner);
    const first = registry.deploy(configured.id);
    await expect(registry.deploy(configured.id)).rejects.toThrow('already running');
    await expect(registry.explore(async () => {})).rejects.toThrow('already running');
    finish({
      status: 'success',
      output: 'wrong result',
      events: [],
      durationMs: 1,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, estimated: false },
    });
    const deployment = await first;
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1]).toMatchObject({
      policy: configured.policy,
      timeoutMs: configured.policy.timeoutMs,
    });
    expect(deployment.status).toBe('failed');
    expect(deployment.error).toContain('Post-execution');
    expect(store.deployments()[configured.name]).toBeUndefined();
    expect(registry.get(configured.id).status).toBe('draft');
  });

  it('historical deployments are imported once as unapproved registry drafts', async () => {
    const session = await context.service.runCodingAgent('Check the project package manifest.');
    store.put('agentDeployment', {
      id: 'legacy',
      sessionId: session.id,
      createdAt: session.createdAt,
      status: 'success',
      output: 'done',
      usage: session.usageBefore,
      tokenDelta: 0,
      tokenReductionPercent: 0,
    });
    const restarted = createApp(store, false);
    const entries = restarted.service.state().codingCapabilities;
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('draft');
    expect(store.get('agentDeployment', 'legacy')?.capabilityId).toBe(entries[0].id);
    expect(codingDigest(entries[0])).toBe(entries[0].digest);
    expect(createApp(store, false).service.state().codingCapabilities).toHaveLength(1);
  });

  it('rejects missing mutation headers, external origins and unknown providers', async () => {
    await request(context.app)
      .post('/api/agent/sessions')
      .send({ task: 'Do a coding task.' })
      .expect(403);
    await post('/agent/sessions', { task: 'Do a coding task.' })
      .set('Origin', 'https://example.com')
      .expect(403);
    await post('/agent/sessions', { task: 'Do a coding task.', providerId: 'unknown' }).expect(400);
  });
});
