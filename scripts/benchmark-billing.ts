import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BillingWorkspace } from '../src/benchmarks/billing-workspace.js';
import { billingVariants, billingInstruction } from '../src/benchmarks/billing-fixtures.js';
import { diagnoseGemini } from '../src/agent/gemini-diagnostics.js';
import type { TaskClient } from '../src/integration/task-client.js';
import { z } from 'zod';

if (!process.argv.includes('--live'))
  throw new Error(
    'Use --live to authorize Gemini inference. Fixture validation is a separate automated test.',
  );
if (process.env.FOUNDRY_GEMINI_MODEL && process.env.FOUNDRY_GEMINI_MODEL !== 'gemini-3.8-flash')
  throw new Error('The required model is gemini-3.8-flash; refusing a configured substitute.');
const { TaskClient: PackagedTaskClient } = await import(
  pathToFileURL(resolve('dist-sdk/integration/index.js')).href
);
const totalTokenLimit = z.coerce
  .number()
  .int()
  .positive()
  .max(24000000)
  .parse(process.env.FOUNDRY_BILLING_TOKEN_LIMIT ?? 5000000);
const taskTokenLimit = z.coerce
  .number()
  .int()
  .positive()
  .max(500000)
  .parse(process.env.FOUNDRY_BILLING_TASK_TOKEN_LIMIT ?? 250000);
const workspace = new BillingWorkspace({
  Client: PackagedTaskClient as typeof TaskClient,
  limits: { totalTokens: totalTokenLimit, taskTokens: taskTokenLimit },
});
const sourceIndex = process.argv.indexOf('--source-evidence');
const resumeIndex = process.argv.indexOf('--resume-study');
if (sourceIndex >= 0 && resumeIndex >= 0)
  throw new Error('Choose --source-evidence or --resume-study, not both.');
const sourceEvidence =
  sourceIndex >= 0
    ? process.argv[sourceIndex + 1]
    : resumeIndex >= 0
      ? process.argv[resumeIndex + 1]
      : null;
if (sourceIndex >= 0 && !sourceEvidence)
  throw new Error('--source-evidence requires a retained report path.');
if (resumeIndex >= 0 && !sourceEvidence)
  throw new Error('--resume-study requires a retained report path.');
const restoredReport = sourceEvidence ? JSON.parse(readFileSync(sourceEvidence, 'utf8')) : null;
if (sourceEvidence) {
  const report = restoredReport;
  if (report.catalog?.instruction !== billingInstruction)
    throw new Error('Source evidence belongs to a different task.');
  workspace.restoreObservedTraining(report.setupRuns);
}
const path = `docs/experiments/billing-gemini-${Date.now()}.json`;
const began = performance.now();
const sourceHashes = Object.fromEntries(
  [
    'src/benchmarks/billing-fixtures.ts',
    'src/benchmarks/billing-workspace.ts',
    'src/agent/providers.ts',
    'scripts/benchmark-billing.ts',
    'dist-sdk/integration/task-client.js',
  ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
mkdirSync('docs/experiments', { recursive: true });
const priorAttempts = readdirSync('docs/experiments')
  .filter((name) => /^billing-gemini-\d+\.json$/.test(name))
  .map((name) => {
    const value = JSON.parse(readFileSync(`docs/experiments/${name}`, 'utf8'));
    const runs = [...(value.setupRuns ?? []), ...(value.runs ?? [])];
    const events = runs.flatMap((run) => run.events ?? []);
    return {
      file: name,
      status: value.status,
      trainingTasks: value.setupRuns?.length ?? 0,
      measuredTasks: value.runs?.length ?? 0,
      knownReportedTokens:
        events.reduce((sum: number, event: any) => sum + (event.usage?.totalTokens ?? 0), 0) +
        (value.preflight?.minimalInference?.usage?.totalTokens ?? 0),
      unknownUsageRequests: events.filter((event) => event.usage?.totalTokens == null).length,
    };
  });
let status = 'preflight';
let error: string | null = null;
let preflight: unknown = null;
let stopRequested = false;
const stop = () => {
  stopRequested = true;
  console.log('Stop requested: finishing and saving the current task before stopping.');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const checkStop = () => {
  if (stopRequested)
    throw new Error('Stopped after saving current task; no additional tasks started.');
};
const save = () =>
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...workspace.report(),
        status,
        error,
        preflight,
        sourceHashes,
        priorAttempts,
        sourceEvidence,
        resumedStudy: resumeIndex >= 0,
        reusedTrainingRunIds: sourceEvidence
          ? workspace.runs.filter((run) => run.phase === 'training').map((run) => run.id)
          : [],
        accountingNote:
          'Restored training retains original run IDs and incurred no new training inference. Deduplicate run IDs across retained reports when aggregating historical costs.',
        supplementalDiagnosticEvidence: [
          'billing-gemini-auth-preflight.json',
          'billing-tool-schema-preflight.json',
          'billing-tool-schema-json-preflight.json',
          'billing-training-budget-interruption.json',
        ],
        totalExperimentWallMs: performance.now() - began,
        planned: {
          measuredAgentTasks: 70,
          trainingAgentTasks: sourceEvidence ? 0 : 2,
          restoredTrainingTasks: sourceEvidence ? 2 : 0,
          minimalInferenceRequests: 1,
          pairedTrialsPerVariant: 5,
          modelCallsPerTaskLimit: 24,
          totalTokenLimit,
          taskTokenLimit,
          usageLimitCheckedAfterProviderResponse: true,
        },
      },
      null,
      2,
    ) + '\n',
  );
