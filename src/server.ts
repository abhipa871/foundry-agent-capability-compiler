import { createApp } from './app.js';
import { Store } from './registry/store.js';

const store = new Store(process.env.FOUNDRY_DB ?? 'data/foundry.sqlite');
const { app } = createApp(store);
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
