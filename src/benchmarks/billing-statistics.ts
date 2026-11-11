import { comparison } from '../../scripts/experiments/statistics.js';
import type { BillingArm, BillingRun } from './billing-workspace.js';
import { billingVariants } from './billing-fixtures.js';
import { z } from 'zod';
import type { ModelEvent } from '../agent/providers.js';

export const billingPricingSchema = z
  .object({
    model: z.literal('gemini-3.8-flash'),
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative(),
    maxInputTokens: z.number().int().positive(),
    source: z.url(),
    verifiedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export function estimateBillingCost(
  events: readonly ModelEvent[],
  pricing: z.infer<typeof billingPricingSchema> | null,
) {
  if (!pricing || !events.length) return null;
  let total = 0;
  for (const event of events) {
    const { inputTokens, outputTokens, cachedInputTokens } = event.usage;
    if (
      inputTokens === null ||
      outputTokens === null ||
      cachedInputTokens === null ||
      inputTokens > pricing.maxInputTokens ||
      cachedInputTokens > inputTokens
    )
      return null;
    total +=
      ((inputTokens - cachedInputTokens) * pricing.inputPerMillion +
        cachedInputTokens * pricing.cachedInputPerMillion +
        outputTokens * pricing.outputPerMillion) /
      1000000;
  }
  return total;
}

export function billingStatistics(runs: readonly BillingRun[]) {
  const measured = runs.filter((run) => run.phase === 'measured');
  const pairs = billingVariants.flatMap((variant) => {
    const seeds = [
      ...new Set(measured.filter((run) => run.variant === variant).map((run) => run.seed)),
    ];
    return seeds.flatMap((seed) => {
      const baseline = measured.find(
        (run) => run.variant === variant && run.seed === seed && run.arm === 'baseline',
      );
      const optimized = measured.find(
        (run) => run.variant === variant && run.seed === seed && run.arm === 'optimized',
      );
      return baseline && optimized ? [{ variant, seed, baseline, optimized }] : [];
    });
  });
  const metrics = {
    inputTokens: (run: BillingRun) => run.usage.inputTokens,
    outputTokens: (run: BillingRun) => run.usage.outputTokens,
    cachedInputTokens: (run: BillingRun) => run.usage.cachedInputTokens,
    totalTokens: (run: BillingRun) => run.usage.totalTokens,
    modelCalls: (run: BillingRun) => run.events.length,
    toolCalls: (run: BillingRun) => run.modelToolCalls,
    businessCalls: (run: BillingRun) => run.businessCalls,
    durationMs: (run: BillingRun) => run.durationMs,
    estimatedCostUsd: (run: BillingRun) => run.estimatedCostUsd,
    successRate: (run: BillingRun) => Number(run.passed),
    fallbackRate: (run: BillingRun) => Number(run.fallbacks > 0),
    toolErrors: (run: BillingRun) => run.toolErrors,
    retryCalls: (run: BillingRun) => run.retryCalls,
  };
  const average = (values: (number | null)[]) =>
    !values.length || values.some((value) => value === null)
      ? null
      : values.reduce<number>((sum, value) => sum + value!, 0) / values.length;
  const summarize = (arm: BillingArm) =>
    Object.fromEntries(
      Object.entries(metrics).map(([name, value]) => [
        name,
        average(measured.filter((run) => run.arm === arm).map(value)),
      ]),
    );
  const latency = (arm: BillingArm) => {
    const times = measured
      .filter((run) => run.arm === arm)
      .map((run) => run.durationMs)
      .sort((a, b) => a - b);
    return {
      medianMs: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
      p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
    };
  };
  const paired = Object.fromEntries(
    Object.entries(metrics).map(([name, value]) => {
      const differences = pairs.map((pair) => ({
        ...comparison(value(pair.baseline), value(pair.optimized)),
        variant: pair.variant,
        seed: pair.seed,
      }));
      // Seeded case-block bootstrap, mirroring the existing routing experiment. This describes
      // only these seven fixed synthetic conditions, not independent customers or production p95.
      const groups = billingVariants
        .map((variant) => differences.filter((delta) => delta.variant === variant))
        .filter((group) => group.length);
      let interval: number[] | null = null;
      if (
        groups.length >= 5 &&
        pairs.every(
          (pair) => pair.baseline.origin === 'observed' && pair.optimized.origin === 'observed',
        ) &&
        differences.every((delta) => delta.absoluteSaving !== null)
      ) {
        let state = 1042;
        const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
        const samples = Array.from({ length: 1000 }, () =>
          average(
            groups
              .flatMap(() => groups[Math.floor(random() * groups.length)])
              .map((delta) => delta.absoluteSaving),
          )!,
        ).sort((a, b) => a - b);
        interval = [samples[24], samples[974]];
      }
      return [
        name,
        {
          ...comparison(
            average(pairs.map((pair) => value(pair.baseline))),
            average(pairs.map((pair) => value(pair.optimized))),
          ),
          descriptive95PercentCaseBlockInterval: interval,
          differences,
        },
      ];
    }),
  );
  return {
    pairedTrials: pairs.length,
    perVariant: billingVariants.map((variant) => ({
      variant,
      pairedTrials: pairs.filter((pair) => pair.variant === variant).length,
      baselinePassed: pairs.filter((pair) => pair.variant === variant && pair.baseline.passed)
        .length,
      optimizedPassed: pairs.filter((pair) => pair.variant === variant && pair.optimized.passed)
        .length,
    })),
    means: { baseline: summarize('baseline'), optimized: summarize('optimized') },
    latency: { baseline: latency('baseline'), optimized: latency('optimized') },
    paired,
    correctnessEquivalent:
      pairs.length > 0 && pairs.every((pair) => pair.baseline.passed && pair.optimized.passed),
    uncertaintyNote:
      'Seven fixed synthetic conditions and one customer; latency quantiles and bootstrap intervals are descriptive, not production tail-latency evidence.',
  };
}
