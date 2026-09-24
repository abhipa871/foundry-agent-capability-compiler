import type { Run, State } from '../domain.js';
export function metrics(runs: Run[]): State['metrics'] {
  const successful = runs.filter((r) => r.status === 'success');
  return {
    successful: successful.length,
    total: runs.length,
    avgLatencyMs: successful.length
      ? successful.reduce((sum, r) => sum + r.durationMs, 0) / successful.length
      : 0,
    totalCredit:
      Math.round(successful.reduce((sum, r) => sum + (r.output?.totalCredit ?? 0), 0) * 100) / 100,
  };
}
