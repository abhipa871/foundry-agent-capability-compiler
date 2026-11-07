import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist-sdk', { recursive: true });
writeFileSync(
  'dist-sdk/package.json',
  JSON.stringify(
    {
      name: '@foundry/read-runtime',
      version: '0.1.0',
      type: 'module',
      private: true,
      engines: { node: '>=24' },
      exports: { '.': { types: './integration/client.d.ts', import: './integration/client.js' } },
      dependencies: { zod: '4.6.5' },
    },
    null,
    2,
  ) + '\n',
);
