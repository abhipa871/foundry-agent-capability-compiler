import { z } from 'zod';

const count = z.number().int().nonnegative().max(100000000).nullable();
export const measurementSchema = z
  .object({
    origin: z.enum(['observed', 'fixture', 'estimated']),
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count,
    totalTokens: count,
    modelCalls: count,
    toolCalls: count,
    apiCalls: count,
    durationMs: z.number().finite().nonnegative(),
    costUsd: z.number().finite().nonnegative().nullable(),
    outcome: z.enum(['success', 'failed', 'unresolved', 'denied']),
  })
  .strict()
  .refine(
    (v) =>
      v.cachedInputTokens === null ||
      v.inputTokens === null ||
      v.cachedInputTokens <= v.inputTokens,
    'Cached tokens exceed input tokens.',
  );
export type Measurement = z.infer<typeof measurementSchema>;
export type ReportedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
};
export const reportedUsageSchema = z
  .object({
    inputTokens: count.unwrap(),
    outputTokens: count.unwrap(),
    cachedInputTokens: count.unwrap().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine((v) => (v.cachedInputTokens ?? 0) <= v.inputTokens, 'Cached tokens exceed input tokens.');
export function emptyMeasurement(origin: Measurement['origin'] = 'observed'): Measurement {
  return {
    origin,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    apiCalls: 0,
    durationMs: 0,
    costUsd: null,
    outcome: 'unresolved',
  };
}
export function reduction(before: number | null, after: number | null): number | null {
  return before === null || after === null || before <= 0
    ? null
    : ((before - after) / before) * 100;
}
export function savings(baseline: Measurement, optimized: Measurement) {
  // Fixture token counts and estimates cannot establish measured token/cost savings.
  const observed = baseline.origin === 'observed' && optimized.origin === 'observed';
  return {
    tokenSavingsPercent: observed ? reduction(baseline.totalTokens, optimized.totalTokens) : null,
    modelCallSavingsPercent: observed ? reduction(baseline.modelCalls, optimized.modelCalls) : null,
    toolCallSavingsPercent: reduction(baseline.toolCalls, optimized.toolCalls),
    latencySavingsPercent: reduction(baseline.durationMs, optimized.durationMs),
    costSavingsPercent: observed ? reduction(baseline.costUsd, optimized.costUsd) : null,
  };
}
