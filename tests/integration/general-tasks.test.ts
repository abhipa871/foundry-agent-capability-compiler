import { createHash, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { DomainError } from '../../src/domain.js';
import { createApp } from '../../src/app.js';
import { ContractRegistry, digest, json } from '../../src/compiler/contracts.js';
import { compileTask } from '../../src/compiler/task-ir.js';
import { TaskObserver } from '../../src/exploration/task-observer.js';
import {
  TaskClient,
  selectTaskExecution,
  verifyTaskTicket,
} from '../../src/integration/task-client.js';
import { TaskRegistry, type GenericTaskOptions } from '../../src/registry/tasks.js';
import { Store } from '../../src/registry/store.js';
import { runTaskPlan, type TaskArtifact } from '../../src/runtime/task-runtime.js';
import { ArtifactSigner } from '../../src/security/signing.js';
import { ApiKeyAuthenticator, localIdentity, withIdentity } from '../../src/security/identity.js';
import {
  captureDeparture,
  departureAccess,
  departureInputs,
  departureInput,
  departureKind,
  departureName,
  departureRegistry,
  expectedDeparture,
} from '../../src/examples/departure.js';

const identity = { ...localIdentity, toolScopes: [...departureAccess().scopes] };
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
const setup = () => {
  const store = new Store(':memory:');
  stores.push(store);
  const registry = departureRegistry();
  const options: GenericTaskOptions = {
    registry,
    context: departureAccess,
    verificationCases: () =>
      departureInputs.map((input) => ({ input, expected: expectedDeparture(input) })),
    native: async (_kind, input, context) =>
      (await captureDeparture(registry, departureInput.parse(input), context)).result,
  };
  return { store, registry, options, lifecycle: new TaskRegistry(store, options) };
};
async function approve() {
  const state = setup();
  const traces = await Promise.all(
    departureInputs.slice(0, 2).map((input) => captureDeparture(state.registry, input)),
  );
  traces.forEach((trace) => state.lifecycle.ingest(trace));
  const draft = state.lifecycle.compile(
    departureName,
    traces.map((trace) => trace.id),
  );
  const verified = await state.lifecycle.verify(draft.id);
  expect(verified.checks.every((check) => check.passed)).toBe(true);
  const artifact = state.lifecycle.approve(draft.id);
  expect(() => state.lifecycle.deploy(draft.id)).toThrow('shadow coverage');
  for (const input of departureInputs)
    expect((await state.lifecycle.shadow(draft.id, input)).status).toBe('match');
  state.lifecycle.deploy(draft.id);
  return { ...state, traces, artifact };
}

describe('domain-independent compilation, runtime and SDK', () => {
  it('blocks failed shadow evidence and requires new shadow coverage after revalidation', async () =>
    withIdentity(identity, async () => {
      const { lifecycle, options, store, artifact } = await approve();
      const hostileBaseline = new TaskRegistry(store, { ...options, native: async () => json({}) });
      expect((await hostileBaseline.shadow(artifact.id, departureInputs[0])).status).toBe('failed');
      expect(() => lifecycle.deploy(artifact.id)).toThrow('shadow coverage');
      await lifecycle.verify(artifact.id);
      lifecycle.approve(artifact.id);
      expect(() => lifecycle.deploy(artifact.id)).toThrow('shadow coverage');
      for (const input of departureInputs) await lifecycle.shadow(artifact.id, input);
      expect(lifecycle.deploy(artifact.id).status).toBe('approved');
    }));

  it('requires explicit replay consent and blocks common credential fields from evidence', async () => {
    const registry = departureRegistry();
    const unsafe = new ContractRegistry();
    const tool = registry.tool('calendar_next');
    unsafe.registerTool({ ...tool, replaySafe: false });
    unsafe.registerTask({ ...registry.task(departureKind), tools: ['calendar_next'] });
    const observer = new TaskObserver(unsafe, departureKind, departureInputs[0], departureAccess());
    await expect(
      observer.call('event', 'calendar_next', {
        userId: { source: 'input', path: ['userId'] },
        now: { source: 'input', path: ['now'] },
      }),
    ).rejects.toThrow('replay evidence');
    const trace = await captureDeparture(registry, departureInputs[0]);
    const state = setup();
    expect(() =>
      withIdentity(identity, () =>
        state.lifecycle.ingest({ ...trace, result: { api_key: 'fake-secret' } }),
      ),
    ).toThrow('Secret-bearing');
  });
  it('does not echo adapter error secrets in checkpoints', async () =>
    withIdentity(identity, async () => {
      const { registry, artifact } = await approve();
      const failing = new ContractRegistry();
      for (const name of registry.task(departureKind).tools)
        failing.registerTool({
          ...registry.tool(name),
          run: async () => {
            throw new DomainError('fake-secret-provider-detail', 503);
          },
        });
      failing.registerTask(registry.task(departureKind));
      const run = await runTaskPlan(
        artifact,
        departureKind,
        departureInputs[0],
        departureAccess(),
        failing,
      );
      expect(run.outcome).toBe('unresolved');
      expect(JSON.stringify(run)).not.toContain('fake-secret-provider-detail');
    }));

  it('compiles personal multi-step reads and pure calculation, generalizes input and preserves outputs under concurrent stress', async () =>
    withIdentity(identity, async () => {
      const { lifecycle, registry, artifact } = await approve();
      const runs = await Promise.all(
        Array.from({ length: 120 }, (_, index) =>
          lifecycle.execute(departureName, departureKind, departureInputs[index % 3]),
        ),
      );
      runs.forEach((run, index) =>
        expect(run).toMatchObject({
          outcome: 'success',
          mode: 'compiled',
          result: expectedDeparture(departureInputs[index % 3]),
          llmInvocations: 0,
          toolCalls: 5,
        }),
      );
      expect(
        selectTaskExecution({
          registry,
          context: departureAccess(),
          artifact,
          kind: departureKind,
          input: departureInputs[0],
          requirement: 'known',
          requiredTools: registry.task(departureKind).tools,
        }).mode,
      ).toBe('compiled_prefetch');
      expect(
        selectTaskExecution({
          registry,
          context: departureAccess(),
          artifact,
          kind: departureKind,
          input: departureInputs[0],
          requirement: 'agent_decides',
          requiredTools: registry.task(departureKind).tools,
        }).mode,
      ).toBe('compiled_tool');
      expect(
        selectTaskExecution({
          registry,
          context: departureAccess(),
          artifact,
          kind: departureKind,
          input: departureInputs[0],
          requirement: 'known',
          requiredTools: ['calendar_next'],
        }).mode,
      ).toBe('normal');
    }));

  it('supports another domain, nested values, boolean and numeric inputs without engine changes', async () => {
    const registry = new ContractRegistry();
    const inputSchema = z
      .object({ project: z.string(), limit: z.number().int(), includeArchived: z.boolean() })
      .strict();
    registry.registerTool({
      name: 'files.list',
      version: '2',
      description: 'List project files.',
      effect: 'read',
      replaySafe: true,
      scopes: ['files:read'],
      input: inputSchema,
      output: z.object({ items: z.array(z.string()) }).strict(),
      timeoutMs: 100,
      authorize: () => true,
      validateResult: () => true,
      run: async (args) => ({ items: [(args as { project: string }).project] }),
    });
    registry.registerTask({
      kind: 'project_inventory',
      version: '3',
      description: 'Project inventory.',
      input: inputSchema,
      output: z.object({ files: z.object({ items: z.array(z.string()) }) }).strict(),
      tools: ['files.list'],
      maxAgeMs: 1000,
      maxConcurrency: 2,
      timeoutMs: 200,
      authorize: () => true,
    });
    const context = { ...departureAccess(), scopes: ['files:read'] };
    const traces = [];
    for (const project of ['alpha', 'beta']) {
      const observer = new TaskObserver(
        registry,
        'project_inventory',
        { project, limit: 3, includeArchived: false },
        context,
      );
      await observer.call('files', 'files.list', {
        project: { source: 'input', path: ['project'] },
        limit: { source: 'input', path: ['limit'] },
        includeArchived: { source: 'input', path: ['includeArchived'] },
      });
      traces.push(observer.finish({ files: { source: 'ref', node: 'files', path: [] } }));
    }
    const plan = compileTask(traces, 'load_project_files', registry);
    const artifact: TaskArtifact = {
      id: crypto.randomUUID(),
      tenantId: context.tenantId,
      plan,
      digest: digest(plan),
      status: 'approved',
      verifiedDigest: digest(plan),
      approvedDigest: digest(plan),
      checks: [{ name: 'test', passed: true }],
    };
    const run = await runTaskPlan(
      artifact,
      'project_inventory',
      { project: 'gamma', limit: 10, includeArchived: true },
      context,
      registry,
    );
    expect(run.result).toEqual({ files: { items: ['gamma'] } });
  });

  it('rejects single/duplicate evidence, invented lineage, differing policy and unsupported effects', async () => {
    const registry = departureRegistry();
    const traces = await Promise.all(
      departureInputs.slice(0, 2).map((input) => captureDeparture(registry, input)),
    );
    expect(() => compileTask([traces[0]], departureName, registry)).toThrow();
    expect(() => compileTask([traces[0], traces[0]], departureName, registry)).toThrow();
    const changed = structuredClone(traces[1]);
    changed.events[0].argsValue = { userId: 'alice', now: departureInputs[0].now };
    expect(() => compileTask([traces[0], changed], departureName, registry)).toThrow();
    changed.policyVersion = 'other';
    expect(() => compileTask([traces[0], changed], departureName, registry)).toThrow();
    expect(() => json(JSON.parse('{"__proto__":{"admin":true}}'))).toThrow();
    expect(() =>
      registry.registerTool({
        ...registry.tool('calendar_next'),
        name: 'unsafe',
        effect: 'write' as 'read',
      }),
    ).toThrow();
  });

  it('fails closed before adapter work on tamper, scope, tenant, principal, policy, schema and contract drift', async () =>
    withIdentity(identity, async () => {
      const { artifact } = await approve();
      let calls = 0;
      const registry = departureRegistry({ onCall: () => calls++ });
      for (const context of [
        { ...departureAccess(), scopes: [] },
        { ...departureAccess(), tenantId: 'other' },
        { ...departureAccess(), principalId: 'other' },
        { ...departureAccess(), policyVersion: 'other' },
        { ...departureAccess(), snapshot: 'other' },
        { ...departureAccess(), observedAt: 0 },
      ])
        expect(
          (await runTaskPlan(artifact, departureKind, departureInputs[0], context, registry))
            .outcome,
        ).not.toBe('success');
      expect(
        (
          await runTaskPlan(
            { ...artifact, digest: '0'.repeat(64) },
            departureKind,
            departureInputs[0],
            departureAccess(),
            registry,
          )
        ).outcome,
      ).toBe('unresolved');
      expect(
        (
          await runTaskPlan(
            artifact,
            departureKind,
            { unexpected: true },
            departureAccess(),
            registry,
          )
        ).outcome,
      ).toBe('unresolved');
      expect(
        (
          await runTaskPlan(
            artifact,
            departureKind,
            departureInputs[0],
            departureAccess(),
            departureRegistry({ toolVersion: '2' }),
          )
        ).outcome,
      ).toBe('unresolved');
      expect(calls).toBe(0);
    }));

  it('returns a precise checkpoint or denial for timeouts, malformed outputs and cross-user output', async () =>
    withIdentity(identity, async () => {
      const { artifact } = await approve();
      for (const fault of ['timeout', 'malformed', 'cross_user'] as const) {
        const run = await runTaskPlan(
          artifact,
          departureKind,
          departureInputs[0],
          departureAccess(),
          departureRegistry({ fault }),
        );
        expect(run.result).toBeUndefined();
        expect(run.outcome).toBe(fault === 'cross_user' ? 'denied' : 'unresolved');
        if (run.checkpoint) {
          expect(run.checkpoint.completedEffects).toEqual([]);
          expect(run.checkpoint.completedNodes).toContain('appointment');
          expect(run.checkpoint.completedNodes).not.toContain('route');
        }
      }
    }));

  it('exercises signed SDK HTTP execution, forged tickets, expiration, RBAC, tenant isolation and revocation', async () =>
    withIdentity(identity, async () => {
      const { store, registry, options, lifecycle, artifact } = await approve();
      const keys = generateKeyPairSync('ed25519');
      const signer = new ArtifactSigner(
        keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      );
      const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const key = 'generic_test_credential_000000000000';
      const observerKey = 'observer_test_credential_0000000000';
      const otherKey = 'other_tenant_test_credential_000000';
      const narrowKey = 'narrow_scope_test_credential_000000';
      const auth = new ApiKeyAuthenticator([
        {
          sha256: createHash('sha256').update(narrowKey).digest('hex'),
          identity: { ...identity, toolScopes: [] },
        },
        { sha256: createHash('sha256').update(key).digest('hex'), identity },
        {
          sha256: createHash('sha256').update(observerKey).digest('hex'),
          identity: { ...identity, permissions: ['read', 'observe'] },
        },
        {
          sha256: createHash('sha256').update(otherKey).digest('hex'),
          identity: { ...identity, tenantId: 'other' },
        },
      ]);
      const { app } = createApp(store, false, { auth, signer, tasks: options });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const client = new TaskClient({
          registry,
          context: departureAccess,
          endpoint,
          apiKey: key,
          trustedPublicKey: publicKey,
        });
        const run = await client.execute({
          name: departureName,
          kind: departureKind,
          input: departureInputs[2],
        });
        expect(run.result).toEqual(expectedDeparture(departureInputs[2]));
        await request(app)
          .get(`/api/v2/tasks/runtime/${departureName}`)
          .set('Authorization', `Bearer ${narrowKey}`)
          .expect(403);
        const unauthenticated = new TaskClient({
          registry,
          context: departureAccess,
          endpoint,
          apiKey: 'unknown_credential_000000000000000',
          trustedPublicKey: publicKey,
        });
        expect(
          (
            await unauthenticated.execute({
              name: departureName,
              kind: departureKind,
              input: departureInputs[0],
            })
          ).outcome,
        ).toBe('denied');
        await request(app)
          .post(`/api/v2/tasks/capabilities/${artifact.id}/approve`)
          .send({})
          .expect(401);
        await request(app)
          .post(`/api/v2/tasks/capabilities/${artifact.id}/approve`)
          .set('Authorization', `Bearer ${observerKey}`)
          .send({})
          .expect(403);
        await request(app)
          .get(`/api/v2/tasks/runtime/${departureName}`)
          .set('Authorization', `Bearer ${otherKey}`)
          .expect(404);
        const now = Date.now();
        const ticket = signer.signTask({
          format: 'foundry-task-ticket-v1',
          tenantId: identity.tenantId,
          principalId: identity.principalId,
          issuedAt: now,
          expiresAt: now + 1000,
          artifact,
        });
        expect(() =>
          verifyTaskTicket(
            { ...ticket, payload: ticket.payload + ' ' },
            publicKey,
            departureAccess(),
            departureName,
          ),
        ).toThrow();
        expect(() =>
          verifyTaskTicket(ticket, publicKey, departureAccess(), departureName, now + 2000),
        ).toThrow();
        lifecycle.revoke(artifact.id);
        expect(
          (
            await client.execute({
              name: departureName,
              kind: departureKind,
              input: departureInputs[0],
            })
          ).outcome,
        ).toBe('unresolved');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }));
});
