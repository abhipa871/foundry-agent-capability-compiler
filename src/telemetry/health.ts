export type HealthReason =
  | 'equivalence_mismatch'
  | 'runtime_failures'
  | 'adapter_drift'
  | 'latency_regression'
  | 'validation_failed'
  | 'validation_expired'
  | 'operator';
export type CapabilityHealth = {
  id: string;
  tenantId: string;
  artifactId: string;
  status: 'healthy' | 'quarantined';
  reason?: HealthReason;
  samples: number;
  failedRuns: number;
  mismatches: number;
  consecutiveFailures: number;
  slowRuns: number;
  durationsMs: number[];
  updatedAt: string;
};
export type HealthObservation = {
  kind: 'success' | 'failure' | 'mismatch' | 'drift' | 'unsupported';
  durationMs?: number;
  reason?: HealthReason;
};
export function initialHealth(tenantId: string, artifactId: string): CapabilityHealth {
  return {
    id: `health:${artifactId}`,
    tenantId,
    artifactId,
    status: 'healthy',
    samples: 0,
    failedRuns: 0,
    mismatches: 0,
    consecutiveFailures: 0,
    slowRuns: 0,
    durationsMs: [],
    updatedAt: new Date().toISOString(),
  };
}
export function observeHealth(
  previous: CapabilityHealth,
  observation: HealthObservation,
): CapabilityHealth {
  const next = {
    ...previous,
    samples: previous.samples + 1,
    durationsMs: [...previous.durationsMs],
    updatedAt: new Date().toISOString(),
  };
  if (observation.kind === 'unsupported') return next;
  if (observation.kind === 'success') {
    next.consecutiveFailures = 0;
    if (observation.durationMs !== undefined) {
      const ordered = [...previous.durationsMs].sort((a, b) => a - b);
      const reference = ordered[Math.floor(ordered.length * 0.95)];
      const slow = ordered.length >= 5 && observation.durationMs > Math.max(50, reference * 3);
      next.slowRuns = slow ? previous.slowRuns + 1 : 0;
      if (!slow) next.durationsMs = [...previous.durationsMs, observation.durationMs].slice(-20);
      if (next.slowRuns >= 3) {
        next.status = 'quarantined';
        next.reason = 'latency_regression';
      }
    }
  } else {
    next.failedRuns += 1;
    next.consecutiveFailures += 1;
    if (observation.kind === 'mismatch') next.mismatches += 1;
    if (observation.kind !== 'failure' || observation.reason || next.consecutiveFailures >= 3) {
      next.status = 'quarantined';
      next.reason =
        observation.reason ??
        (observation.kind === 'mismatch'
          ? 'equivalence_mismatch'
          : observation.kind === 'drift'
            ? 'adapter_drift'
            : 'runtime_failures');
    }
  }
  // Only explicit successful revalidation resets a quarantine. Telemetry cannot restore trust.
  return next;
}
