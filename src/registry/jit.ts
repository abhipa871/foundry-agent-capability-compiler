import { randomInt } from 'node:crypto';
import {
  initialHealth,
  observeHealth,
  type HealthObservation,
  type HealthReason,
} from '../telemetry/health.js';
import {
  routingSchema,
  telemetrySchema,
  wireArtifactSchema,
  type RuntimeTicket,
} from '../integration/protocol.js';
import { analyzePatterns, type OptimizationPattern } from '../compiler/analyze.js';
import { compileIR, type CompileOptions } from '../compiler/compile-ir.js';
import { assertDigest, emitArtifact } from '../compiler/emit.js';
import { irDigest, type IRArtifact } from '../compiler/ir.js';
import { DomainError } from '../domain.js';
import { sampleToolTraces } from '../exploration/sample-traces.js';
import { captureToolTrace, type StoredToolTrace } from '../exploration/tool-events.js';
import {
  localContext,
  mockAdapters,
  type AdapterRunner,
  type RuntimeContext,
} from '../runtime/adapters/registry.js';
import type { ExecutionCheckpoint } from '../runtime/checkpoint.js';
import { dispatch, type AgentFallback, type TaskRequest } from '../runtime/dispatcher.js';
import { shadowExecute, shadowReadiness } from '../runtime/shadow.js';
import { verifyIR } from '../verification/verify-ir.js';
import { currentIdentity } from '../security/identity.js';
import { Store, type StoredDispatchRun } from './store.js';

export type JitProfile = {
  name: string;
  taskKind: string;
  runs: number;
  compiled: number;
  agent: number;
  compiledLlmInvocations: number;
  agentLlmInvocations: number;
  agentTokens: number;
  adapterCalls: number;
  p50DurationMs: number;
  p95DurationMs: number;
  fallbacks: Record<string, number>;
  recordedTraceBaseline: {
    traces: number;
    avgLlmInvocations: number;
    avgTokens: number;
    avgDurationMs: number;
    note: string;
  };
};

// Control plane for the compiled read-only capability: ingest evidence, compile a candidate,
// verify the candidate artifact, gate promotion, then dispatch through the guarded runtime.
// Nothing here executes model output; the data plane is the IR interpreter and its adapters.
export class JitRegistry {
  constructor(
    readonly store: Store,
    private readonly audit: (action: string, target: string, detail: string) => void,
    private readonly runtime: {
      adapters?: () => AdapterRunner;
      context?: () => RuntimeContext;
      agent?: AgentFallback;
    } = {},
  ) {}

  private adapters(): AdapterRunner {
    return (this.runtime.adapters ?? (() => mockAdapters()))();
  }
  private context(): RuntimeContext {
    return (this.runtime.context ?? localContext)();
  }

  seed() {
    if (this.store.all('toolTrace').length) return;
    for (const trace of sampleToolTraces) this.ingest(trace, 'demo');
  }

  traces(): StoredToolTrace[] {
    return this.store.all('toolTrace');
  }

  artifacts(): IRArtifact[] {
    return this.store.all('irArtifact');
  }

  runs(): StoredDispatchRun[] {
    return this.store.all('dispatchRun');
  }

  checkpoints(): ExecutionCheckpoint[] {
    return this.store.all('checkpoint');
  }

  get(id: string): IRArtifact {
    const artifact = this.store.get('irArtifact', id);
    if (!artifact) throw new DomainError('Compiled capability not found.', 404);
    return artifact;
  }

  ingest(value: unknown, source: StoredToolTrace['source']): StoredToolTrace {
    const trace = captureToolTrace(value, source);
    if (trace.tenantId !== this.store.tenantId) throw new DomainError('Tenant mismatch.', 403);
    if (this.store.tenantId !== 'local-demo' && trace.principalId !== currentIdentity().principalId)
      throw new DomainError('Principal mismatch.', 403);
    if (this.store.get('toolTrace', trace.id))
      throw new DomainError('That trace has already been ingested.', 409);
    this.store.transaction(() => {
      this.store.put('toolTrace', trace);
      this.audit(
        'trace.ingested',
        trace.id,
        `${source}: ${trace.events.length} typed tool events for ${trace.taskKind}`,
      );
    });
    return trace;
  }

