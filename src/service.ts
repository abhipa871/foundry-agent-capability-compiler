import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  type AgentProviderOption,
  type BranchAnalysis,
  type CodingAgentDeployment,
  type CodingAgentEvent,
  type CodingAgentSession,
  DomainError,
  defaultPolicy,
  inputSchema,
  policySchema,
  type Capability,
  type Run,
  type State,
} from './domain.js';
import {
  agentProviders,
  estimateUsage,
  providerById,
  runCodexTask,
  type CodexRun,
} from './agent/codex.js';
import { capture, captureRaw, sampleTrajectory } from './exploration/capture.js';
import { compile } from './compiler/compile.js';
import { Store } from './registry/store.js';
import { executePlan, type Fault } from './runtime/execute.js';
import { verify } from './verification/verify.js';
import { buildGraph } from './graph/graph.js';
import { metrics } from './telemetry/metrics.js';
import { CodingRegistry } from './registry/coding.js';
import { currentIdentity } from './security/identity.js';
import { JitRegistry } from './registry/jit.js';

export class Foundry {
  readonly coding: CodingRegistry;
  readonly jit: JitRegistry;
  constructor(
    readonly store: Store,
    runtime: ConstructorParameters<typeof JitRegistry>[2] = {},
  ) {
    this.jit = new JitRegistry(
      store,
      (action, target, detail) => this.audit(action, target, detail),
      runtime,
    );
    this.coding = new CodingRegistry(
      store,
      (action, target, detail) => this.audit(action, target, detail),
      safeCodexTask,
    );
    // Preserve legacy deployment history, but never infer approval from a successful CLI exit.
    for (const session of store.all('agentSession')) {
      const deployments = store.all('agentDeployment').filter((d) => d.sessionId === session.id);
      if (session.status !== 'success' || session.registryCapabilityId || !deployments.length)
        continue;
      const cap = this.prepareCodingSession(session.id);
      this.store.transaction(() => {
        for (const deployment of deployments)
          this.store.put('agentDeployment', { ...deployment, capabilityId: cap.id });
        this.audit(
          'coding.legacy.imported',
          cap.id,
          'Historical deployment registered as draft; security verification required.',
        );
      });
    }
  }
  audit(action: string, target: string, detail: string) {
    this.store.put('audit', {
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: currentIdentity().principalId,
      action,
      target,
      detail,
    });
  }
  seed() {
    this.jit.seed();
    if (this.store.all('trajectory').length) return;
    const trace = this.capture(sampleTrajectory, 'demo');
    const cap = this.compile(trace.id, defaultPolicy);
    this.verify(cap.id);
  }
  capture(value: unknown, source: 'demo' | 'import') {
    const trace = capture(value, source);
    this.store.transaction(() => {
      this.store.put('trajectory', trace);
      this.audit('trajectory.captured', trace.id, `${source}: ${trace.name}`);
    });
    return trace;
  }
  captureAny(value: unknown, source: 'demo' | 'import') {
    return value &&
      typeof value === 'object' &&
      Array.isArray((value as { events?: unknown }).events)
      ? this.captureRaw(value, source)
      : this.capture(value, source);
  }
  captureRaw(value: unknown, source: 'demo' | 'import') {
    const trace = captureRaw(value, source);
    const discarded = trace.branchAnalysis?.discarded.length ?? 0;
    this.store.transaction(() => {
      this.store.put('trajectory', trace);
      this.audit(
        'trajectory.pruned',
        trace.id,
        `${source}: kept ${trace.steps.length} deterministic steps and discarded ${discarded} raw branch event${discarded === 1 ? '' : 's'}`,
      );
    });
    return trace;
  }
  async runCodingAgent(task: string, providerId?: string): Promise<CodingAgentSession> {
    if (providerId && !agentProviders.some((provider) => provider.id === providerId))
      throw new DomainError('Unknown agent provider.', 400);
    const provider = providerById(providerId);
    if (!provider.enabled)
      throw new DomainError('Selected agent provider is not enabled yet.', 409);
    const result = await this.coding.explore(() =>
      safeCodexTask(task, { provider, cwd: process.cwd() }),
    );
    const now = new Date().toISOString();
    const events = repairCodingEventLineage(result.events);
    const session: CodingAgentSession = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      task,
      status: result.status,
      provider,
      messages: [
        { id: randomUUID(), role: 'user', content: task, at: now },
        {
          id: randomUUID(),
          role: 'assistant',
          content: result.output || result.error || 'No response returned.',
          at: new Date().toISOString(),
        },
      ],
      events,
      finalEventId: result.finalEventId,
      branchAnalysis: analyzeCodingEvents(
        events,
        result.status === 'success' ? result.finalEventId : undefined,
        result.status === 'success',
      ),
      usageBefore: result.usage,
      lastOutput: result.output,
      error: result.error,
    };
    this.store.transaction(() => {
      this.store.put('agentSession', session);
      this.audit(
        `agent.${session.status}`,
        session.id,
        `${provider.label}: ${session.usageBefore.totalTokens} token${session.usageBefore.totalTokens === 1 ? '' : 's'} before deployment`,
      );
    });
    return session;
  }
  prepareCodingSession(id: string) {
    const session = this.store.get('agentSession', id);
    if (!session) throw new DomainError('Coding-agent session not found.', 404);
    const normalized = normalizeAgentSession(session);
    return this.coding.prepare(normalized, deploymentTaskFromSession(normalized));
  }
  async deployCodingAgentSession(id: string): Promise<CodingAgentDeployment> {
    return this.coding.deploy(this.prepareCodingSession(id).id);
  }
  clearCodingAgentHistory() {
    if (this.coding.isRunning)
      throw new DomainError('Wait for coding execution to finish before clearing history.', 409);
    if (this.store.all('codingCapability').length)
      throw new DomainError(
        'Registered tasks retain source sessions and deployment evidence; history cannot be cleared.',
        409,
      );
    this.store.transaction(() => {
      this.store.deleteKind('agentDeployment');
      this.store.deleteKind('agentSession');
      this.audit(
        'agent.history.cleared',
        'coding-agent',
        'Cleared local coding-agent chat history.',
      );
    });
    return { cleared: true };
  }
  capability(id: string): Capability {
    const cap = this.store.get('capability', id);
    if (!cap) throw new DomainError('Capability not found.', 404);
    return cap;
  }
  compile(trajectoryId: string, policy: unknown) {
    const trace = this.store.get('trajectory', trajectoryId);
    if (!trace) throw new DomainError('Trajectory not found.', 404);
    const version =
      Math.max(
        0,
        ...this.store
          .all('capability')
          .filter((c) => c.name === trace.name)
          .map((c) => c.version),
      ) + 1;
    const cap = compile(trace, policySchema.parse(policy), version, this.store.contractVersion);
    this.store.transaction(() => {
      this.store.put('capability', cap);
      this.audit('capability.compiled', cap.id, `${cap.name} v${version}`);
    });
    return cap;
  }
  verify(id: string) {
    const cap = this.capability(id);
    cap.checks = verify(cap, this.store.contractVersion);
    cap.verifiedAt = new Date().toISOString();
    const passed = cap.checks.every((c) => c.passed);
    if (cap.status !== 'approved') cap.status = passed ? 'verified' : 'draft';
    this.store.transaction(() => {
      this.store.put('capability', cap);
      this.audit(
        'capability.verified',
        id,
        `${cap.checks.filter((c) => c.passed).length}/${cap.checks.length} passed`,
      );
    });
    return cap;
  }
  approve(id: string, note: string) {
    const cap = this.capability(id);
    if (
      cap.status !== 'verified' ||
      !cap.checks.length ||
      !cap.checks.every((c) => c.passed) ||
      cap.contractVersion !== this.store.contractVersion
    ) {
      throw new DomainError('Approval requires a current, passing verification suite.', 409);
    }
    cap.status = 'approved';
    cap.approvedAt = new Date().toISOString();
    cap.reviewNote = note;
    this.store.transaction(() => {
      this.store.put('capability', cap);
      this.store.deploy(cap.name, cap.id);
      this.audit('capability.approved', id, note);
    });
    return cap;
  }
  reject(id: string, note: string) {
    const cap = this.capability(id);
    if (cap.status === 'approved')
      throw new DomainError('Approved versions are immutable; compile a new candidate.', 409);
    cap.status = 'rejected';
    cap.reviewNote = note;
    this.store.transaction(() => {
      this.store.put('capability', cap);
      this.audit('capability.rejected', id, note);
    });
    return cap;
  }
  rollback(id: string) {
    const cap = this.capability(id);
    if (
      cap.status !== 'approved' ||
      cap.contractVersion !== this.store.contractVersion ||
      !cap.checks.every((c) => c.passed)
    )
      throw new DomainError('Only a compatible approved version can be deployed.', 409);
    this.store.transaction(() => {
      this.store.deploy(cap.name, id);
      this.audit(
        'deployment.changed',
        id,
        `Active version is now v${cap.version}. Existing transactions are unchanged.`,
      );
    });
    return cap;
  }
  run(id: string, rawInput: unknown, key: string, fault: Fault = 'none'): Run {
    const cap = this.capability(id);
    const input = inputSchema.parse(rawInput);
    const prior = this.store.all('run').find((r) => r.idempotencyKey === key);
    if (prior) {
      if (prior.capabilityId !== id || JSON.stringify(prior.input) !== JSON.stringify(input))
        throw new DomainError('Idempotency key was already used with different arguments.', 409);
      return prior;
    }
    const start = performance.now();
    const run: Run = {
      id: randomUUID(),
      capabilityId: id,
      name: cap.name,
      version: cap.version,
      input,
      idempotencyKey: key,
      createdAt: new Date().toISOString(),
      durationMs: 0,
      status: 'success',
      logs: ['Input schema validated'],
    };
    try {
      if (cap.status !== 'approved' || this.store.deployments()[cap.name] !== id)
        throw new DomainError('Only the active approved version can execute.', 403);
      if (!cap.checks.length || !cap.checks.every((c) => c.passed))
        throw new DomainError('Verification failed. Revalidate before execution.', 409);
      this.store.transaction(() => {
        const output = executePlan(cap, input, {
          contractVersion: this.store.contractVersion,
          existing: this.store.credited(),
          fault,
        });
        run.output = output;
        run.logs.push(
          'Approval and adapter contract checked',
          'Permissions and financial limits passed',
          `${output.attempts} adapter attempt(s)`,
          `${output.customers} credits, CRM updates, and notifications committed atomically`,
        );
        run.durationMs = performance.now() - start;
        this.store.put('run', run);
        this.store.writeEffects(run.id, output.effects);
        this.audit(
          'run.succeeded',
          run.id,
          `${output.customers} customers · $${output.totalCredit.toFixed(2)} demo credits`,
        );
      });
    } catch (error) {
      run.status = error instanceof DomainError && error.status < 500 ? 'blocked' : 'failed';
      run.error = error instanceof Error ? error.message : 'Execution failed';
      run.output = undefined;
      run.logs.push(run.error, 'No side effects committed');
      run.durationMs = performance.now() - start;
      this.store.transaction(() => {
        this.store.put('run', run);
        this.audit(`run.${run.status}`, run.id, run.error!);
      });
    }
    return run;
  }
  compensate(id: string) {
    const run = this.store.get('run', id);
    if (!run) throw new DomainError('Run not found.', 404);
    if (run.status !== 'success')
      throw new DomainError('Only a successful run can be compensated.', 409);
    this.store.transaction(() => {
      this.store.compensate(id);
      run.status = 'compensated';
      run.logs.push('Local demo credit, CRM, and outbox changes reversed.');
      this.store.put('run', run);
      this.audit('run.compensated', id, 'All local demo side effects reversed.');
    });
    return run;
  }
  drift() {
    this.store.transaction(() => {
      this.store.contractVersion += 1;
      this.audit(
        'adapter.changed',
        'shipping',
        `Adapter contract is now ${this.store.contractVersion}. Existing capabilities need recompilation.`,
      );
    });
    return this.store.contractVersion;
  }
  jitState() {
    const artifacts = this.jit.artifacts();
    const deployments = this.store.deployments();
    return {
      traces: this.jit.traces(),
      patterns: this.jit.patterns(),
      shadowRuns: this.store.all('shadowRun'),
      health: this.jit.artifacts().map((artifact) => this.jit.health(artifact.id)),
      routing: this.jit.routing(),
      artifacts,
      runs: this.jit.runs(),
      checkpoints: this.jit.checkpoints(),
      active: Object.fromEntries(
        [...new Set(artifacts.map((artifact) => artifact.name))].map((name) => [
          name,
          deployments[`jit/${name}`] ?? null,
        ]),
      ),
      profiles: [...new Set(artifacts.map((artifact) => artifact.name))].map((name) =>
        this.jit.profile(name),
      ),
    };
  }
  state(): State {
    const capabilities = this.store.all('capability'),
      runs = this.store.all('run'),
      deployments = this.store.deployments();
    return {
      capabilities,
      runs,
      agentSessions: this.store
        .all('agentSession')
        .map((session) => normalizeAgentSession(session)),
      agentDeployments: this.store.all('agentDeployment'),
      codingCapabilities: this.store.all('codingCapability'),
      agentProviders,
      trajectories: this.store.all('trajectory'),
      audit: this.store.all('audit'),
      deployments,
      contractVersion: this.store.contractVersion,
      metrics: metrics(runs),
      graph: buildGraph(capabilities, deployments, this.store.all('codingCapability')),
    };
  }
}

