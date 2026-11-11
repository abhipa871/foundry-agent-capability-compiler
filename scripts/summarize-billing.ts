import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { BillingWorkspace, BillingRun } from '../src/benchmarks/billing-workspace.js';
import type { ModelEvent } from '../src/agent/providers.js';
import {
  billingReads,
  billingInstruction,
  billingVariants,
} from '../src/benchmarks/billing-fixtures.js';
import {
  billingPricingSchema,
  billingStatistics,
  estimateBillingCost,
} from '../src/benchmarks/billing-statistics.js';

// Offline analysis only: never imports credentials, invokes a provider or modifies raw evidence.
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: summarize-billing.ts REPORT.json OUTPUT.json');
type Report = ReturnType<BillingWorkspace['report']> & {
  sourceEvidence?: string | null;
  preflight?: { minimalInference?: { events?: ModelEvent[] } };
};
const evidenceBytes = (path: string) => {
  const actual = existsSync(path) ? path : `${path}.gz`;
  const bytes = readFileSync(actual);
  return actual.endsWith('.gz') ? gunzipSync(bytes) : bytes;
};
const read = (path: string): Report => JSON.parse(evidenceBytes(path).toString('utf8'));
const report = read(source);
if (report.format !== 'foundry-enterprise-billing-v1' || report.evaluationMode !== 'live_gemini')
  throw new Error('Expected retained live billing evidence.');