console.log(
  `Planned: 7 variants × 5 paired trials = 70 measured tasks; ${sourceEvidence ? '2 retained training tasks reused' : '2 baseline training tasks'}; 1 minimal inference. Required model: gemini-3.8-flash.`,
);
try {
  preflight = await diagnoseGemini({ key: process.env.GEMINI_API_KEY ?? '' });
  save();
  const discovery = (preflight as Awaited<ReturnType<typeof diagnoseGemini>>).discovery;
  if (discovery.httpStatus !== 200 || discovery.requiredModelListed !== true)
    throw new Error(
      `Model discovery failed (HTTP ${discovery.httpStatus ?? 'network error'}); required model availability is unconfirmed. No benchmark agent tasks executed.`,
    );
  // Minimal inference is performed only once discovery confirms the required model.
  const { ModelClient } = await import('../src/agent/providers.js');
  const probe = await new ModelClient({
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    temperature: 0,
    maxOutputTokens: 128,
  }).run({
    instructions: 'Return the requested short answer.',
    prompt: 'Reply with exactly OK.',
    tools: [],
    execute: async () => null,
    maxModelCalls: 1,
  });
  preflight = {
    ...(preflight as object),
    minimalInference: { usage: probe.usage, events: probe.events },
  };
  if (resumeIndex >= 0) {
    const inputLimit = discovery.modelInputTokenLimit;
    if (!Number.isSafeInteger(inputLimit) || inputLimit <= 0)
      throw new Error(
        'Cannot bound unknown request usage without the advertised model input limit.',
      );
    workspace.restoreMeasuredStudy(restoredReport.runs, inputLimit + 16384);
    console.log(
      `Restored ${restoredReport.runs.length} measured attempts, including failures; only unrun matched tasks will execute.`,
    );
  }
  save();
  status = 'training';
  for (const seed of sourceEvidence ? [] : [9001, 9002]) {
    checkStop();
    const run = await workspace.runArm('baseline', 'normal', seed, 'training');
    save();
    console.log(
      `Training ${seed}: ${run.passed ? 'PASS' : 'FAIL'}; tokens=${run.usage.totalTokens ?? 'unknown'}; failure=${run.failure ?? 'none'}`,
    );
    if (!run.passed)
      throw new Error(
        'Baseline validation gate failed; measured trials did not start. Inspect the retained training run.',
      );
  }
  checkStop();
  status = 'compilation';
  try {
    await workspace.compile();
    await workspace.deploy();
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'Compilation/deployment unavailable; optimized arm will retain original tools.';
  }
  save();
  status = 'measured';
  for (const [variantIndex, variant] of billingVariants.entries())
    for (let repeat = 0; repeat < 5; repeat++) {
      const order =
        (variantIndex + repeat) % 2 === 0
          ? (['baseline', 'optimized'] as const)
          : (['optimized', 'baseline'] as const);
      for (const arm of order) {
        checkStop();
        if (
          workspace.runs.some(
            (run) =>
              run.phase === 'measured' &&
              run.variant === variant &&
              run.seed === repeat &&
              run.arm === arm,
          )
        )
          continue;
        const run = await workspace.runArm(arm, variant, repeat);
        save();
        console.log(
          `${variant} pair ${repeat + 1} ${arm}: ${run.passed ? 'PASS' : 'FAIL'}; tokens=${run.usage.totalTokens ?? 'unknown'}; model calls=${run.events.length}`,
        );
      }
    }
  status = 'complete';
  save();
} catch (cause) {
  status = 'blocked_or_interrupted';
  error = cause instanceof Error ? cause.message : 'Experiment interrupted.';
  save();
  process.exitCode = 1;
} finally {
  await workspace.close();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  console.log(`Evidence retained: ${path}`);
}
