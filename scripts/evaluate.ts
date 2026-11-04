import { Store } from '../src/registry/store.js';
import { Foundry } from '../src/service.js';
import { defaultPolicy } from '../src/domain.js';
import { sampleRawAgentTrajectory } from '../src/exploration/capture.js';
import { sampleToolTraces } from '../src/exploration/sample-traces.js';
import { TaskRegistry } from '../src/registry/tasks.js';
import { localIdentity, withIdentity } from '../src/security/identity.js';
import { stable } from '../src/compiler/contracts.js';
import {
  captureDeparture,
  departureAccess,
  departureInput,
  departureInputs,
  departureKind,
  departureName,
  departureRegistry,
  expectedDeparture,
} from '../src/examples/departure.js';

const store = new Store(':memory:');
try {
  const service = new Foundry(store);
  const trace = service.captureRaw(sampleRawAgentTrajectory, 'demo');
  const cap = service.verify(service.compile(trace.id, defaultPolicy).id);
  for (const check of cap.checks)
    console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.category}: ${check.name}`);
  if (!cap.checks.length || cap.checks.some((check) => !check.passed)) process.exitCode = 1;

  console.log('\nCompiled read capability (IR):');
  for (const sample of sampleToolTraces) service.jit.ingest(sample, 'demo');
  const artifact = await service.jit.verify(service.jit.compile().id);
  for (const check of artifact.checks)
    console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.category}: ${check.name}`);
  if (!artifact.checks.length || artifact.checks.some((check) => !check.passed))
    process.exitCode = 1;

  service.jit.approve(artifact.id, 'Evaluation run: read-only capability with passing checks.');
  for (const customerId of ['C-101', 'C-202', 'C-404']) {
    const run = await service.jit.dispatch({ kind: 'customer_context', input: { customerId } });
    console.log(
      `${customerId}: mode=${run.mode} llm=${run.llmInvocations} adapterCalls=${run.adapterCalls} ` +
        `${run.mode === 'compiled' ? `${Math.round(run.durationMs)}ms` : `fallback=${run.fallbackReason}`}`,
    );
  }
  const profile = service.jit.profile('load_customer_context');
  console.log(
    `profile: ${profile.compiled} compiled / ${profile.agent} agent, ` +
      `LLM calls inside compiled portion: ${profile.compiledLlmInvocations}, p50 ${profile.p50DurationMs}ms`,
  );
  console.log(
    `recorded trace baseline (fixtures, not a controlled benchmark): ` +
      `${profile.recordedTraceBaseline.avgLlmInvocations} LLM calls and ` +
      `${profile.recordedTraceBaseline.avgTokens} tokens per captured trajectory`,
  );
  console.log('\nGeneral task capability (synthetic personal fixtures; zero model inference):');
  await withIdentity({ ...localIdentity, toolScopes: [...departureAccess().scopes] }, async () => {
    const registry = departureRegistry();
    const lifecycle = new TaskRegistry(store, {
      registry,
      context: departureAccess,
      verificationCases: () =>
        departureInputs.map((input) => ({ input, expected: expectedDeparture(input) })),
      native: async (_kind, input, context) =>
        (await captureDeparture(registry, departureInput.parse(input), context)).result,
    });
    const traces = await Promise.all(
      departureInputs.slice(0, 2).map((input) => captureDeparture(registry, input)),
    );
    traces.forEach((trace) => lifecycle.ingest(trace));
    const candidate = lifecycle.compile(
      departureName,
      traces.map((trace) => trace.id),
    );
    const verified = await lifecycle.verify(candidate.id);
    for (const check of verified.checks)
      console.log(`${check.passed ? 'PASS' : 'FAIL'} general: ${check.name}`);
    if (verified.checks.some((check) => !check.passed))
      throw new Error('General capability verification failed.');
    lifecycle.approve(candidate.id);
    for (const input of departureInputs) {
      if ((await lifecycle.shadow(candidate.id, input)).status !== 'match')
        throw new Error('General shadow mismatch.');
    }
    lifecycle.deploy(candidate.id);
    for (const input of departureInputs) {
      const run = await lifecycle.execute(departureName, departureKind, input);
      const passed =
        run.mode === 'compiled' &&
        run.llmInvocations === 0 &&
        stable(run.result) === stable(expectedDeparture(input));
      console.log(`${passed ? 'PASS' : 'FAIL'} general held-out execution: ${input.userId}`);
      if (!passed) process.exitCode = 1;
    }
  });
} finally {
  store.close();
}