if (report.catalog.instruction !== billingInstruction) throw new Error('Unexpected task contract.');
const pricing = billingPricingSchema.parse(
  JSON.parse(readFileSync('docs/experiments/billing-gemini-pricing-2026-11-07.json', 'utf8')),
);
const runs = report.runs.map((run) => ({
  ...run,
  estimatedCostUsd: estimateBillingCost(run.events, pricing),
}));
const keys = runs.map((run) => `${run.variant}:${run.seed}:${run.arm}`);
if (new Set(keys).size !== keys.length) throw new Error('Duplicate measured attempts.');
const excludedPairs: { variant: string; seed: number; reason: string }[] = [];
const meteredPairs = runs.filter((run) => {
  const partner = runs.find(
    (other) => other.variant === run.variant && other.seed === run.seed && other.arm !== run.arm,
  );
  const known =
    partner &&
    [run, partner].every(
      (item) =>
        item.usage.totalTokens !== null && item.estimatedCostUsd !== null && item.events.length > 0,
    );
  if (!known && !excludedPairs.some((p) => p.variant === run.variant && p.seed === run.seed))
    excludedPairs.push({
      variant: run.variant,
      seed: run.seed,
      reason: partner ? 'At least one arm has unknown usage/cost.' : 'Unattempted paired arm.',
    });
  return known;
});
const quantiles = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    median: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
    p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
  };
};
const diagnostics = (arm: 'baseline' | 'optimized') => {
  const selected = runs.filter((run) => run.arm === arm);
  const calls = selected.flatMap((run) => run.calls);
  const compiled = selected.flatMap((run) =>
    run.transcript.filter((item) => item.name === 'billing_observed_reads'),
  );
  return {
    tasks: selected.length,
    successes: selected.filter((run) => run.passed).length,
    policyPreserved: selected.every((run) => run.checks.policyPreserved),
    noDuplicateRefund: selected.every((run) => run.checks.noDuplicateRefund),
    legitimateChargeUntouched: selected.every((run) => run.checks.legitimate200Untouched),
    modelCalls: selected.reduce((sum, run) => sum + run.events.length, 0),
    knownReportedTokensLowerBound: selected.reduce(
      (sum, run) =>
        sum + run.events.reduce((subtotal, event) => subtotal + (event.usage.totalTokens ?? 0), 0),
      0,
    ),
    unknownUsageRequests: selected
      .flatMap((run) => run.events)
      .filter((event) => event.usage.totalTokens === null).length,
    modelToolCalls: selected.reduce((sum, run) => sum + run.modelToolCalls, 0),
    businessServiceAttempts: calls.length,
    loopbackHttpAttempts: calls.filter(
      (call) => call.origin !== 'transport_duplicate' && call.origin !== 'security_probe',
    ).length,
    readAttempts: calls.filter((call) => billingReads.includes(call.tool)).length,
    repeatedSuccessfulReadArguments: selected.reduce((sum, run) => {
      const signatures = run.calls
        .filter((call) => billingReads.includes(call.tool) && call.httpStatus === 200)
        .map((call) => JSON.stringify([call.tool, call.args]));
      return sum + signatures.length - new Set(signatures).size;
    }, 0),
    repeatedReadNote:
      'Diagnostic only: a repeated read can be a valid refresh, not necessarily waste.',
    compiledToolInvocations: compiled.length,
    compiledToolInvocationDurationMs: quantiles(compiled.map((item) => item.durationMs)),
    tasksWithFallback: selected.filter((run) => run.fallbacks > 0).length,
    fallbackEvents: selected.reduce((sum, run) => sum + run.fallbacks, 0),
    fallbackTasks: selected
      .filter((run) => run.fallbacks > 0)
      .map((run) => ({
        id: run.id,
        variant: run.variant,
        seed: run.seed,
        passed: run.passed,
        tokens: run.usage.totalTokens,
        modelCalls: run.events.length,
        durationMs: run.durationMs,
        estimatedCostUsd: run.estimatedCostUsd,
      })),
  };
};
const chain: object[] = [];
const visited = new Set<string>();
let path: string | null = source;
while (path) {
  if (visited.has(resolve(path))) throw new Error('Cyclic evidence chain.');
  visited.add(resolve(path));
  const item = read(path);
  chain.push({
    file: path,
    initializationMs: item.initializationMs,
    compilationVerificationShadowDeploymentMs: item.compilation.durationMs,
  });
  path = item.sourceEvidence ?? null;
}
const setup = report.setupRuns.map((run) => ({
  id: run.id,
  tokens: run.usage.totalTokens,
  durationMs: run.durationMs,
  estimatedCostUsd: estimateBillingCost(run.events, pricing),
}));
const uniqueHistoricalRuns = new Map<string, BillingRun>();
const probes: { file: string; events: ModelEvent[] }[] = [];
const evidenceFiles = [
  ...new Set(
    readdirSync('docs/experiments')
      .filter((name) => /^billing-gemini-\d+\.json(?:\.gz)?$/.test(name))
      .map((name) => name.replace(/\.gz$/, '')),
  ),
];
for (const file of evidenceFiles) {
  const item = read(`docs/experiments/${file}`);
  for (const run of [...item.setupRuns, ...item.runs]) {
    const previous = uniqueHistoricalRuns.get(run.id);
    if (previous && JSON.stringify(previous.usage) !== JSON.stringify(run.usage))
      throw new Error('A historical run changed usage across reports.');
    uniqueHistoricalRuns.set(run.id, run);
  }
  if (item.preflight?.minimalInference?.events)
    probes.push({ file, events: item.preflight.minimalInference.events });
}
const primaryIds = new Set([...report.setupRuns, ...report.runs].map((run) => run.id));
const outsideCohort = [...uniqueHistoricalRuns.values()].filter((run) => !primaryIds.has(run.id));
const historicalSummary = (items: BillingRun[]) => ({
  tasks: items.length,
  knownReportedTokensLowerBound: items.reduce(
    (sum, run) =>
      sum + run.events.reduce((subtotal, event) => subtotal + (event.usage.totalTokens ?? 0), 0),
    0,
  ),
  unknownUsageRequests: items
    .flatMap((run) => run.events)
    .filter((event) => event.usage.totalTokens === null).length,
  fullyPricedTaskCostsUsd: items.map((run) => ({
    id: run.id,
    phase: run.phase,
    passed: run.passed,
    tokens: run.usage.totalTokens,
    estimatedCostUsd: estimateBillingCost(run.events, pricing),
  })),
});
const result = {
  source,
  sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
  sourceUncompressedSha256: createHash('sha256').update(evidenceBytes(source)).digest('hex'),
  createdAt: new Date().toISOString(),
  pricing,
  complete: report.complete,
  budgetAccounting: report.budgetAccounting,
  fullCohort: billingStatistics(runs),
  fullyMeteredPairs: {
    note: 'Secondary, incomplete-case estimate; includes known-usage failures. Unknown pairs excluded only here, never from full-cohort success/security results. Missingness may bias savings.',
    excludedPairs,
    statistics: billingStatistics(meteredPairs),
  },
  byCondition: billingVariants.map((variant) => ({
    variant,
    allAttempts: billingStatistics(runs.filter((run) => run.variant === variant)),
    fullyMeteredPairs: billingStatistics(meteredPairs.filter((run) => run.variant === variant)),
  })),
  diagnostics: { baseline: diagnostics('baseline'), optimized: diagnostics('optimized') },
  failures: runs
    .filter((run) => !run.passed)
    .map((run) => ({
      id: run.id,
      variant: run.variant,
      seed: run.seed,
      arm: run.arm,
      failure: run.failure,
      failedChecks: Object.entries(run.checks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key),
      providerFailures: run.events.filter((event) => event.failure).map((event) => event.failure),
    })),
  setup: { training: setup, lifecycleLaunches: chain },
  historicalEvidence: {
    note: 'Run IDs deduplicated across raw timestamped reports. Lower bounds omit unknown amounts, not unknown requests. Standalone diagnostics and the interrupted unsaved training request are additional costs; lifetime total remains unavailable.',
    allRetainedAgentTasks: historicalSummary([...uniqueHistoricalRuns.values()]),
    developmentOutsidePrimaryCohortAndSourceTraining: historicalSummary(outsideCohort),
    retainedMinimalInferenceProbes: probes.map(({ file, events }) => ({
      file,
      totalTokens: events.every((event) => event.usage.totalTokens !== null)
        ? events.reduce((sum, event) => sum + event.usage.totalTokens!, 0)
        : null,
      estimatedCostUsd: estimateBillingCost(events, pricing),
    })),
  },
  breakEvenExecutions: null,
  breakEvenNote:
    'Full-cohort per-request inference cost and historical failed setup costs are unknown; no reliable amortization count can be claimed.',
  limitations: [
    'One synthetic customer and fixed financial snapshot; seeds vary fault jitter, not financial facts.',
    'Original and compiled tool arms only: no prefetch or handwritten arm in this study.',
    'Real Gemini inference; simulated business services and financial writes.',
    'Interrupted/resumed launches; provider cache and machine scheduling are not controlled.',
    'Latency includes all attempted work and outliers; quantiles are not production estimates.',
    'Compiled span duration includes business reads and governance, not isolated selector overhead.',
    'Repeated reads do not independently prove unnecessary reads; field-level read necessity was not labeled.',
    'Cost is API-equivalent under a retained published rate card, not account billing.',
  ],
};
writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ destination, complete: result.complete, tasks: runs.length }));
