import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ArtifactSigner } from './security/signing.js';
import { customerInput } from './compiler/ir.js';
import { DomainError, defaultPolicy } from './domain.js';
import { sampleRawAgentTrajectory, sampleTrajectory } from './exploration/capture.js';
import { sampleToolTraces } from './exploration/sample-traces.js';
import { Foundry } from './service.js';
import { Store } from './registry/store.js';
import { ApiKeyAuthenticator, withIdentity, requirePermission } from './security/identity.js';
export type AppOptions = {
  auth?: ApiKeyAuthenticator;
  signer?: ArtifactSigner;
  runtime?: ConstructorParameters<typeof Foundry>[1];
};

const id = z.string().uuid();
const note = z.object({ note: z.string().trim().min(5).max(500) }).strict();
const emptyRequest = z.object({}).strict();
const agentTask = z
  .object({
    task: z.string().trim().min(10).max(4000),
    providerId: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export function createApp(store: Store, seed = true, options: AppOptions = {}) {
  const app = express();
  const service = new Foundry(store, options.runtime);
  if (seed && !options.auth) service.seed();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (options.auth) {
      if (req.path === '/health') return next();
      if (!req.path.startsWith('/v2/'))
        return res.status(404).json({ error: 'Hosted mode exposes the read-only v2 API.' });
      try {
        const identity = options.auth.authenticate(req.get('authorization'));
        return withIdentity(identity, () => {
          const action = req.path.split('/').at(-1);
          const permission =
            req.method === 'GET'
              ? 'read'
              : action === 'compile' || action === 'analyze'
                ? 'compile'
                : action === 'verify' || action === 'revalidate'
                  ? 'verify'
                  : action === 'approve'
                    ? 'approve'
                    : ['deploy', 'revoke', 'routing', 'quarantine', 'rollback'].includes(
                          action ?? '',
                        )
                      ? 'deploy'
                      : action === 'dispatch' || action === 'shadow'
                        ? 'invoke'
                        : ['/v2/traces', '/v2/telemetry'].includes(req.path)
                          ? 'observe'
                          : 'admin';
          try {
            requirePermission(permission);
            store.consumeQuota(permission, permission === 'compile' ? 10 : 120);
            next();
          } catch (error) {
            service.audit('authorization.denied', 'api', 'Request permission or quota denied.');
            next(error);
          }
        });
      } catch (error) {
        return next(error);
      }
    }
    const host = req.hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
      return res.status(403).json({ error: 'Local demo accepts loopback hosts only.' });
    const origin = req.get('origin');
    if (origin) {
      try {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
          throw new Error();
      } catch {
        return res.status(403).json({ error: 'Origin is not allowed.' });
      }
    }
    if (req.method !== 'GET' && req.get('X-Foundry-Client') !== 'local-ui')
      return res
        .status(403)
        .json({ error: 'X-Foundry-Client: local-ui is required for local mutations.' });
    next();
  });
  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', mode: options.auth ? 'authenticated-read-api' : 'local-demo' }),
  );
  app.get('/api/state', (_req, res) => res.json(service.state()));
  app.get('/api/agent/options', (_req, res) =>
    res.json({ providers: service.state().agentProviders }),
  );
  app.post('/api/agent/sessions', async (req, res) => {
    const body = agentTask.parse(req.body);
    res.status(201).json(await service.runCodingAgent(body.task, body.providerId));
  });
  app.post('/api/agent/sessions/:id/deploy', async (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.status(201).json(await service.deployCodingAgentSession(id.parse(req.params.id)));
  });
  app.post('/api/agent/sessions/:id/register', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.status(201).json(service.prepareCodingSession(id.parse(req.params.id)));
  });
  app.post('/api/coding-capabilities/:id/policy', (req, res) =>
    res.status(201).json(service.coding.configure(id.parse(req.params.id), req.body)),
  );
  app.post('/api/coding-capabilities/:id/verify', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.coding.verify(id.parse(req.params.id)));
  });
  app.post('/api/coding-capabilities/:id/approve', (req, res) =>
    res.json(service.coding.approve(id.parse(req.params.id), note.parse(req.body).note)),
  );
  app.post('/api/coding-capabilities/:id/revoke', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.coding.revoke(id.parse(req.params.id)));
  });
  app.post('/api/coding-capabilities/:id/deploy', async (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.status(201).json(await service.coding.deploy(id.parse(req.params.id)));
  });
  app.get('/api/coding-capabilities/:id/artifact', (req, res) => {
    const cap = service.coding.get(id.parse(req.params.id));
    res.attachment(`${cap.name}-v${cap.version}.json`).json({
      format: 'foundry-coding-replay-v1',
      capability: cap,
      runtime: 'Codex CLI replay; model-driven, not deterministic',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', required: ['status', 'output', 'usage'] },
    });
  });
  app.post('/api/agent/sessions/reset', (_req, res) => res.json(service.clearCodingAgentHistory()));
  app.get('/api/trajectory-template', (_req, res) => res.json(sampleTrajectory));
  app.get('/api/raw-trajectory-template', (_req, res) => res.json(sampleRawAgentTrajectory));
  app.post('/api/trajectories/demo', (_req, res) =>
    res.status(201).json(service.capture(sampleTrajectory, 'demo')),
  );
  app.post('/api/trajectories/raw', (req, res) =>
    res.status(201).json(service.captureRaw(req.body, 'import')),
  );
  app.post('/api/trajectories', (req, res) =>
    res.status(201).json(service.captureAny(req.body, 'import')),
  );
  app.post('/api/capabilities', (req, res) => {
    const body = z
      .object({ trajectoryId: id, policy: z.unknown().optional() })
      .strict()
      .parse(req.body);
    res.status(201).json(service.compile(body.trajectoryId, body.policy ?? defaultPolicy));
  });
  app.post('/api/capabilities/:id/verify', (req, res) =>
    res.json(service.verify(id.parse(req.params.id))),
  );
  app.post('/api/capabilities/:id/approve', (req, res) =>
    res.json(service.approve(id.parse(req.params.id), note.parse(req.body).note)),
  );
  app.post('/api/capabilities/:id/reject', (req, res) =>
    res.json(service.reject(id.parse(req.params.id), note.parse(req.body).note)),
  );
  app.post('/api/capabilities/:id/deploy', (req, res) =>
    res.json(service.rollback(id.parse(req.params.id))),
  );
  const runBody = z
    .object({
      input: z.unknown(),
      idempotencyKey: z.string().min(8).max(100),
      fault: z.enum(['none', 'timeout', 'transient', 'partial', 'stale']).default('none'),
    })
    .strict();
  app.post('/api/capabilities/:id/run', (req, res) => {
    const body = runBody.parse(req.body);
    res.json(service.run(id.parse(req.params.id), body.input, body.idempotencyKey, body.fault));
  });
  app.get('/api/tools', (_req, res) => {
    const state = service.state();
    res.json(
      state.capabilities
        .filter(
          (c) =>
            state.deployments[c.name] === c.id &&
            c.contractVersion === state.contractVersion &&
            c.checks.every((check) => check.passed),
        )
        .map((c) => ({
          name: c.name,
          description: c.description,
          inputSchema: c.inputSchema,
          outputSchema: c.outputSchema,
          version: c.version,
          endpoint: `/api/tools/${c.name}/invoke`,
        })),
    );
  });
  app.post('/api/tools/:name/invoke', (req, res) => {
    const body = runBody.parse(req.body);
    const capabilityId = store.deployments()[req.params.name];
    if (!capabilityId) throw new DomainError('Approved tool not found.', 404);
    res.json(service.run(capabilityId, body.input, body.idempotencyKey, body.fault));
  });
  app.post('/api/runs/:id/compensate', (req, res) =>
    res.json(service.compensate(id.parse(req.params.id))),
  );
  app.post('/api/demo/drift', (_req, res) => res.json({ contractVersion: service.drift() }));
  app.get('/api/capabilities/:id/artifact', (req, res) => {
    const cap = service.capability(id.parse(req.params.id));
    res.attachment(`${cap.name}-v${cap.version}.json`).json({
      format: 'foundry-capability-v1',
      capability: cap,
      trajectory: store.get('trajectory', cap.trajectoryId),
      branchPruning: {
        sourceEventIds: cap.sourceEventIds ?? [],
        discardedBranches: cap.discardedBranches ?? [],
      },
      runtime: 'Foundry constrained local interpreter',
      auth: {
        mode: 'loopback-demo',
        header: 'X-Foundry-Client: local-ui',
        requiredScopes: cap.requiredScopes,
      },
      retry: { maxAttempts: 3, strategy: 'demo transient retry; no network' },
      rollback: 'Redeploy an approved compatible version; compensate local demo runs separately.',
    });
  });
  // v2: structured traces -> compiled IR -> verified artifact -> guarded dispatch.
  app.get('/api/v2/state', (_req, res) => res.json(service.jitState()));
  app.get('/api/v2/trace-templates', (_req, res) => res.json(sampleToolTraces));
  app.post('/api/v2/traces', (req, res) =>
    res.status(201).json(service.jit.ingest(req.body, 'import')),
  );
  app.post('/api/v2/traces/samples', (_req, res) => {
    const existing = new Set(service.jit.traces().map((trace) => trace.id));
    res
      .status(201)
      .json(
        sampleToolTraces
          .filter((trace) => !existing.has(trace.traceId))
          .map((trace) => service.jit.ingest(trace, 'demo')),
      );
  });
  app.get('/api/v2/runtime/capability', (_req, res) => {
    requirePermission('invoke');
    if (!options.signer) throw new DomainError('Capability signing is not configured.', 503);
    res.json(options.signer.sign(service.jit.runtimeTicket()));
  });
  app.get('/api/v2/runtime/routing', (_req, res) => res.json(service.jit.routing()));
  app.post('/api/v2/runtime/routing', (req, res) =>
    res.json(service.jit.configureRouting(req.body)),
  );
  app.post('/api/v2/telemetry', (req, res) =>
    res.status(201).json(service.jit.ingestTelemetry(req.body)),
  );
  app.get('/api/v2/patterns', (_req, res) => res.json(service.jit.patterns()));
  app.post('/api/v2/patterns/analyze', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.jit.analyze());
  });
  app.post('/api/v2/patterns/:patternId/compile', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.status(201).json(
      service.jit.compilePattern(
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(req.params.patternId),
      ),
    );
  });
  app.post('/api/v2/compile', (req, res) => {
    const body = z
      .object({
        traceIds: z.array(id).max(20).optional(),
        freshnessMs: z.number().int().min(1).max(60000).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    res.status(201).json(service.jit.compile(body.traceIds, { freshnessMs: body.freshnessMs }));
  });
  app.get('/api/v2/capabilities', (_req, res) => res.json(service.jit.artifacts()));
  app.get('/api/v2/capabilities/:id/ir', (req, res) => {
    const artifact = service.jit.get(id.parse(req.params.id));
    res.json({ ir: artifact.ir, digest: artifact.digest, report: artifact.report });
  });
  app.get('/api/v2/capabilities/:id/artifact', (req, res) => {
    const artifact = service.jit.get(id.parse(req.params.id));
    res.attachment(`${artifact.name}-v${artifact.version}.json`).json({
      format: 'agent-jit-ir-v1',
      artifact,
      runtime:
        'Constrained IR interpreter over typed mock adapters; no generated code is executed.',
      rollback: 'Deploy a previously approved artifact id; artifacts are immutable.',
    });
  });
  app.post('/api/v2/capabilities/:id/verify', async (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(await service.jit.verify(id.parse(req.params.id)));
  });
  app.post('/api/v2/capabilities/:id/approve', (req, res) =>
    res.json(service.jit.approve(id.parse(req.params.id), note.parse(req.body).note)),
  );
  app.post('/api/v2/capabilities/:id/deploy', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.jit.deploy(id.parse(req.params.id)));
  });
  app.post('/api/v2/capabilities/:id/revoke', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.jit.revoke(id.parse(req.params.id)));
  });
  app.post('/api/v2/tasks/dispatch', async (req, res) => {
    const body = z
      .object({ kind: z.string().trim().min(1).max(64), input: z.unknown() })
      .strict()
      .parse(req.body);
    res.json(await service.jit.dispatch({ kind: body.kind, input: body.input }));
  });
  app.get('/api/v2/runs/:id', (req, res) => {
    const run = store.get('dispatchRun', id.parse(req.params.id));
    if (!run) throw new DomainError('Dispatch run not found.', 404);
    res.json(run);
  });
  app.post('/api/v2/runs/:id/recover', (req, res) => {
    const body = z
      .object({
        by: z.enum(['agent', 'operator']),
        note: z.string().trim().min(5).max(500),
        traceId: id.optional(),
      })
      .strict()
      .parse(req.body);
    res.json(service.jit.recover(id.parse(req.params.id), body));
  });
  app.get('/api/v2/capabilities/:id/health', (req, res) =>
    res.json(service.jit.health(id.parse(req.params.id))),
  );
  app.post('/api/v2/capabilities/:id/quarantine', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.jit.quarantine(id.parse(req.params.id)));
  });
  app.post('/api/v2/capabilities/:id/rollback', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.jit.rollback(id.parse(req.params.id)));
  });
  app.post('/api/v2/capabilities/:id/revalidate', async (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(await service.jit.verify(id.parse(req.params.id)));
  });
  app.post('/api/v2/maintenance', (req, res) => {
    emptyRequest.parse(req.body ?? {});
    res.json(service.jit.maintenance());
  });
  app.get('/api/v2/artifacts/:id/shadow', (req, res) =>
    res.json(service.jit.shadowStatus(id.parse(req.params.id))),
  );
  app.post('/api/v2/artifacts/:id/shadow', async (req, res) => {
    const body = z.object({ input: customerInput }).strict().parse(req.body);
    res.json(await service.jit.shadow(id.parse(req.params.id), body.input));
  });
  app.get('/api/v2/profiles/:name', (req, res) =>
    res.json(service.jit.profile(z.string().min(1).max(64).parse(req.params.name))),
  );
  app.get('/api/v2/export', (_req, res) => {
    requirePermission('admin');
    res.json(store.exportData());
  });
  app.delete('/api/v2/data', (_req, res) => {
    requirePermission('admin');
    store.deleteData();
    service.audit('tenant.deleted', store.tenantId, 'Tenant data deleted.');
    res.json({ deleted: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '),
      });
      return;
    }
    if (error instanceof DomainError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON request.' });
      return;
    }
    if (options.auth) console.error('Foundry API error: unexpected server failure.');
    else console.error(error);
    if (req.path.startsWith('/api/agent')) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Coding-agent server error.',
      });
      return;
    }
    res.status(500).json({ error: 'Unexpected server error.' });
  };
  app.use(errors);
  return { app, service };
}