async function safeCodexTask(
  task: string,
  options: Parameters<typeof runCodexTask>[1],
): Promise<CodexRun> {
  try {
    return await runCodexTask(task, options);
  } catch (error) {
    return failedCodexRun(task, error, options.deployment);
  }
}

function failedCodexRun(task: string, error: unknown, deployment?: boolean): CodexRun {
  const message = error instanceof Error ? error.message : 'Codex adapter failed unexpectedly.';
  const startedAt = new Date().toISOString();
  const usage = estimateUsage(task, message);
  return {
    status: 'failed',
    output: '',
    error: message,
    events: [
      {
        id: `codex.adapter-${randomUUID().slice(0, 8)}`,
        operation: deployment ? 'codex.deploy' : 'codex.exec',
        status: 'failed',
        transport: 'cli',
        description: 'Codex adapter failed before a deterministic trajectory was produced.',
        error: message.slice(0, 250),
        startedAt,
        endedAt: new Date().toISOString(),
        usage,
      },
    ],
    usage,
    durationMs: 0,
  };
}

function normalizeAgentSession(session: CodingAgentSession): CodingAgentSession {
  const legacy = session as Partial<CodingAgentSession>;
  const provider = providerById(legacy.provider?.id);
  const events = repairCodingEventLineage(legacy.events ?? []);
  const branchAnalysis = analyzeCodingEvents(
    events,
    legacy.status === 'success' ? legacy.finalEventId : undefined,
    legacy.status === 'success',
  );
  const task = legacy.task ?? '';
  const lastOutput = legacy.lastOutput ?? legacy.error ?? '';
  return {
    ...session,
    task,
    provider,
    messages: legacy.messages ?? [],
    events,
    branchAnalysis,
    usageBefore: legacy.usageBefore ?? estimateUsage(task, lastOutput),
    lastOutput,
  };
}

