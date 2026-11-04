import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist-sdk', { recursive: true });
writeFileSync(
  'dist-sdk/package.json',
  JSON.stringify(
    {
      name: '@foundry/read-runtime',
      version: '0.2.0',
      type: 'module',
      private: true,
      engines: { node: '>=24' },
      exports: {
        '.': { types: './integration/index.d.ts', import: './integration/index.js' },
        './legacy': { types: './integration/client.d.ts', import: './integration/client.js' },
        './providers': { types: './agent/providers.d.ts', import: './agent/providers.js' },
      },
      dependencies: { zod: '4.6.5' },
    },
    null,
    2,
  ) + '\n',
);
