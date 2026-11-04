import { ArtifactSigner } from './security/signing.js';
import { createApp } from './app.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ApiKeyAuthenticator, identitySchema, localIdentity } from './security/identity.js';
import { Store } from './registry/store.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContractRegistry } from './compiler/contracts.js';
import { currentIdentity } from './security/identity.js';
import type { GenericTaskOptions } from './registry/tasks.js';
import { createDemoTaskWorkspace } from './examples/task-workspace.js';

const store = new Store(process.env.FOUNDRY_DB ?? 'data/foundry.sqlite');
const auth = process.env.FOUNDRY_IDENTITY_CONFIG
  ? new ApiKeyAuthenticator(
      z
        .array(z.object({ sha256: z.string(), identity: identitySchema }).strict())
        .min(1)
        .parse(JSON.parse(readFileSync(process.env.FOUNDRY_IDENTITY_CONFIG, 'utf8'))),
    )
  : undefined;
const signer = process.env.FOUNDRY_SIGNING_KEY_FILE
  ? new ArtifactSigner(readFileSync(process.env.FOUNDRY_SIGNING_KEY_FILE, 'utf8'))
  : undefined;
// Only operator-controlled code can register handlers; HTTP/model payloads cannot install tools.
const demo = !auth && !process.env.FOUNDRY_TASK_MODULE ? createDemoTaskWorkspace() : undefined;
const tasks: GenericTaskOptions = process.env.FOUNDRY_TASK_MODULE
  ? await (
      await import(pathToFileURL(resolve(process.env.FOUNDRY_TASK_MODULE)).href)
    ).createTaskOptions()
  : (demo?.tasks ?? {
      registry: new ContractRegistry(),
      context: () => ({
        tenantId: currentIdentity().tenantId,
        principalId: currentIdentity().principalId,
        scopes: [...currentIdentity().toolScopes],
        policyVersion: 'application-policy-v1',
        snapshot: 'application-snapshot-v1',
        observedAt: Date.now(),
      }),
      verificationCases: () => [],
    });
const { app } = createApp(store, !auth, {
  auth,
  signer,
  tasks,
  // Local operator-owned registrations define the available tool scopes. Hosted identities
  // always come from authentication and never inherit these development privileges.
  localTaskIdentity: auth
    ? undefined
    : (demo?.identity ?? {
        ...localIdentity,
        toolScopes: [...new Set(tasks.registry.catalog().tools.flatMap((tool) => tool.scopes))],
      }),
  taskExamples: demo?.examples,
  taskSamples: demo?.samples,
});
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Foundry local demo: http://127.0.0.1:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