  patterns(): OptimizationPattern[] {
    return this.store.all('pattern');
  }

  analyze(): OptimizationPattern[] {
    const patterns = analyzePatterns(this.traces(), this.store.tenantId);
    this.store.transaction(() => {
      this.store.deleteKind('pattern');
      for (const pattern of patterns) this.store.put('pattern', pattern);
      this.audit(
        'patterns.analyzed',
        this.store.tenantId,
        `${patterns.length} structural groups; no capability promoted.`,
      );
    });
    return patterns;
  }

  compilePattern(patternId: string): IRArtifact {
    // Stored reports are explanatory snapshots. Eligibility is recomputed from current evidence,
    // so a caller cannot edit a report or retain stale eligibility to authorize compilation.
    const pattern = analyzePatterns(this.traces(), this.store.tenantId).find(
      (entry) => entry.id === patternId,
    );
    if (!pattern) throw new DomainError('Pattern not found.', 404);
    if (!pattern.eligible)
      throw new DomainError('Pattern is not eligible for read-only compilation.', 409);
    const existing = this.artifacts().find(
      (artifact) =>
        artifact.patternId === patternId &&
        artifact.status !== 'revoked' &&
        JSON.stringify([...artifact.ir.provenance.traceIds].sort()) ===
          JSON.stringify([...pattern.traceIds].sort()),
    );
    if (existing) return existing;
    const artifact = this.compile(pattern.traceIds);
    const next = { ...artifact, patternId, measurementOrigin: pattern.measurementOrigin };
    this.store.transaction(() => {
      this.store.put('irArtifact', next);
      this.audit(
        'pattern.candidate',
        next.id,
        `Untrusted read-only candidate from ${pattern.occurrences} observations.`,
      );
    });
    return next;
  }

  compile(traceIds?: string[], options: CompileOptions = {}): IRArtifact {
    const available = this.traces();
    const traces = traceIds?.length
      ? traceIds.map((id) => {
          const trace = available.find((candidate) => candidate.id === id);
          if (!trace) throw new DomainError(`Trace ${id} not found.`, 404);
          return trace;
        })
      : available;
    const { ir, report } = compileIR(traces, options);
    const version =
      Math.max(
        0,
        ...this.artifacts()
          .filter((artifact) => artifact.name === ir.name)
          .map((artifact) => artifact.version),
      ) + 1;
    const artifact = emitArtifact(ir, report, { version });
    this.store.transaction(() => {
      this.store.put('irArtifact', artifact);
      this.audit(
        'ir.compiled',
        artifact.id,
        `${artifact.name} v${version} from ${report.supportingTraceIds.length} traces; ${ir.nodes.length} IR nodes; digest ${artifact.digest.slice(0, 12)}`,
      );
    });
    return artifact;
  }

  async verify(id: string): Promise<IRArtifact> {
    const artifact = assertDigest(this.get(id));
    const checks = await verifyIR(artifact, this.traces());
    const current = this.get(id);
    if (
      (current.revision ?? 0) !== (artifact.revision ?? 0) ||
      current.digest !== artifact.digest ||
      current.status === 'revoked'
    )
      throw new DomainError('Artifact changed during verification.', 409);
    const passed = checks.length > 0 && checks.every((check) => check.passed);
    const next: IRArtifact = {
      ...artifact,
      checks,
      verifiedAt: new Date().toISOString(),
      verifiedDigest: passed ? artifact.digest : undefined,
      status: passed
        ? this.store.tenantId === 'local-demo' && artifact.status === 'approved'
          ? 'approved'
          : 'verified'
        : 'draft',
      approvedDigest:
        passed && this.store.tenantId === 'local-demo' ? artifact.approvedDigest : undefined,
      revision: (artifact.revision ?? 0) + 1,
      validationVersion: 'read-validation-v3',
    };
    this.store.transaction(() => {
      this.store.put('irArtifact', next);
      if (!passed || this.store.tenantId !== 'local-demo')
        this.store.undeploy(`jit/${artifact.name}`, id);
      this.store.put(
        'health',
        passed
          ? initialHealth(this.store.tenantId, id)
          : {
              ...this.health(id),
              status: 'quarantined',
              reason: 'validation_failed',
              updatedAt: new Date().toISOString(),
            },
      );
      this.audit(
        'ir.verified',
        id,
        `${checks.filter((check) => check.passed).length}/${checks.length} checks passed`,
      );
    });
    return next;
  }

