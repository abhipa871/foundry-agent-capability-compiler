import { ArtifactSigner } from './security/signing.js';
import { createApp } from './app.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ApiKeyAuthenticator, identitySchema } from './security/identity.js';
import { Store } from './registry/store.js';

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
const { app } = createApp(store, !auth, { auth, signer });
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
