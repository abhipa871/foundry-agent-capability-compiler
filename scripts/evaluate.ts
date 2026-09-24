import { Store } from '../src/registry/store.js';
import { Foundry } from '../src/service.js';
import { defaultPolicy } from '../src/domain.js';
import { sampleRawAgentTrajectory } from '../src/exploration/capture.js';
import { sampleToolTraces } from '../src/exploration/sample-traces.js';

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
} finally {
  store.close();
}
