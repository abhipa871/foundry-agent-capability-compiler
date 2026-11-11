import express from 'express';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  BillingApiError,
  BillingEnvironment,
  type BillingCall,
  type BillingTool,
} from './billing-fixtures.js';
import { json, type Json } from '../compiler/contracts.js';

// Stateful synthetic services use actual loopback HTTP, never real enterprise credentials.
export async function startBillingApi(environment = new BillingEnvironment()) {
  const app = express();
  const token = randomUUID();
  let active = environment;
  app.use(express.json({ limit: '128kb' }));
  app.post('/tools/:name', async (req, res) => {
    if (req.headers['x-billing-session'] !== token) {
      res.status(403).json({ error: { code: 'SESSION_DENIED' } });
      return;
    }
    const origin =
      (['agent', 'compiled', 'validation'] as const).find(
        (origin) => origin === req.headers['x-billing-origin'],
      ) ?? 'agent';
    try {
      res.json(await active.call(req.params.name as BillingTool, req.body, undefined, origin));
    } catch (error) {
      const failure =
        error instanceof BillingApiError
          ? error
          : new BillingApiError(500, 'MOCK_API_FAILURE', 'Mock service failed.');
      res.status(failure.status).json({
        error: { code: failure.code, message: failure.message, retryable: failure.retryable },
      });
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    activate(environment: BillingEnvironment) {
      active = environment;
    },
    async request(
      name: BillingTool,
      args: Json,
      origin: BillingCall['origin'] = 'agent',
    ): Promise<Json> {
      const response = await fetch(`${endpoint}/tools/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-billing-session': token,
          'x-billing-origin': origin,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      const value = await response.json();
      if (!response.ok)
        throw new BillingApiError(
          response.status,
          value.error?.code ?? 'HTTP_ERROR',
          value.error?.message ?? 'API request failed.',
          value.error?.retryable === true,
        );
      return json(value);
    },
    close: () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  };
}
