import { createHash, generateKeyPairSync } from 'node:crypto';
import { format, resolveConfig } from 'prettier';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { FoundryClient, type CustomerAgent } from '../src/integration/client.js';
import { TrajectoryObserver } from '../src/exploration/observe.js';
import { mockAdapters, localContext } from '../src/runtime/adapters/registry.js';
import { sameContext } from '../src/runtime/observable.js';
import { ArtifactSigner } from '../src/security/signing.js';
import { ApiKeyAuthenticator, localIdentity } from '../src/security/identity.js';
import { Store } from '../src/registry/store.js';
import { emptyMeasurement, savings, type Measurement } from '../src/telemetry/measurement.js';

const delayMs = 8;
const adapters = mockAdapters({ delayMs });
const native: CustomerAgent = async (task, _checkpoint, observer) => {
  const began = performance.now();
  const { customerId } = task.input as { customerId: string };
  const capture =
    observer ??
    new TrajectoryObserver({
      input: { customerId },
      context: localContext(),
      adapters,
      agentId: localIdentity.agentId,
      origin: 'fixture',
    });
  const crm = await capture.read('crm.getCustomer', { source: 'task_input', key: 'customerId' });
  const binding = {
    source: 'event_output' as const,
    ref: { producerEventId: crm.eventId, outputPath: 'customerId' as const },
  };
  const orders = await capture.read('orders.list', binding);
  await capture.read('crm.getCustomer', { source: 'task_input', key: 'customerId' });
  const refunds = await capture.read('payments.refundHistory', binding);
  const measurement: Measurement = {
    ...emptyMeasurement('fixture'),
    outcome: 'success',
    durationMs: performance.now() - began,
    toolCalls: 4,
    modelCalls: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
  };
  return {
    resolved: true,
    summary: 'Controlled fixture workflow replay; no live model benchmark.',
    llmInvocations: 0,
    tokens: 0,
    measurement,
    result: {
      customer_id: customerId,
      crm_get_customer: crm.value,
      orders_list: orders.value,
      payments_refund_history: refunds.value,
    },
  };
};
const pair = generateKeyPairSync('ed25519');
const signer = new ArtifactSigner(
  pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const apiKey = 'fixture_only_benchmark_credential_0000000';
const auth = new ApiKeyAuthenticator([
  { sha256: createHash('sha256').update(apiKey).digest('hex'), identity: localIdentity },
]);
const store = new Store(':memory:');
const { app, service } = createApp(store, false, {
  auth,
  signer,
  runtime: {
    adapters: () => adapters,
    agent: (task, checkpoint) => native(task, checkpoint, undefined),
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const client = new FoundryClient({
  ...localIdentity,
  context: localContext,
  adapters,
  native,
  endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  apiKey,
  trustedPublicKey: publicKey,
  shareReplayEvidence: true,
});
try {
  for (const customerId of ['C-101', 'C-202'])
    await client.execute({ kind: 'customer_context', input: { customerId } });
  const compileStart = performance.now();
  const [pattern] = service.jit.analyze();
  const candidate = service.jit.compilePattern(pattern.id);
  const compileDurationMs = performance.now() - compileStart;
  const verifyStart = performance.now();
  const verified = await service.jit.verify(candidate.id);
  const verificationDurationMs = performance.now() - verifyStart;
  if (verified.checks.some((check) => !check.passed)) throw new Error('Validation gate failed.');
  for (const customerId of ['C-101', 'C-202', 'C-303'])
    await service.jit.shadow(candidate.id, { customerId });
  service.jit.approve(
    candidate.id,
    'Benchmark sandbox approval with passing validation and shadow coverage.',
  );
  service.jit.deploy(candidate.id);
  // Measured pairs stop shipping replay evidence. Customer values stay local during normal runs.
  const measured = new FoundryClient({
    ...localIdentity,
    context: localContext,
    adapters,
    native,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey,
    trustedPublicKey: publicKey,
  });
  const baseline: Measurement[] = [];
  const optimized: Measurement[] = [];
  let comparisons = 0;
  for (let index = -3; index < 30; index++) {
    const customerId = ['C-101', 'C-202', 'C-303'][(index + 3) % 3];
    const results = new Map<string, Awaited<ReturnType<FoundryClient['execute']>>>();
    for (const mode of index % 2 === 0
      ? (['observe', 'live'] as const)
      : (['live', 'observe'] as const)) {
      service.jit.configureRouting({ mode, rolloutPercent: mode === 'live' ? 100 : 0 });
      const began = performance.now();
      const result = await measured.execute({ kind: 'customer_context', input: { customerId } });
      if (result.outcome !== 'success' || result.mode !== (mode === 'live' ? 'compiled' : 'agent'))
        throw new Error('Routing/outcome gate failed.');
      result.measurement.durationMs = performance.now() - began; // complete SDK wall time, including telemetry
      result.measurement.origin = 'fixture';
      results.set(mode, result);
    }
    if (!sameContext(results.get('observe')!.result, results.get('live')!.result))
      throw new Error('Full context equivalence failed.');
    if (index >= 0) {
      comparisons++;
      baseline.push(results.get('observe')!.measurement);
      optimized.push(results.get('live')!.measurement);
    }
  }
  const mean = (runs: Measurement[]): Measurement => {
    const result = { ...runs[0] };
    for (const key of [
      'durationMs',
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'totalTokens',
      'modelCalls',
      'toolCalls',
      'apiCalls',
      'costUsd',
    ] as const) {
      const values = runs.map((run) => run[key]);
      (result as unknown as Record<string, unknown>)[key] = values.some((value) => value === null)
        ? null
        : values.reduce<number>((sum, value) => sum + value!, 0) / runs.length;
    }
    return result;
  };
  const percentile = (runs: Measurement[], fraction: number) =>
    [...runs].sort((a, b) => a.durationMs - b.durationMs)[Math.ceil(runs.length * fraction) - 1]
      .durationMs;
  const before = mean(baseline);
  const after = mean(optimized);
  service.jit.quarantine(candidate.id);
  const fallback = await measured.execute({
    kind: 'customer_context',
    input: { customerId: 'C-101' },
  });
  const report = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    scope:
      'Controlled local read-only fixture workflow replay through the real SDK, authenticated loopback API, signer and interpreter. No live model inference or external SaaS calls.',
    methodology: {
      pairs: 30,
      warmupPairs: 3,
      inputIds: ['C-101', 'C-202', 'C-303'],
      alternatingOrder: true,
      adapterDelayMs: delayMs,
      telemetryIncludedInWallTime: true,
    },
    baseline: {
      ...before,
      p50DurationMs: percentile(baseline, 0.5),
      p95DurationMs: percentile(baseline, 0.95),
    },
    optimized: {
      ...after,
      p50DurationMs: percentile(optimized, 0.5),
      p95DurationMs: percentile(optimized, 0.95),
    },
    savings: {
      ...savings(before, after),
      toolCallsSavedPerRun: before.toolCalls! - after.toolCalls!,
      latencySavedMsPerRun: before.durationMs - after.durationMs,
      tokensSaved: null,
      modelCallsSaved: null,
      costSavedUsd: null,
    },
    correctness: {
      comparisons,
      matches: comparisons,
      comparison:
        'Full identities, eligibility, order IDs/lateness and refund IDs/amounts; list order normalized.',
    },
    lifecycle: {
      patternObserved: true,
      compileDurationMs,
      verificationDurationMs,
      passingChecks: verified.checks.length,
      shadowCoverage: service.jit.shadowStatus(candidate.id),
      postQuarantineFallback: { mode: fallback.mode, outcome: fallback.outcome },
    },
    rawPairs: baseline.map((run, index) => ({
      baselineMs: run.durationMs,
      optimizedMs: optimized[index].durationMs,
    })),
    limitations: [
      'Fixture delays are controlled, not SaaS performance.',
      'No live agent/model baseline was run: model-call/token/cost savings are unknown.',
      'Compile/verification/shadow setup is excluded from steady-state pairs.',
      'Single-process loopback benchmark does not establish production economics.',
    ],
  };
  const output = process.argv[2] ?? 'docs/optimization-benchmark.json';
  writeFileSync(
    output,
    await format(JSON.stringify(report), { ...(await resolveConfig(output)), parser: 'json' }),
  );
  console.log(
    JSON.stringify(
      {
        output,
        baselineMs: before.durationMs,
        optimizedMs: after.durationMs,
        savings: report.savings,
        correctness: report.correctness,
        fallback: report.lifecycle.postQuarantineFallback,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  store.close();
}
