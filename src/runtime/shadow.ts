import { createHash, randomUUID } from 'node:crypto';
import { canonical, type IRArtifact } from '../compiler/ir.js';
import { sameContext } from './observable.js';
import {
  dispatch,
  checkGuards,
  type AgentFallback,
  type TaskRequest,
  type DispatchOutcome,
} from './dispatcher.js';
import { interpret } from './interpret.js';
import type { AdapterRunner, RuntimeContext } from './adapters/registry.js';
import type { Measurement } from '../telemetry/measurement.js';

export type ShadowRun = {
  id: string;
  tenantId: string;
  artifactId: string;
  digest: string;
  validationStamp: string;
  inputHash: string;
  customerId: string | undefined;
  createdAt: string;
  expiresAt: string;
  status: 'match' | 'mismatch' | 'compiled_failure' | 'baseline_unavailable' | 'guard_miss';
  nativeMeasurement: Measurement;
  compiledDurationMs?: number;
  compiledToolCalls?: number;
};
export const validationStamp = (artifact: IRArtifact) =>
  `${artifact.digest}:${artifact.verifiedAt ?? 'unverified'}`;

// The native result is always returned. A shadow result is used only as evidence. Adapters must
// enforce read-only operations and a coherent snapshot; this implementation pins fixtures-v1.
export async function shadowExecute(
  request: TaskRequest,
  artifact: IRArtifact,
  options: {
    adapters: AdapterRunner;
    context: RuntimeContext;
    agent?: AgentFallback;
  },
): Promise<{ authoritative: DispatchOutcome; shadow: ShadowRun }> {
  const authoritative = await dispatch(request, [], options);
  const shadow: ShadowRun = {
    id: randomUUID(),
    tenantId: options.context.tenantId,
    artifactId: artifact.id,
    digest: artifact.digest,
    validationStamp: validationStamp(artifact),
    inputHash: createHash('sha256').update(canonical(request.input)).digest('hex'),
    customerId: (request.input as { customerId?: string })?.customerId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    status: 'baseline_unavailable',
    nativeMeasurement: authoritative.measurement,
  };
  if (authoritative.outcome !== 'success' || !authoritative.result)
    return { authoritative, shadow };
  const guarded = { ...artifact, status: 'approved' as const, approvedDigest: artifact.digest };
  if (
    !['verified', 'approved'].includes(artifact.status) ||
    !checkGuards(guarded, request, options.context).every((entry) => entry.ok)
  ) {
    shadow.status = 'guard_miss';
    return { authoritative, shadow };
  }
  try {
    const run = await interpret(artifact.ir, request.input, options);
    shadow.compiledDurationMs = run.durationMs;
    shadow.compiledToolCalls = run.adapterCalls;
    shadow.status = sameContext(authoritative.result, run.result) ? 'match' : 'mismatch';
  } catch {
    shadow.status = 'compiled_failure';
  }
  return { authoritative, shadow };
}

export function shadowReadiness(artifact: IRArtifact, runs: ShadowRun[], now = Date.now()) {
  const eligible = runs.filter(
    (run) =>
      run.artifactId === artifact.id &&
      run.tenantId === artifact.ir.guards.tenantId &&
      run.validationStamp === validationStamp(artifact) &&
      Date.parse(run.expiresAt) > now,
  );
  const matches = eligible.filter((run) => run.status === 'match');
  const failures = eligible.filter((run) => ['mismatch', 'compiled_failure'].includes(run.status));
  const covered = [...new Set(matches.map((run) => run.customerId))];
  const ready =
    matches.length >= 3 &&
    ['C-101', 'C-202', 'C-303'].every((id) => covered.includes(id)) &&
    failures.length === 0;
  return {
    ready,
    matches: matches.length,
    failures: failures.length,
    covered,
    requirement:
      'Three full-context matches covering C-101, C-202 and C-303 on the current verification; no divergence.',
  };
}