  approve(id: string, note: string): IRArtifact {
    const artifact = assertDigest(this.get(id));
    if (
      artifact.status !== 'verified' ||
      !artifact.checks.length ||
      !artifact.checks.every((check) => check.passed) ||
      artifact.verifiedDigest !== artifact.digest
    )
      throw new DomainError(
        'Approval requires a passing verification run against this exact artifact digest.',
        409,
      );
    const next: IRArtifact = {
      ...artifact,
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedDigest: artifact.digest,
      reviewNote: note,
      revision: (artifact.revision ?? 0) + 1,
    };
    this.store.transaction(() => {
      this.store.put('irArtifact', next);
      if (this.store.tenantId === 'local-demo') this.store.deploy(`jit/${next.name}`, next.id);
      this.audit('ir.approved', id, `v${next.version}: ${note}`);
    });
    return next;
  }

  deploy(id: string): IRArtifact {
    const artifact = assertDigest(this.get(id));
    if (
      this.health(id).status !== 'healthy' ||
      artifact.status !== 'approved' ||
      artifact.approvedDigest !== artifact.digest ||
      artifact.verifiedDigest !== artifact.digest ||
      !artifact.checks.length ||
      !artifact.checks.every((check) => check.passed)
    )
      throw new DomainError('Only an approved artifact can be deployed.', 409);
    if (this.store.tenantId !== 'local-demo' && !this.shadowStatus(id).ready)
      throw new DomainError('Deployment requires passing read-only shadow coverage.', 409);
    this.store.transaction(() => {
      this.store.deploy(`jit/${artifact.name}`, artifact.id);
      this.audit(
        'ir.deployed',
        id,
        `Active compiled version for ${artifact.name} is now v${artifact.version}.`,
      );
    });
    return artifact;
  }

  revoke(id: string): IRArtifact {
    const artifact = this.get(id);
    const next: IRArtifact = {
      ...artifact,
      status: 'revoked',
      approvedDigest: undefined,
      revision: (artifact.revision ?? 0) + 1,
    };
    this.store.transaction(() => {
      this.store.undeploy(`jit/${artifact.name}`, artifact.id);
      this.store.put('irArtifact', next);
      this.audit('ir.revoked', id, `v${artifact.version} can no longer be dispatched.`);
    });
    return next;
  }

  active(): IRArtifact[] {
    const deployments = this.store.deployments();
    return this.artifacts().filter(
      (artifact) =>
        this.health(artifact.id).status === 'healthy' &&
        (this.store.tenantId === 'local-demo' || this.validationCurrent(artifact)) &&
        artifact.status === 'approved' &&
        artifact.verifiedDigest === artifact.digest &&
        artifact.checks.length > 0 &&
        artifact.checks.every((check) => check.passed) &&
        deployments[`jit/${artifact.name}`] === artifact.id &&
        irDigest(artifact.ir) === artifact.digest,
    );
  }

