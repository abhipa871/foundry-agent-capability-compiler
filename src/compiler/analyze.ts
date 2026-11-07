import { createHash } from 'node:crypto';
import { canonical } from './ir.js';
import { canonicalNodes, signatureOf, minePattern } from './patterns.js';
import { buildProvenance } from '../exploration/provenance.js';
import type { StoredToolTrace } from '../exploration/tool-events.js';
import { contracts } from '../runtime/adapters/registry.js';
import { DomainError } from '../domain.js';

export type OptimizationPattern = {
  id: string;
  tenantId: string;
  principalId: string;
  taskKind: string;
  signature: string;
  traceIds: string[];
  occurrences: number;
  attempts: number;
  taskSuccessRate: number;
  toolSequence: string[];
  dependencies: { operation: string; deps: string[] }[];
  averageTokens: number | null;
  averageModelCalls: number | null;
  averageToolCalls: number;
  averageCostUsd: number | null;
  averageLatencyMs: number;
  potentialToolCallReduction: number;
  measurementOrigin: 'observed' | 'fixture' | 'estimated';
  eligible: boolean;
  reasons: string[];
  analyzedAt: string;
};
const average = (values: (number | null)[]): number | null =>
  !values.length || values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0) / values.length;

export function analyzePatterns(
  traces: StoredToolTrace[],
  tenantId: string,
): OptimizationPattern[] {
  if (traces.length > 10000) throw new DomainError('Offline analysis trace budget exceeded.', 429);
  if (traces.some((trace) => trace.tenantId !== tenantId))
    throw new DomainError('Cross-tenant analysis rejected.', 403);
  const partitions = new Map<string, StoredToolTrace[]>();
  for (const trace of traces) {
    const key = canonical({
      taskKind: trace.taskKind,
      principal: trace.principalId ?? 'local-operator',
      agent: trace.agentId ?? 'unknown',
      provider: trace.provider ?? 'unknown',
      model: trace.agentModel,
      snapshot: trace.snapshot,
      policy: trace.policyVersion,
      origin: trace.measurement?.origin ?? (trace.source === 'demo' ? 'fixture' : 'estimated'),
      adapters: [
        ...new Set(
          trace.events
            .filter((event) => event.operation in contracts)
            .map(
              (event) =>
                `${event.operation}:${event.adapterVersion}:${[...event.credentialScopeIds].sort().join(',')}`,
            ),
        ),
      ].sort(),
    });
    partitions.set(key, [...(partitions.get(key) ?? []), trace]);
  }
  const results: OptimizationPattern[] = [];
  for (const [partition, attempts] of partitions) {
    const groups = new Map<string, StoredToolTrace[]>();
    for (const trace of attempts.filter((entry) => entry.status === 'success')) {
      try {
        const signature = signatureOf(canonicalNodes(buildProvenance(trace)));
        groups.set(signature, [...(groups.get(signature) ?? []), trace]);
      } catch {
        /* Invalid dependency evidence is excluded, never repaired by similarity. */
      }
    }
    for (const [signature, supporting] of groups) {
      const first = supporting[0];
      const nodes = canonicalNodes(buildProvenance(first));
      const reasons: string[] = [];
      if (new Set(supporting.map((trace) => trace.traceId)).size < 2)
        reasons.push('At least two distinct successful traces required.');
      if (new Set(supporting.map((trace) => trace.taskInput.customerId)).size < 2)
        reasons.push('Distinct task inputs required.');
      if (
        first.taskKind !== 'customer_context' ||
        nodes.length !== 3 ||
        Object.keys(contracts).some(
          (operation) => !nodes.some((node) => node.operation === operation),
        )
      )
        reasons.push('Outside the three-read customer context target.');
      if (
        supporting.some((trace) =>
          trace.events.some(
            (event) =>
              event.effect === 'write' ||
              event.effect === 'external_write' ||
              event.operation.startsWith('policy.'),
          ),
        )
      )
        reasons.push('Unsupported effect or policy evidence.');
      if (
        supporting.some((trace) =>
          trace.events.some(
            (event) => event.status === 'success' && !(event.operation in contracts),
          ),
        )
      )
        reasons.push('Successful uncontracted work cannot be discarded.');
      if (supporting.length >= 2) {
        try {
          minePattern(supporting.map(buildProvenance));
        } catch {
          reasons.push('Existing matcher rejected the evidence.');
        }
      }
      const origin =
        first.measurement?.origin ?? (first.source === 'demo' ? 'fixture' : 'estimated');
      if (origin !== 'observed' && tenantId !== 'local-demo')
        reasons.push('Observed evidence required outside the local fixture demonstration.');
      const tools = supporting.map(
        (trace) =>
          trace.measurement?.toolCalls ??
          trace.events.filter((event) => event.status !== 'skipped').length,
      );
      const averageTools = average(tools)!;
      results.push({
        id: createHash('sha256')
          .update(canonical({ tenantId, partition, signature }))
          .digest('hex'),
        tenantId,
        principalId: first.principalId ?? 'local-operator',
        taskKind: first.taskKind,
        signature,
        traceIds: supporting.map((trace) => trace.traceId),
        occurrences: supporting.length,
        attempts: attempts.length,
        taskSuccessRate:
          attempts.filter((trace) => trace.status === 'success').length / attempts.length,
        toolSequence: nodes.map((node) => node.operation),
        dependencies: nodes.map((node) => ({ operation: node.operation, deps: node.deps })),
        averageTokens: average(
          supporting.map((trace) =>
            trace.measurement
              ? trace.measurement.totalTokens
              : origin === 'fixture'
                ? trace.agentTokens
                : null,
          ),
        ),
        averageModelCalls: average(
          supporting.map((trace) =>
            trace.measurement
              ? trace.measurement.modelCalls
              : origin === 'fixture'
                ? trace.llmInvocations
                : null,
          ),
        ),
        averageToolCalls: averageTools,
        averageCostUsd: average(supporting.map((trace) => trace.measurement?.costUsd ?? null)),
        averageLatencyMs: average(supporting.map((trace) => trace.durationMs))!,
        potentialToolCallReduction: Math.max(0, averageTools - nodes.length),
        measurementOrigin: origin,
        eligible: reasons.length === 0,
        reasons,
        analyzedAt: new Date().toISOString(),
      });
    }
  }
  return results.sort((a, b) => b.occurrences - a.occurrences || a.id.localeCompare(b.id));
}
