import { createHash, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { TaskClient } from '../../src/integration/task-client.js';
import { Store } from '../../src/registry/store.js';
import { ArtifactSigner } from '../../src/security/signing.js';
import { ApiKeyAuthenticator, localIdentity } from '../../src/security/identity.js';
import { levels } from '../../src/compiler/task-ir.js';
import { runTaskPlan } from '../../src/runtime/task-runtime.js';
import {
  captureTravel,
  expectedTravelContext,
  travelAccess,
  travelInput,
  travelInputs,
  travelKind,
  travelName,
  travelRegistry,
} from '../../src/examples/travel-day.js';

describe('travel task lifecycle entirely through the SDK', () => {
  it('captures, compiles, verifies, shadows, approves, deploys, stresses and revokes over HTTP', async () => {
    const registry = travelRegistry();
    const identity = { ...localIdentity, toolScopes: [...travelAccess().scopes] };
    const key = 'travel_sdk_test_credential_000000000';
    const observerKey = 'travel_observer_credential_000000000';
    const otherKey = 'travel_other_principal_000000000000';
    const keys = generateKeyPairSync('ed25519');
    const signer = new ArtifactSigner(
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const store = new Store(':memory:');
    const auth = new ApiKeyAuthenticator([
      { sha256: createHash('sha256').update(key).digest('hex'), identity },
      {
        sha256: createHash('sha256').update(observerKey).digest('hex'),
        identity: { ...identity, permissions: ['read', 'observe', 'invoke'] },
      },
      {
        sha256: createHash('sha256').update(otherKey).digest('hex'),
        identity: { ...identity, principalId: 'other-principal' },
      },
    ]);
    const { app } = createApp(store, false, {
      auth,
      signer,
      tasks: {
        registry,
        context: travelAccess,
        verificationCases: () =>
          travelInputs.map((input) => ({ input, expected: expectedTravelContext(input) })),
        native: async (_kind, input, context) =>
          (await captureTravel(registry, travelInput.parse(input), context)).result,
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((done) => server.once('listening', done));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const calls: string[] = [];
    const client = (credential = key) =>
      new TaskClient({
        registry,
        context: travelAccess,
        endpoint,
        apiKey: credential,
        trustedPublicKey: publicKey,
        fetch: (url, init) => {
          calls.push(new URL(String(url)).pathname);
          return fetch(url, init);
        },
      });
    const sdk = client();
    try {
      const traces = await Promise.all(
        travelInputs.slice(0, 2).map((input) => captureTravel(registry, input)),
      );
      const uploaded = [];
      for (const trace of traces) uploaded.push(await sdk.observe(trace));
      const draft = await sdk.compile(
        travelName,
        uploaded.map((trace) => trace.id),
      );
      expect(draft.status).toBe('draft');
      expect(draft.plan.nodes).toHaveLength(13);
      expect(levels(draft.plan)).toHaveLength(6);
      await expect(sdk.approve(draft.id)).rejects.toMatchObject({ status: 409 });
      await expect(sdk.deploy(draft.id)).rejects.toMatchObject({ status: 409 });
      await expect(
        client(observerKey).compile(
          'unauthorized_plan',
          uploaded.map((trace) => trace.id),
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(client(otherKey).verify(draft.id)).rejects.toMatchObject({ status: 404 });
      const verified = await sdk.verify(draft.id);
      expect(verified.checks.every((check) => check.passed)).toBe(true);
      await sdk.approve(draft.id);
      await expect(sdk.deploy(draft.id)).rejects.toMatchObject({ status: 409 });
      for (const input of travelInputs)
        expect((await sdk.shadow(draft.id, input)).status).toBe('match');
      const approved = await sdk.deploy(draft.id);
      expect((await sdk.capabilities()).map((artifact) => artifact.id)).toContain(draft.id);
      const results = await Promise.all(
        Array.from({ length: 48 }, (_, index) =>
          sdk.execute({ name: travelName, kind: travelKind, input: travelInputs[index % 3] }),
        ),
      );
      results.forEach((run, index) =>
        expect(run).toMatchObject({
          mode: 'compiled',
          outcome: 'success',
          result: expectedTravelContext(travelInputs[index % 3]),
          llmInvocations: 0,
          toolCalls: 13,
        }),
      );
      for (const fault of ['malformed', 'cross_user'] as const) {
        const run = await runTaskPlan(
          approved,
          travelKind,
          travelInputs[0],
          travelAccess(),
          travelRegistry({ fault }),
        );
        expect(run.result).toBeUndefined();
        expect(run.outcome).toBe(fault === 'cross_user' ? 'denied' : 'unresolved');
      }
      const denied = await sdk.execute({
        name: travelName,
        kind: travelKind,
        input: { ...travelInputs[0], userId: 'bob' },
      });
      expect(denied.outcome).toBe('denied');
      await sdk.verify(draft.id);
      await sdk.approve(draft.id);
      await expect(sdk.deploy(draft.id)).rejects.toMatchObject({ status: 409 });
      for (const input of travelInputs) await sdk.shadow(draft.id, input);
      await sdk.deploy(draft.id);
      await sdk.revoke(draft.id);
      expect(
        (await sdk.execute({ name: travelName, kind: travelKind, input: travelInputs[0] })).outcome,
      ).toBe('unresolved');
      for (const action of ['verify', 'approve', 'deploy', 'revoke', 'shadow'])
        expect(calls.some((path) => path.endsWith(`/${action}`))).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });
});