  async dispatch(request: TaskRequest): Promise<StoredDispatchRun> {
    const policy = this.routing();
    const live =
      this.store.tenantId === 'local-demo' ||
      (policy.mode === 'live' && randomInt(100) < policy.rolloutPercent);
    const outcome = await dispatch(
      request,
      live
        ? this.active().filter(
            (artifact) =>
              artifact.taskKind === request.kind &&
              (this.store.tenantId === 'local-demo' || this.shadowStatus(artifact.id).ready),
          )
        : [],
      { adapters: this.adapters(), context: this.context(), agent: this.runtime.agent },
    );
    const run: StoredDispatchRun = { ...outcome, id: outcome.runId };
    this.store.transaction(() => {
      this.store.put('dispatchRun', run);
      if (run.capabilityId) {
        if (run.mode === 'compiled')
          this.applyHealth(run.capabilityId, { kind: 'success', durationMs: run.durationMs });
        else if (run.fallbackReason === 'unsupported_state')
          this.applyHealth(run.capabilityId, { kind: 'unsupported' });
        else if (run.fallbackReason && run.outcome !== 'denied')
          this.applyHealth(run.capabilityId, { kind: 'failure' });
      }
      const drifted = this.artifacts().find(
        (entry) =>
          this.store.deployments()[`jit/${entry.name}`] === entry.id &&
          entry.taskKind === request.kind &&
          run.guards.some((guard) => guard.name === 'adapter_versions' && !guard.ok),
      );
      if (drifted) this.applyHealth(drifted.id, { kind: 'drift' });
      if (run.checkpoint) this.store.put('checkpoint', run.checkpoint);
      this.audit(
        `dispatch.${run.mode}`,
        run.id,
        run.mode === 'compiled'
          ? `${run.capability} v${run.capabilityVersion}: ${run.adapterCalls} adapter calls, 0 LLM calls, ${Math.round(run.durationMs)}ms`
          : `fallback ${run.fallbackReason}: ${run.fallbackDetail}`,
      );
    });
    return run;
  }

  private validationCurrent(artifact: IRArtifact, now = Date.now()) {
    const age = now - Date.parse(artifact.verifiedAt ?? '');
    return Number.isFinite(age) && age >= 0 && age <= 86400000;
  }
  health(id: string) {
    this.get(id);
    return this.store.get('health', `health:${id}`) ?? initialHealth(this.store.tenantId, id);
  }
  private applyHealth(id: string, observation: HealthObservation) {
    const next = observeHealth(this.health(id), observation);
    this.store.put('health', next);
    if (next.status === 'quarantined') {
      const artifact = this.get(id);
      this.store.undeploy(`jit/${artifact.name}`, id);
      this.audit(
        'health.quarantined',
        id,
        next.reason ?? 'Unsafe capability removed from routing.',
      );
    }
    return next;
  }
  quarantine(id: string, reason: HealthReason = 'operator') {
    return this.store.transaction(() => this.applyHealth(id, { kind: 'failure', reason }));
  }
  rollback(id: string) {
    const target = this.get(id);
    const currentId = this.store.deployments()[`jit/${target.name}`];
    const current = currentId ? this.get(currentId) : undefined;
    if (current && target.version >= current.version)
      throw new DomainError('Rollback requires a previous approved version.', 409);
    if (
      !this.shadowStatus(id).ready ||
      this.health(id).status !== 'healthy' ||
      !this.validationCurrent(target)
    )
      throw new DomainError(
        'Rollback target requires healthy current validation and shadow coverage.',
        409,
      );
    const deployed = this.deploy(id);
    this.audit('ir.rollback', id, `Rolled back ${target.name} to v${target.version}.`);
    return deployed;
  }
  maintenance(now = Date.now()) {
    for (const artifact of this.artifacts()) {
      if (
        ['verified', 'approved'].includes(artifact.status) &&
        !this.validationCurrent(artifact, now) &&
        this.health(artifact.id).status === 'healthy'
      )
        this.quarantine(artifact.id, 'validation_expired');
    }
    const purged = this.store.purgeExpired(now);
    this.audit('retention.purged', this.store.tenantId, `${purged} expired records deleted.`);
    return { purged, health: this.artifacts().map((artifact) => this.health(artifact.id)) };
  }