function repairCodingEventLineage(events: CodingAgentEvent[]): CodingAgentEvent[] {
  const ids = new Set(events.map((event) => event.id));
  return events.map((event, index) => {
    if (index === 0) return { ...event, parentId: undefined };
    if (event.parentId && ids.has(event.parentId)) return event;
    return { ...event, parentId: events[index - 1].id };
  });
}

function analyzeCodingEvents(
  events: CodingAgentEvent[],
  finalEventId?: string,
  successful = true,
): BranchAnalysis {
  const byId = new Map(events.map((event) => [event.id, event]));
  const kept = new Set<string>();
  let cursor = successful
    ? finalEventId
      ? byId.get(finalEventId)
      : events.findLast((event) => event.status === 'success')
    : undefined;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.status === 'success') kept.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return {
    rawEventCount: events.length,
    keptEventIds: events.filter((event) => kept.has(event.id)).map((event) => event.id),
    discarded: events
      .filter((event) => !kept.has(event.id))
      .map((event) => ({
        eventId: event.id,
        operation: event.operation,
        status: event.status,
        reason:
          event.status === 'failed'
            ? 'failed_tool'
            : event.status === 'skipped'
              ? 'skipped_tool'
              : 'non_causal_success',
        description: event.description,
        error: event.error,
      })),
    strategy: finalEventId ? 'lineage' : 'ordered_success_scan',
  };
}

function deploymentTaskFromSession(session: CodingAgentSession) {
  const kept = new Set(session.branchAnalysis.keptEventIds);
  const successfulSteps = session.events
    .filter((event) => kept.has(event.id) && event.status === 'success')
    .map((event, index) => `${index + 1}. ${event.operation}: ${event.description}`)
    .join('\n');
  const discarded = session.branchAnalysis.discarded
    .map((event) => `- Avoid ${event.operation}: ${event.error ?? event.description}`)
    .join('\n');
  return [
    'Deploy the recorded coding task using the successful trajectory below.',
    'Treat the trajectory as the preferred implementation path. Avoid discarded failed branches unless the repository state proves the path is obsolete.',
    '',
    `Original task:\n${session.task}`,
    '',
    `Successful trajectory:\n${successfulSteps || 'No detailed successful steps were captured.'}`,
    '',
    `Discarded branches:\n${discarded || 'None recorded.'}`,
    '',
    'Complete or verify the actual task in the repository and summarize the final result.',
  ].join('\n');
}
