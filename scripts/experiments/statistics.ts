import type { Measurement } from '../../src/telemetry/measurement.js';
export const numericKeys = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'totalTokens',
  'modelCalls',
  'toolCalls',
  'durationMs',
] as const;
export function mean(runs: Measurement[]) {
  if (!runs.length) throw new Error('No measured runs.');
  return Object.fromEntries(
    numericKeys.map((key) => {
      const values = runs.map((run) => run[key]);
      return [
        key,
        values.some((value) => value === null)
          ? null
          : values.reduce<number>((sum, value) => sum + value!, 0) / runs.length,
      ];
    }),
  ) as Record<(typeof numericKeys)[number], number | null>;
}
export function comparison(before: number | null, after: number | null) {
  return {
    baseline: before,
    optimized: after,
    absoluteSaving: before === null || after === null ? null : before - after,
    percentSaving:
      before === null || after === null || before === 0 ? null : ((before - after) / before) * 100,
  };
}
export function breakEven(oneTime: number | null, perRequestSaving: number | null) {
  return oneTime === null || perRequestSaving === null || perRequestSaving <= 0
    ? null
    : Math.ceil(oneTime / perRequestSaving);
}
export function latencySummary(runs: Measurement[]) {
  const sorted = runs.map((run) => run.durationMs).sort((a, b) => a - b);
  return Object.fromEntries(
    [
      ['p50', 0.5],
      ['p95', 0.95],
    ].map(([name, fraction]) => [name, sorted[Math.ceil(sorted.length * Number(fraction)) - 1]]),
  );
}