  routing() {
    return routingSchema.parse(
      this.store.setting('runtimeRouting', { mode: 'observe', rolloutPercent: 0 }),
    );
  }
  configureRouting(value: unknown) {
    const policy = routingSchema.parse(value);
    this.store.transaction(() => {
      this.store.setSetting('runtimeRouting', policy);
      this.audit(
        'routing.configured',
        this.store.tenantId,
        `${policy.mode}; ${policy.rolloutPercent}% rollout.`,
      );
    });
    return policy;
  }
  runtimeTicket(now = Date.now()): RuntimeTicket {
    const identity = currentIdentity();
    const policy = this.routing();
    const eligible =
      policy.mode === 'live'
        ? this.active().filter((entry) => this.shadowStatus(entry.id).ready)
        : this.artifacts();
    const artifact = [...eligible]
      .sort((a, b) => b.version - a.version)
      .find(
        (entry) =>
          ['verified', 'approved'].includes(entry.status) &&
          entry.verifiedDigest === entry.digest &&
          entry.validationVersion === 'read-validation-v3' &&
          entry.checks.every((check) => check.passed) &&
          irDigest(entry.ir) === entry.digest &&
          this.health(entry.id).status === 'healthy' &&
          this.validationCurrent(entry, now) &&
          (!entry.ir.guards.principalId || entry.ir.guards.principalId === identity.principalId),
      );
    const mode = policy.mode === 'observe' || !artifact ? 'observe' : policy.mode;
    return {
      format: 'foundry-runtime-v1',
      tenantId: this.store.tenantId,
      principalId: identity.principalId,
      issuedAt: now,
      expiresAt: now + 60000,
      mode,
      rolloutPercent: mode === 'observe' ? 0 : policy.rolloutPercent,
      ...(mode !== 'observe' && artifact
        ? {
            artifact: wireArtifactSchema.parse(
              Object.fromEntries(
                Object.keys(wireArtifactSchema.shape).map((key) => [
                  key,
                  artifact[key as keyof IRArtifact],
                ]),
              ),
            ),
          }
        : {}),
    };
  }
  ingestTelemetry(value: unknown) {
    const telemetry = telemetrySchema.parse(value);
    const identity = currentIdentity();
    if (
      telemetry.tenantId !== identity.tenantId ||
      telemetry.principalId !== identity.principalId ||
      telemetry.agentId !== identity.agentId
    )
      throw new DomainError('Telemetry identity mismatch.', 403);
    if (this.store.get('telemetry', telemetry.traceId))
      throw new DomainError('Duplicate telemetry.', 409);
    const stored = {
      ...telemetry,
      id: telemetry.traceId,
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      trust: 'client_reported' as const,
    };
    if (telemetry.capabilityId) {
      const artifact = this.get(telemetry.capabilityId);
      if (
        artifact.digest !== telemetry.capabilityDigest ||
        (artifact.ir.guards.principalId && artifact.ir.guards.principalId !== identity.principalId)
      )
        throw new DomainError('Telemetry artifact binding mismatch.', 403);
    }
    this.store.transaction(() => {
      this.store.put('telemetry', stored);
      if (telemetry.capabilityId) {
        if (telemetry.shadowStatus === 'mismatch')
          this.applyHealth(telemetry.capabilityId, { kind: 'mismatch' });
        else if (
          telemetry.runtimeStatus === 'fallback' ||
          telemetry.shadowStatus === 'compiled_failure'
        )
          this.applyHealth(telemetry.capabilityId, { kind: 'failure' });
        else if (
          telemetry.runtimeStatus === 'compiled' &&
          telemetry.measurement.outcome === 'success'
        )
          this.applyHealth(telemetry.capabilityId, {
            kind: 'success',
            durationMs: telemetry.measurement.durationMs,
          });
      }
    });
    // Customer reports are useful for health, but cannot attest validation/shadow promotion.
    return { accepted: true, traceId: telemetry.traceId };
  }

  shadowStatus(id: string) {
    return shadowReadiness(this.get(id), this.store.all('shadowRun'));
  }

