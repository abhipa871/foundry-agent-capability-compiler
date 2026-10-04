import { Store } from '../src/registry/store.js';
import { JitRegistry } from '../src/registry/jit.js';
import { analyzePatterns } from '../src/compiler/analyze.js';
import { localIdentity, withIdentity } from '../src/security/identity.js';

const demo = process.argv.includes('--demo');
const store = new Store(demo ? ':memory:' : (process.env.FOUNDRY_DB ?? 'data/foundry.sqlite'));
try {
  withIdentity(
    { ...localIdentity, tenantId: process.env.FOUNDRY_TENANT_ID ?? 'local-demo' },
    () => {
      if (demo) new JitRegistry(store, () => {}).seed();
      console.log(
        JSON.stringify(
          {
            mode: 'offline',
            fixture: demo,
            patterns: analyzePatterns(store.all('toolTrace'), store.tenantId),
          },
          null,
          2,
        ),
      );
    },
  );
} finally {
  store.close();
}
