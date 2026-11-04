import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain.js';
import {
  digest,
  json,
  replayJson,
  stable,
  ContractRegistry,
  type AccessContext,
  type Json,
} from '../compiler/contracts.js';
import { compileTask, taskTraceSchema, type TaskTrace } from '../compiler/task-ir.js';
import { runTaskPlan, taskArtifactSchema, type TaskArtifact } from '../runtime/task-runtime.js';
import { currentIdentity, requirePermission } from '../security/identity.js';
import type { Store } from './store.js';

export type TaskVerificationCase = { input: Json; expected: Json };
export type GenericTaskOptions = {
  registry: ContractRegistry;
  context: (kind?: string) => AccessContext;
  // Trusted code supplies sandbox cases, never the HTTP caller or model.
  verificationCases: (kind: string) => TaskVerificationCase[];
  native?: (kind: string, input: Json, context: AccessContext) => Promise<Json>;
  requiredShadowInputs?: number;
};
export type TaskShadow = {
  id: string;
  tenantId: string;
  principalId: string;
  artifactId: string;
  digest: string;
  verificationId?: string;
  inputDigest: string;
  contextDigest: string;
  status: 'match' | 'mismatch' | 'failed';
};

export class TaskRegistry {
  constructor(
    private readonly store: Store,
    private readonly options: GenericTaskOptions,
  ) {}
  private context(kind?: string): AccessContext {
    const identity = currentIdentity();
    const supplied = this.options.context(kind);
    if (supplied.tenantId !== identity.tenantId || supplied.principalId !== identity.principalId)
      throw new DomainError('Application identity mismatch.', 403);
    return {
      ...supplied,
      scopes: supplied.scopes.filter((scope) => identity.toolScopes.includes(scope)),
    };
  }
  private audit(action: string, subjectId: string) {
    this.store.put('audit', {
      id: randomUUID(),
      at: new Date().toISOString(),
      action,
      target: subjectId,
      actor: currentIdentity().principalId,
      detail: 'Generic capability lifecycle event.',
    });
  }
  traces(): TaskTrace[] {
    requirePermission('read');
    return this.store
      .all('taskTrace')
      .filter((trace) => trace.principalId === currentIdentity().principalId);
  }
  ingest(raw: unknown): { id: string } {
    requirePermission('observe');
    const trace = taskTraceSchema.parse(replayJson(raw));
    const context = this.context(trace.kind);
    if (
      trace.tenantId !== context.tenantId ||
      trace.principalId !== context.principalId ||
      trace.policyVersion !== context.policyVersion ||
      trace.snapshot !== context.snapshot
    )
      throw new DomainError('Trace access context mismatch.', 403);
    this.options.registry.authorizeTask(trace.kind, trace.input, context);
    for (const event of trace.events) {
      const tool = this.options.registry.tool(event.tool);
      tool.input.parse(event.argsValue);
      tool.output.parse(event.result);
      if (
        !this.options.registry.toolManifest(event.tool).replaySafe ||
        !this.options.registry.task(trace.kind).tools.includes(event.tool) ||
        tool.scopes.some((scope) => !context.scopes.includes(scope)) ||
        !tool.authorize(context, event.argsValue) ||
        !tool.validateResult(context, event.argsValue, event.result)
      )
        throw new DomainError('Trace tool access denied.', 403);
    }
    if (this.store.get('taskTrace', trace.id)) throw new DomainError('Trace already exists.', 409);
    this.store.put('taskTrace', trace);
    this.audit('task.trace.ingested', trace.id);
    return { id: trace.id };
  }
  artifacts(): TaskArtifact[] {
    requirePermission('read');
    return this.store
      .all('taskArtifact')
      .filter((artifact) => artifact.plan.principalId === currentIdentity().principalId);
  }
  get(id: string): TaskArtifact {
    const artifact = this.store.get('taskArtifact', id);
    if (!artifact || artifact.plan.principalId !== currentIdentity().principalId)
      throw new DomainError('Task capability not found.', 404);
    return taskArtifactSchema.parse(artifact);
  }
  compile(name: string, traceIds: string[]): TaskArtifact {
    requirePermission('compile');
    const traces = traceIds.map((id) => {
      const trace = this.store.get('taskTrace', id);
      if (!trace || trace.principalId !== currentIdentity().principalId)
        throw new DomainError('Task trace not found.', 404);
      return trace;
    });
    const plan = compileTask(traces, name, this.options.registry);
    const artifact: TaskArtifact = {
      id: randomUUID(),
      tenantId: this.context(plan.kind).tenantId,
      plan,
      digest: digest(plan),
      status: 'draft',
      checks: [],
    };
    this.store.put('taskArtifact', artifact);
    this.audit('task.compiled', artifact.id);
    return artifact;
  }
  async verify(id: string): Promise<TaskArtifact> {
    requirePermission('verify');
    const artifact = this.get(id);
    if (artifact.status === 'revoked')
      throw new DomainError('Revoked artifact cannot be verified.', 409);
    const context = this.context(artifact.plan.kind);
    const cases = this.options.verificationCases(artifact.plan.kind);
    if (cases.length > 32) throw new DomainError('Verification case budget exceeded.', 409);
    const checks: TaskArtifact['checks'] = [];
    checks.push({
      name: 'independent_sandbox_coverage',
      passed: cases.length >= 2 && new Set(cases.map((test) => stable(test.input))).size >= 2,
    });
    for (const [index, test] of cases.entries()) {
      const run = await runTaskPlan(
        artifact,
        artifact.plan.kind,
        test.input,
        context,
        this.options.registry,
        { allowDraft: true },
      );
      checks.push({
        name: `sandbox_${index}`,
        passed:
          run.outcome === 'success' &&
          stable(run.result) === stable(test.expected) &&
          run.llmInvocations === 0,
      });
    }
    for (const traceId of artifact.plan.evidence) {
      const trace = this.store.get('taskTrace', traceId);
      const run =
        trace &&
        (await runTaskPlan(
          artifact,
          artifact.plan.kind,
          trace.input,
          context,
          this.options.registry,
          { allowDraft: true },
        ));
      checks.push({
        name: `differential_${traceId}`,
        passed:
          !!trace && run?.outcome === 'success' && stable(run.result) === stable(trace.result),
      });
    }
    if (cases.length) {
      for (const [name, changed, badArtifact] of [
        ['tenant_denied', { ...context, tenantId: `${context.tenantId}-other` }, artifact],
        ['principal_denied', { ...context, principalId: `${context.principalId}-other` }, artifact],
        [
          'policy_denied',
          { ...context, policyVersion: `${context.policyVersion}-other` },
          artifact,
        ],
        ['stale_deoptimization', { ...context, observedAt: 0 }, artifact],
        [
          'snapshot_deoptimization',
          { ...context, snapshot: `${context.snapshot}-other` },
          artifact,
        ],
        ['tamper_deoptimization', context, { ...artifact, digest: '0'.repeat(64) }],
      ] as const) {
        const run = await runTaskPlan(
          badArtifact,
          artifact.plan.kind,
          cases[0].input,
          changed,
          this.options.registry,
          { allowDraft: true },
        );
        checks.push({ name, passed: run.outcome !== 'success' && run.toolCalls === 0 });
      }
      for (const scope of new Set(
        artifact.plan.nodes.flatMap((node) => this.options.registry.tool(node.tool).scopes),
      )) {
        const run = await runTaskPlan(
          artifact,
          artifact.plan.kind,
          cases[0].input,
          { ...context, scopes: context.scopes.filter((entry) => entry !== scope) },
          this.options.registry,
          { allowDraft: true },
        );
        checks.push({
          name: `scope_denied:${scope}`,
          passed: run.outcome === 'denied' && run.toolCalls === 0,
        });
      }
      for (const fault of ['unavailable', 'malformed', 'timeout'] as const) {
        const sandbox = new ContractRegistry();
        const task = this.options.registry.task(artifact.plan.kind);
        for (const name of task.tools) {
          sandbox.registerTool({
            ...this.options.registry.tool(name),
            run: async () => {
              if (fault === 'malformed') return undefined;
              if (fault === 'timeout') return new Promise(() => {});
              throw new DomainError('Sandbox unavailable.', 503);
            },
          });
        }
        sandbox.registerTask(task);
        const run = await runTaskPlan(
          artifact,
          artifact.plan.kind,
          cases[0].input,
          context,
          sandbox,
          { allowDraft: true, ...(fault === 'timeout' ? { signal: AbortSignal.timeout(5) } : {}) },
        );
        checks.push({
          name: `failure_${fault}`,
          passed:
            run.outcome === 'unresolved' &&
            run.result === undefined &&
            !!run.checkpoint &&
            run.checkpoint.completedEffects.length === 0,
        });
      }
    }
    const latest = this.get(id);
    if (latest.digest !== artifact.digest || latest.status === 'revoked')
      throw new DomainError('Artifact changed during verification.', 409);
    const result: TaskArtifact = {
      ...latest,
      status: checks.every((check) => check.passed) ? 'verified' : 'draft',
      checks,
      verifiedDigest: checks.every((check) => check.passed) ? artifact.digest : undefined,
      approvedDigest: undefined,
      verificationId: randomUUID(),
    };
    this.store.undeploy(this.deploymentKey(result.plan.name), result.id);
    this.store.put('taskArtifact', result);
    this.audit('task.verified', id);
    return result;
  }
  approve(id: string): TaskArtifact {
    requirePermission('approve');
    const artifact = this.get(id);
    if (
      artifact.status !== 'verified' ||
      artifact.verifiedDigest !== artifact.digest ||
      digest(artifact.plan) !== artifact.digest ||
      !artifact.checks.length ||
      artifact.checks.some((check) => !check.passed)
    )
      throw new DomainError('Passing verification on this digest required.', 409);
    const approved: TaskArtifact = {
      ...artifact,
      status: 'approved',
      approvedDigest: artifact.digest,
    };
    this.store.put('taskArtifact', approved);
    this.audit('task.approved', id);
    return approved;
  }
  private deploymentKey(name: string) {
    return `task:${currentIdentity().principalId}:${name}`;
  }
  async shadow(id: string, rawInput: unknown): Promise<TaskShadow> {
    requirePermission('invoke');
    const artifact = this.get(id);
    if (
      !artifact.verifiedDigest ||
      artifact.verifiedDigest !== artifact.digest ||
      !artifact.verificationId ||
      !this.options.native
    )
      throw new DomainError('Verified candidate and trusted native callback required.', 409);
    const context = this.context(artifact.plan.kind);
    const input = this.options.registry.authorizeTask(artifact.plan.kind, rawInput, context);
    let status: TaskShadow['status'] = 'failed';
    try {
      const native = json(
        this.options.registry
          .task(artifact.plan.kind)
          .output.parse(await this.options.native(artifact.plan.kind, input, context)),
      );
      const run = await runTaskPlan(
        artifact,
        artifact.plan.kind,
        input,
        context,
        this.options.registry,
        { allowDraft: true },
      );
      status =
        run.outcome === 'success'
          ? stable(native) === stable(run.result)
            ? 'match'
            : 'mismatch'
          : 'failed';
    } catch {
      /* A failed native run cannot count as equivalence evidence. */
    }
    const shadow: TaskShadow = {
      id: randomUUID(),
      tenantId: context.tenantId,
      principalId: context.principalId,
      artifactId: id,
      digest: artifact.digest,
      verificationId: artifact.verificationId,
      inputDigest: digest(input),
      contextDigest: digest({ ...context, observedAt: 0 }),
      status,
    };
    this.store.put('taskShadow', shadow);
    this.audit(`task.shadow.${status}`, id);
    return shadow;
  }
  deploy(id: string): TaskArtifact {
    requirePermission('deploy');
    const artifact = this.get(id);
    if (
      artifact.status !== 'approved' ||
      artifact.approvedDigest !== artifact.digest ||
      artifact.verifiedDigest !== artifact.digest ||
      digest(artifact.plan) !== artifact.digest
    )
      throw new DomainError('Approved exact digest required.', 409);
    const required = z
      .number()
      .int()
      .min(2)
      .max(32)
      .parse(this.options.requiredShadowInputs ?? 3);
    const contextDigest = digest({ ...this.context(artifact.plan.kind), observedAt: 0 });
    const shadows = this.store
      .all('taskShadow')
      .filter(
        (run) =>
          run.artifactId === id &&
          run.digest === artifact.digest &&
          run.verificationId === artifact.verificationId &&
          run.contextDigest === contextDigest,
      );
    if (
      shadows.some((run) => run.status !== 'match') ||
      new Set(shadows.map((run) => run.inputDigest)).size < required
    )
      throw new DomainError('Passing trusted shadow coverage required before deployment.', 409);
    this.store.deploy(this.deploymentKey(artifact.plan.name), id);
    this.audit('task.deployed', id);
    return artifact;
  }
  revoke(id: string): TaskArtifact {
    requirePermission('deploy');
    const artifact = this.get(id);
    const revoked: TaskArtifact = { ...artifact, status: 'revoked', approvedDigest: undefined };
    this.store.put('taskArtifact', revoked);
    this.store.undeploy(this.deploymentKey(artifact.plan.name), id);
    this.audit('task.revoked', id);
    return revoked;
  }
  active(name: string): TaskArtifact | undefined {
    requirePermission('invoke');
    const id = this.store.deployments()[this.deploymentKey(name)];
    if (!id) return undefined;
    const artifact = this.get(id);
    const context = this.context(artifact.plan.kind);
    if (
      artifact.plan.nodes.some((node) =>
        this.options.registry
          .tool(node.tool)
          .scopes.some((scope) => !context.scopes.includes(scope)),
      )
    )
      throw new DomainError('Capability tool access denied.', 403);
    return artifact;
  }
  async execute(name: string, kind: string, input: unknown) {
    requirePermission('invoke');
    const artifact = this.active(name);
    if (!artifact) throw new DomainError('Active task capability not found.', 404);
    const run = await runTaskPlan(artifact, kind, input, this.context(kind), this.options.registry);
    this.audit(`task.run.${run.outcome}`, artifact.id);
    return run;
  }
  workspace() {
    requirePermission('read');
    const artifacts = this.artifacts();
    const deployments = this.store.deployments();
    const fixtureIds = this.store.setting<string[]>('task-ui-fixture-ids', []);
    const shadows = this.store.all('taskShadow');
    return {
      ...this.options.registry.catalog(),
      identity: {
        tenantId: currentIdentity().tenantId,
        principalId: currentIdentity().principalId,
        permissions: currentIdentity().permissions,
      },
      traces: this.traces().map((trace) => ({
        id: trace.id,
        kind: trace.kind,
        input: trace.input,
        eventCount: trace.events.length,
        source: fixtureIds.includes(trace.id) ? ('fixture' as const) : ('import' as const),
      })),
      artifacts,
      active: Object.fromEntries(
        artifacts
          .filter((artifact) => deployments[this.deploymentKey(artifact.plan.name)] === artifact.id)
          .map((artifact) => [artifact.plan.name, artifact.id]),
      ),
      shadowCoverage: Object.fromEntries(
        artifacts.map((artifact) => {
          const contextDigest = digest({ ...this.context(artifact.plan.kind), observedAt: 0 });
          const rows = shadows.filter(
            (run) =>
              run.artifactId === artifact.id &&
              run.digest === artifact.digest &&
              run.verificationId === artifact.verificationId &&
              run.contextDigest === contextDigest,
          );
          const matchedInputs = new Set(
            rows.filter((row) => row.status === 'match').map((row) => row.inputDigest),
          ).size;
          const failed = rows.filter((row) => row.status !== 'match').length;
          const required = this.options.requiredShadowInputs ?? 3;
          return [
            artifact.id,
            { matchedInputs, failed, required, ready: matchedInputs >= required && failed === 0 },
          ];
        }),
      ),
    };
  }
}