  async shadow(id: string, input: unknown) {
    const artifact = assertDigest(this.get(id));
    const result = await shadowExecute({ kind: artifact.taskKind, input }, artifact, {
      adapters: this.adapters(),
      context: this.context(),
      agent: this.runtime.agent,
    });
    this.store.transaction(() => {
      this.store.put('shadowRun', result.shadow);
      if (result.shadow.status === 'mismatch') this.applyHealth(id, { kind: 'mismatch' });
      if (result.shadow.status === 'compiled_failure') this.applyHealth(id, { kind: 'failure' });
      this.store.put('dispatchRun', { ...result.authoritative, id: result.authoritative.runId });
      this.audit(
        'shadow.observed',
        id,
        `Native authoritative; comparison ${result.shadow.status}.`,
      );
    });
    return result;
  }

  // A handoff is closed by recording what actually resolved it. The recovery note becomes
  // exception evidence; it does not promote anything and does not widen any guard.
  recover(runId: string, resolution: { by: 'agent' | 'operator'; note: string; traceId?: string }) {
    const run = this.store.get('dispatchRun', runId);
    if (!run) throw new DomainError('Dispatch run not found.', 404);
    if (!run.checkpoint) throw new DomainError('That run did not emit a checkpoint.', 409);
    if (run.checkpoint.resolution) throw new DomainError('Checkpoint already resolved.', 409);
    if (resolution.traceId && !this.store.get('toolTrace', resolution.traceId))
      throw new DomainError('Recovery trace not found.', 404);
    const checkpoint: ExecutionCheckpoint = {
      ...run.checkpoint,
      resolution: { at: new Date().toISOString(), ...resolution },
    };
    const next: StoredDispatchRun = { ...run, checkpoint };
    this.store.transaction(() => {
      this.store.put('checkpoint', checkpoint);
      this.store.put('dispatchRun', next);
      this.audit(
        'checkpoint.resolved',
        checkpoint.id,
        `${resolution.by}: ${resolution.note}. Recorded as exception evidence; no capability was promoted.`,
      );
    });
    return next;
  }

  profile(name: string): JitProfile {
    const artifact =
      this.artifacts().find((entry) => entry.id === this.store.deployments()[`jit/${name}`]) ??
      this.artifacts().find((entry) => entry.name === name);
    const runs = this.runs().filter(
      (run) => run.capability === name || run.taskKind === (artifact?.taskKind ?? name),
    );
    const durations = runs
      .filter((run) => run.mode === 'compiled')
      .map((run) => run.durationMs)
      .sort((a, b) => a - b);
    const traces = this.traces();

    const supporting = traces.filter((trace) =>
      artifact ? artifact.ir.provenance.traceIds.includes(trace.traceId) : false,
    );
    const average = (values: number[]) =>
      values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
    return {
      name,
      taskKind: artifact?.taskKind ?? name,
      runs: runs.length,
      compiled: runs.filter((run) => run.mode === 'compiled').length,
      agent: runs.filter((run) => run.mode === 'agent').length,
      compiledLlmInvocations: runs
        .filter((run) => run.mode === 'compiled')
        .reduce((sum, run) => sum + run.llmInvocations, 0),
      agentLlmInvocations: runs
        .filter((run) => run.mode === 'agent')
        .reduce((sum, run) => sum + run.llmInvocations, 0),
      agentTokens: runs.reduce((sum, run) => sum + run.agentTokens, 0),
      adapterCalls: runs.reduce((sum, run) => sum + run.adapterCalls, 0),
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      fallbacks: runs.reduce<Record<string, number>>((counts, run) => {
        if (run.fallbackReason) counts[run.fallbackReason] = (counts[run.fallbackReason] ?? 0) + 1;
        return counts;
      }, {}),
      recordedTraceBaseline: {
        traces: supporting.length,
        avgLlmInvocations: average(supporting.map((trace) => trace.llmInvocations)),
        avgTokens: average(supporting.map((trace) => trace.agentTokens)),
        avgDurationMs: average(supporting.map((trace) => trace.durationMs)),
        note: 'Recorded from the source trajectories, including their exploration. Not a controlled benchmark against an equivalent second attempt.',
      },
    };
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return Math.round(sorted[index] * 100) / 100;
}
