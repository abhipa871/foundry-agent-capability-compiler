import type { Measurement } from '../../src/telemetry/measurement.js';
import { comparison, latencySummary, mean, numericKeys } from './statistics.js';
export type MetricRun = {
  measurement: Measurement;
  apiEquivalentCostUsd: number | null;
  assessment: { passed: boolean };
  usedFallback: boolean;
  unnecessaryReads: number;
  duplicateSuccessfulReads: number;
  selectorMs: number;
};
const average = (values: (number | null)[]) =>
  !values.length || values.some((v) => v === null)
    ? null
    : values.reduce<number>((s, v) => s + v!, 0) / values.length;
export function summarizeRouting(rows: MetricRun[]) {
  if (!rows.length) return null;
  return {
    requests: rows.length,
    mean: mean(rows.map((r) => r.measurement)),
    latency: latencySummary(rows.map((r) => r.measurement)),
    apiEquivalentCostUsd: average(rows.map((r) => r.apiEquivalentCostUsd)),
    correctnessRate: rows.filter((r) => r.assessment.passed).length / rows.length,
    successRate: rows.filter((r) => r.measurement.outcome === 'success').length / rows.length,
    deniedRate: rows.filter((r) => r.measurement.outcome === 'denied').length / rows.length,
    failedRate: rows.filter((r) => r.measurement.outcome === 'failed').length / rows.length,
    fallbackRate: rows.filter((r) => r.usedFallback).length / rows.length,
    meanUnnecessaryReads: average(rows.map((r) => r.unnecessaryReads)),
    meanDuplicateSuccessfulReads: average(rows.map((r) => r.duplicateSuccessfulReads)),
    meanSelectorMs: average(rows.map((r) => r.selectorMs)),
  };
}
export function pairedRouting(
  rows: { caseId: string; baseline: MetricRun; optimized: MetricRun }[],
  seed = 4107,
) {
  const keys = [
    ...numericKeys,
    'apiEquivalentCostUsd',
    'unnecessaryReads',
    'duplicateSuccessfulReads',
    'selectorMs',
  ] as const;
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return Object.fromEntries(
    keys.map((key) => {
      const value = (run: MetricRun) =>
        key in run.measurement
          ? (run.measurement[key as keyof Measurement] as number | null)
          : run[key as 'apiEquivalentCostUsd'];
      const differences = rows.map((row) => ({
        caseId: row.caseId,
        delta:
          value(row.baseline) === null || value(row.optimized) === null
            ? null
            : value(row.baseline)! - value(row.optimized)!,
      }));
      const groups = [...new Set(differences.map((r) => r.caseId))].map((id) =>
        differences.filter((r) => r.caseId === id),
      );
      let interval: number[] | null = null;
      if (groups.length >= 5 && differences.every((r) => r.delta !== null)) {
        const samples = Array.from({ length: 2000 }, () => {
          const sampled = groups.flatMap(() => groups[Math.floor(random() * groups.length)]);
          return average(sampled.map((r) => r.delta))!;
        }).sort((a, b) => a - b);
        interval = [samples[49], samples[1949]];
      }
      return [
        key,
        {
          ...comparison(
            average(rows.map((r) => value(r.baseline))),
            average(rows.map((r) => value(r.optimized))),
          ),
          pairedDifferences: differences,
          descriptiveCaseBlockBootstrap95: interval,
        },
      ];
    }),
  );
}
