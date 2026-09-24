import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import {
  codingPolicySchema,
  defaultCodingPolicy,
  DomainError,
  type CodingCapability,
  type CodingAgentSession,
  type CodingAgentDeployment,
} from '../domain.js';
import { runCodexTask } from '../agent/codex.js';
import { assertionChecks, codingDigest, verifyCoding } from '../verification/coding.js';
import { Store } from './store.js';

export class CodingRegistry {
  private readonly running = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly audit: (action: string, target: string, detail: string) => void,
    private readonly runner: typeof runCodexTask,
  ) {}

  async explore<T>(task: () => Promise<T>): Promise<T> {
    const workspace = realpathSync(process.cwd());
    if (this.running.has(workspace))
      throw new DomainError('A coding task is already running in this workspace.', 409);
    this.running.add(workspace);
    try {
      return await task();
    } finally {
      this.running.delete(workspace);
    }
  }
  get isRunning() {
    return this.running.size > 0;
  }

  get(id: string): CodingCapability {
    const cap = this.store.get('codingCapability', id);
    if (!cap) throw new DomainError('Coding capability not found.', 404);
    return cap;
  }

  prepare(
    session: CodingAgentSession,
    prompt: string,
    rawPolicy: unknown = defaultCodingPolicy,
    newVersion = false,
  ) {
    if (session.status !== 'success')
      throw new DomainError('Only successful sessions can be registered.', 409);
    if (!newVersion && session.registryCapabilityId) return this.get(session.registryCapabilityId);
    const policy = codingPolicySchema.parse(rawPolicy);
    const name = `coding_task_${session.id.replaceAll('-', '_')}`;
    const versions = this.store.all('codingCapability').filter((cap) => cap.name === name);
    const cap: CodingCapability = {
      id: randomUUID(),
      name,
      version: Math.max(0, ...versions.map((v) => v.version)) + 1,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
      status: 'draft',
      executionMode: 'codex-replay',
      simulated: process.env.FOUNDRY_CODEX_DRY_RUN === 'true',
      task: session.task,
      prompt,
      provider: session.provider,
      workspace: realpathSync(process.cwd()),
      sourceEvents: session.events.filter(
        (event) =>
          session.branchAnalysis.keptEventIds.includes(event.id) && event.status === 'success',
      ),
      policy,
      digest: '',
      checks: [],
      sideEffects:
        policy.sandbox === 'workspace-write'
          ? ['May modify files in the workspace.']
          : ['Read-only shell execution.'],
      rollback:
        'Revoke this version to stop future executions. Restore file changes manually from your own backup or version control; no automatic file rollback.',
    };
    cap.digest = codingDigest(cap);
    this.store.transaction(() => {
      this.store.put('codingCapability', cap);
      this.store.put('agentSession', { ...session, registryCapabilityId: cap.id });
      this.audit('coding.registered', cap.id, `${name} v${cap.version}; verification required.`);
    });
    return cap;
  }

  configure(id: string, policy: unknown) {
    const cap = this.get(id);
    const session = this.store.get('agentSession', cap.sessionId);
    if (!session) throw new DomainError('Source session not found.', 409);
    // Every edit is a new immutable execution artifact; old approvals cannot carry over.
    return this.prepare(session, cap.prompt, policy, true);
  }

  verify(id: string) {
    const cap = this.get(id);
    if (this.running.has(cap.workspace))
      throw new DomainError('Wait for execution to finish before verification.', 409);
    if (cap.status === 'revoked')
      throw new DomainError('Create a new version of a revoked task.', 409);
    const session = this.store.get('agentSession', cap.sessionId);
    cap.checks = verifyCoding(cap, session?.lastOutput ?? '');
    cap.verifiedAt = new Date().toISOString();
    const passed = cap.checks.length > 0 && cap.checks.every((check) => check.passed);
    cap.verifiedDigest = passed ? cap.digest : undefined;
    if (!passed || cap.status !== 'approved') cap.status = passed ? 'verified' : 'draft';
    if (!passed) {
      cap.approvedDigest = undefined;
      cap.approvedAt = undefined;
    }
    this.store.transaction(() => {
      this.store.put('codingCapability', cap);
      if (!passed) this.store.undeploy(cap.name, cap.id);
      this.audit(
        'coding.verified',
        cap.id,
        `${cap.checks.filter((c) => c.passed).length}/${cap.checks.length} checks passed.`,
      );
    });
    return cap;
  }

  private assertVerified(cap: CodingCapability) {
    if (
      codingDigest(cap) !== cap.digest ||
      cap.verifiedDigest !== cap.digest ||
      !cap.checks.length ||
      !cap.checks.every((check) => check.passed) ||
      !cap.verifiedAt ||
      Date.now() - Date.parse(cap.verifiedAt) > 3600000 ||
      !Number.isFinite(Date.parse(cap.verifiedAt))
    )
      throw new DomainError(
        'Current passing verification is required (expires after one hour).',
        409,
      );
    if (
      cap.workspace !== realpathSync(process.cwd()) ||
      cap.simulated !== (process.env.FOUNDRY_CODEX_DRY_RUN === 'true')
    )
      throw new DomainError(
        'Workspace or execution mode changed; create and verify a new version.',
        409,
      );
    const checks = verifyCoding(
      cap,
      this.store.get('agentSession', cap.sessionId)?.lastOutput ?? '',
    );
    if (!checks.every((c) => c.passed))
      throw new DomainError('Preflight assertions failed; reverify the task.', 409);
  }

  approve(id: string, note: string) {
    const cap = this.get(id);
    if (cap.status !== 'verified') throw new DomainError('Verify this task before approval.', 409);
    this.assertVerified(cap);
    cap.reviewNote = z.string().trim().min(5).max(500).parse(note);
    cap.status = 'approved';
    cap.approvedDigest = cap.digest;
    cap.approvedAt = new Date().toISOString();
    this.store.transaction(() => {
      this.store.put('codingCapability', cap);
      this.audit('coding.approved', cap.id, cap.reviewNote!);
    });
    return cap;
  }

  revoke(id: string) {
    const cap = this.get(id);
    if (this.running.has(cap.workspace))
      throw new DomainError('Wait for the running task to finish before revoking.', 409);
    cap.status = 'revoked';
    cap.approvedDigest = undefined;
    this.store.transaction(() => {
      this.store.undeploy(cap.name, cap.id);
      this.store.put('codingCapability', cap);
      this.audit(
        'coding.revoked',
        cap.id,
        'Future execution disabled. Existing file changes are unchanged.',
      );
    });
    return cap;
  }

  async deploy(id: string): Promise<CodingAgentDeployment> {
    const cap = this.get(id);
    if (cap.status !== 'approved' || cap.approvedDigest !== cap.digest)
      throw new DomainError(
        'Task must be verified and approved in the registry before deployment.',
        409,
      );
    this.assertVerified(cap);
    if (this.running.has(cap.workspace))
      throw new DomainError('A coding task is already running in this workspace.', 409);
    this.running.add(cap.workspace);
    try {
      const result = await this.runner(cap.prompt, {
        provider: cap.provider,
        cwd: cap.workspace,
        deployment: true,
        policy: cap.policy,
        timeoutMs: cap.policy.timeoutMs,
      });
      const checks = assertionChecks(cap.policy, cap.workspace, result.output);
      const passed = checks.every((check) => check.passed);
      const session = this.store.get('agentSession', cap.sessionId);
      if (!session) throw new DomainError('Source session was removed during execution.', 409);
      const before = session.usageBefore.totalTokens;
      const after = result.usage.totalTokens;
      const deployment: CodingAgentDeployment = {
        id: randomUUID(),
        capabilityId: cap.id,
        sessionId: cap.sessionId,
        createdAt: new Date().toISOString(),
        status: result.status === 'success' && passed ? 'success' : 'failed',
        output: result.output,
        error:
          result.error ??
          (!passed
            ? 'Post-execution assertions failed. Review any partial file changes.'
            : undefined),
        checks,
        simulated: cap.simulated,
        usage: result.usage,
        tokenDelta: before - after,
        tokenReductionPercent: before > 0 ? Math.round(((before - after) / before) * 1000) / 10 : 0,
      };
      cap.lastDeploymentId = deployment.id;
      if (deployment.status === 'failed') {
        cap.status = 'draft';
        cap.approvedDigest = undefined;
        cap.verifiedDigest = undefined;
      }
      this.store.transaction(() => {
        this.store.put('agentDeployment', deployment);
        this.store.put('codingCapability', cap);
        this.store.put('agentSession', {
          ...session,
          deploymentId: deployment.id,
          updatedAt: deployment.createdAt,
        });
        if (deployment.status === 'success') this.store.deploy(cap.name, cap.id);
        else this.store.undeploy(cap.name, cap.id);
        this.audit(
          `coding.deployment.${deployment.status}`,
          cap.id,
          `Before ${before}; after ${after} tokens. ${cap.simulated ? 'Simulated run.' : 'Codex replay.'}`,
        );
      });
      return deployment;
    } finally {
      this.running.delete(cap.workspace);
    }
  }
}
