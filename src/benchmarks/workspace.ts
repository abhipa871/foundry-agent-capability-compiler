import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { compileIR } from '../compiler/compile-ir.js';
import { emitArtifact } from '../compiler/emit.js';
import { canonical, type IRArtifact, type ReadOperation } from '../compiler/ir.js';
import { DomainError } from '../domain.js';
import { TrajectoryObserver } from '../exploration/observe.js';
import { RequestReadCache } from '../integration/request-reads.js';
import {
  defineContextContract,
  selectExecution,
  type ExecutionSelection,
  type PrefetchCostComparison,
} from '../integration/selection.js';
import {
  authorizeReads,
  fixtureResult,
  localContext,
  mockAdapters,
  type AdapterRunner,
} from '../runtime/adapters/registry.js';
import { AgentExecutionError, dispatch } from '../runtime/dispatcher.js';
import { sameContext } from '../runtime/observable.js';
import { resourceKeys } from '../runtime/selective.js';
import { emptyMeasurement } from '../telemetry/measurement.js';
import { verifyIR } from '../verification/verify-ir.js';
// Reuse the evaluated provider bridge and independent oracle, rather than create a second agent.
import {
  CustomerContextAgent,
  apiEquivalentCost,
  executeTool,
  model,
  operations,
  provider,
  rateCard,
  tools,
} from '../../scripts/experiments/customer-agent.js';
import { compiledContextTool, supportOracle } from '../../scripts/experiments/support-task.js';
import {
  allReads,
  assessSelective,
  selectiveInstructions,
  selectivePrompt,
  selectiveResponseSchema,
  type SelectiveCase,
  type SelectiveResponse,
} from '../../scripts/experiments/selective-task.js';
import {
  benchmarkRequestSchema,
  type BenchmarkArm,
  type BenchmarkConfig,
  type BenchmarkEvidence,
  type BenchmarkPair,
  type BenchmarkRequest,
  type BenchmarkRun,
} from './contracts.js';

export const scenarios: BenchmarkConfig['scenarios'] = [
  {
    scope: 'agent_decides',
    label: 'Let the agent decide',
    prompt:
      'My delivery is late. Can you investigate my account, orders and refund history, explain the appropriate next step, and draft a helpful reply?',
  },
  {
    scope: 'complete',
    label: 'Full support review',
    prompt:
      'Review my eligibility, all orders and previous refunds. What should happen next with my delayed delivery?',
  },
  {
    scope: 'orders',
    label: 'Order status',
    prompt:
      'Which of my orders is the most delayed, and by how many days? I only need order information.',
  },
  {
    scope: 'eligibility',
    label: 'Account eligibility',
    prompt: 'Tell me only whether my account is eligible for delay support.',
  },
  {
    scope: 'refunds',
    label: 'Refund history',
    prompt:
      'List every refund already paid on my account, with amounts. I only need refund history.',
  },
  {
    scope: 'policy',
    label: 'General policy',
    prompt:
      'Explain the general delayed-delivery support policy without accessing customer records.',
  },
];
const scopeReads: Record<BenchmarkRequest['scope'], ReadOperation[]> = {
  agent_decides: allReads,
  complete: allReads,
  orders: ['orders.list'],
  eligibility: ['crm.getCustomer'],
  refunds: ['payments.refundHistory'],
  policy: [],
};
function expected(customerId: string, reads: ReadOperation[]): Omit<SelectiveResponse, 'reply'> {
  const full = supportOracle[customerId];
  return {
    customerId,
    eligible: reads.includes('crm.getCustomer') ? full.eligible : null,
    orders: reads.includes('orders.list') ? full.orders : null,
    refunds: reads.includes('payments.refundHistory') ? full.refunds : null,
    selectedOrderId: reads.includes('orders.list') ? full.selectedOrderId : null,
    action:
      reads.length === 3
        ? full.action
        : reads.length === 0
          ? 'policy_info'
          : reads.length === 2
            ? 'records_summary'
            : reads[0] === 'crm.getCustomer'
              ? 'eligibility_info'
              : reads[0] === 'orders.list'
                ? 'order_status'
                : 'refund_status',
  };
}
function taskFor(request: BenchmarkRequest): SelectiveCase {
  const reads = [...scopeReads[request.scope]];
  const contract = defineContextContract({
    requirement:
      request.scope === 'agent_decides' ? 'agent_decides' : reads.length ? 'subset' : 'known',
    reads,
  });
  return {
    id: 'interactive',
    category: request.scope,
    group:
      request.scope === 'agent_decides'
        ? 'agent_decided'
        : reads.length === 3
          ? 'healthy_complete'
          : reads.length
            ? 'healthy_selective'
            : 'no_context',
    customerId: request.customerId,
    message: request.prompt,
    contract,
    existingContract: contract,
    requiredReads: reads,
    permittedReads: reads,
    approvedPrerequisites: [],
    artifact: 'observed',
    fault: { kind: 'none' },
    expected: expected(request.customerId, reads),
  };
}
function fixtureReply(response: Omit<SelectiveResponse, 'reply'>): string {
  if (response.action === 'policy_info')
    return 'Delayed-delivery support depends on eligibility, the length of the delay and previous refunds. An eligible account with an order at least 7 days late and no prior refunds may qualify for refund review. Previous refunds require human review. These are support recommendations; no refund or order change is performed.';
  const order = response.orders?.find((entry) => entry.id === response.selectedOrderId);
  return [
    'I have checked the requested records in this read-only sandbox.',
    response.eligible === null
      ? ''
      : `Your account is ${response.eligible ? 'eligible' : 'not eligible'} for delay support.`,
    order ? `Your most delayed order is ${order.id}, which is ${order.daysLate} days late.` : '',
    response.refunds === null
      ? ''
      : response.refunds.length
        ? `Recorded refunds: ${response.refunds.map((r) => `${r.id}: $${r.amount}`).join(', ')}.`
        : 'There are no recorded refunds.',
    `The recorded next step is ${response.action.replaceAll('_', ' ')}. This is a recommendation only; no refund has been issued and no external action has been taken.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export class BenchmarkWorkspace {
  private busy = false;
  private readonly selectedModel: string;
  private prepared?: Promise<{ artifact: IRArtifact; setup: BenchmarkRun['setup'] }>;
  constructor(
    private readonly options: {
      liveEnabled?: boolean;
      model?: string;
      // Trusted application configuration only; never accepted from benchmark request JSON.
      prefetchCostComparison?: (
        request: Readonly<BenchmarkRequest>,
      ) => PrefetchCostComparison | undefined;
      agentFactory?: (
        options: ConstructorParameters<typeof CustomerContextAgent>[0],
      ) => CustomerContextAgent;
    } = {},
  ) {
    this.selectedModel = z
      .string()
      .regex(/^gpt-[a-zA-Z0-9.-]{1,80}$/)
      .parse(options.model ?? process.env.FOUNDRY_BENCHMARK_MODEL ?? model);
  }
  config(): BenchmarkConfig {
    return {
      liveEnabled:
        this.options.liveEnabled ??
        (process.env.FOUNDRY_BENCHMARK_LIVE === 'true' &&
          process.env.FOUNDRY_CODEX_DRY_RUN !== 'true'),
      provider,
      model: this.selectedModel,
      scenarios,
    };
  }
  private prepare() {
    if (!this.prepared)
      this.prepared = this.build().catch((error) => {
        this.prepared = undefined;
        throw error;
      });
    return this.prepared;
  }
  private async build() {
    const started = performance.now();
    const traces = await Promise.all(
      ['C-101', 'C-202'].map(async (customerId) => {
        const observer = new TrajectoryObserver({
          input: { customerId },
          context: localContext(),
          adapters: mockAdapters(),
          agentId: 'benchmark-fixture-setup',
          origin: 'fixture',
        });
        const results = await Promise.all(
          allReads.map(async (operation) => [
            resourceKeys[operation],
            (await observer.read(operation, { source: 'task_input', key: 'customerId' })).value,
          ]),
        );
        return observer.finish({ customer_id: customerId, ...Object.fromEntries(results) });
      }),
    );
    const { ir, report } = compileIR(traces);
    const artifact = emitArtifact(ir, report, { version: 1 });
    artifact.checks = await verifyIR(artifact, traces);
    if (!artifact.checks.length || artifact.checks.some((check) => !check.passed))
      throw new DomainError(
        'Benchmark capability verification failed. Normal execution remains available in the developer console.',
        409,
      );
    artifact.verifiedDigest = artifact.digest;
    artifact.verifiedAt = new Date().toISOString();
    artifact.approvedDigest = artifact.digest;
    artifact.status = 'approved';
    // Isolated fixture capability only. This does not promote anything in the customer's registry.
    for (const customerId of ['C-101', 'C-202', 'C-303']) {
      const run = await dispatch({ kind: 'customer_context', input: { customerId } }, [artifact], {
        adapters: mockAdapters(),
        context: localContext(),
      });
      const reference = {
        customer_id: customerId,
        ...Object.fromEntries(
          allReads.map((operation) => [
            resourceKeys[operation],
            fixtureResult(operation, customerId),
          ]),
        ),
      };
      if (run.outcome !== 'success' || !sameContext(run.result, reference))
        throw new DomainError('Benchmark fixture shadow equivalence failed.', 409);
    }
    return {
      artifact,
      setup: {
        durationMs: performance.now() - started,
        modelCalls: 0,
        costUsd: 0,
        checks: artifact.checks.length + 3,
      },
    };
  }
  async run(raw: unknown): Promise<BenchmarkRun> {
    const request = benchmarkRequestSchema.parse(raw);
    if (request.execution === 'live' && !this.config().liveEnabled)
      throw new DomainError(
        'Live benchmarks are disabled. Start the local server with FOUNDRY_BENCHMARK_LIVE=true and an authenticated Codex CLI, or use preview.',
        409,
      );
    if (this.busy)
      throw new DomainError('A benchmark is already running. Wait for it to finish.', 409);
    this.busy = true;
    try {
      const prepared = await this.prepare();
      const pairs: BenchmarkPair[] = [];
      const first = randomInt(2);
      for (let repeat = 0; repeat < request.repeats; repeat++) {
        const order: ('normal' | 'foundry')[] =
          (first + repeat) % 2 ? ['foundry', 'normal'] : ['normal', 'foundry'];
        const arms = {} as Pick<BenchmarkPair, 'normal' | 'foundry'>;
        for (const arm of order) arms[arm] = await this.execute(request, arm, prepared.artifact);
        const projection = (response: BenchmarkArm['response']) => {
          if (!response) return null;
          const { reply: _reply, ...facts } = response;
          return canonical({
            ...facts,
            orders: facts.orders?.slice().sort((a, b) => a.id.localeCompare(b.id)) ?? null,
            refunds: facts.refunds?.slice().sort((a, b) => a.id.localeCompare(b.id)) ?? null,
          });
        };
        const equivalence =
          !arms.normal.response || !arms.foundry.response
            ? 'unavailable'
            : projection(arms.normal.response) === projection(arms.foundry.response)
              ? 'match'
              : 'mismatch';
        pairs.push({ order, ...arms, equivalence });
      }
      return {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        request,
        provider: request.execution === 'live' ? provider : 'deterministic-preview',
        model: request.execution === 'live' ? this.selectedModel : 'none',
        setup: prepared.setup,
        pricing: { ...rateCard, model, applicable: this.selectedModel === model },
        pairs,
      };
    } finally {
      this.busy = false;
    }
  }
  private async execute(
    request: BenchmarkRequest,
    arm: BenchmarkArm['arm'],
    artifact: IRArtifact,
  ): Promise<BenchmarkArm> {
    const started = performance.now();
    const task = taskFor(request);
    const input = { customerId: task.customerId };
    const baseContext = localContext();
    const context = {
      ...baseContext,
      allowedCustomerIds: baseContext.allowedCustomerIds
        ? baseContext.allowedCustomerIds.filter((id) => id === task.customerId)
        : [task.customerId],
    };
    const reads: BenchmarkArm['reads'] = [];
    const attempts = new Map<ReadOperation, number>();
    const rawAdapters: AdapterRunner = async (operation, args, runtime, signal) => {
      authorizeReads(runtime, args, [operation]);
      const count = (attempts.get(operation) ?? 0) + 1;
      attempts.set(operation, count);
      if (count > 2) throw new DomainError('Read retry budget exhausted.', 503);
      const at = performance.now();
      const read: BenchmarkArm['reads'][number] = { operation, status: 'success', durationMs: 0 };
      reads.push(read);
      try {
        return await mockAdapters()(operation, args, runtime, signal);
      } catch (error) {
        read.status = 'failed';
        throw error;
      } finally {
        read.durationMs = performance.now() - at;
      }
    };
    const cache = new RequestReadCache({ adapters: rawAdapters, input, freshnessMs: 30000 });
    const adapters = arm === 'foundry' ? cache.adapters : rawAdapters;
    const selectionStarted = performance.now();
    const selection: ExecutionSelection =
      arm === 'normal'
        ? { mode: 'normal', reason: 'original_authorized_tools', durationMs: 0, resources: [] }
        : selectExecution(task.contract, input, context, {
            candidate: artifact,
            prefetchCostComparison: this.options.prefetchCostComparison?.(request),
          });
    if (arm === 'foundry') selection.durationMs = performance.now() - selectionStarted;
    const selectedMode = selection.mode;
    let available: Partial<Record<ReadOperation, unknown>> | undefined;
    let fallback = false;
    let loaderAttempted = false;
    let response: SelectiveResponse | undefined;
    let measurement = emptyMeasurement(request.execution === 'preview' ? 'fixture' : 'observed');
    let failure: string | null = null;
    let authorizationDenied = false;
    let agent: CustomerContextAgent | undefined;
    const load = async () => {
      if (loaderAttempted) return { unavailable: true, availableReads: cache.available(context) };
      loaderAttempted = true;
      const run = await dispatch({ kind: 'customer_context', input }, [artifact], {
        adapters,
        context,
        resources: selection.resources.length ? selection.resources : undefined,
      });
      if (run.outcome === 'denied') throw new DomainError('Customer access denied.', 403);
      if (run.outcome !== 'success' || !run.result) {
        fallback = true;
        available = cache.available(context);
        return { unavailable: true, availableReads: available };
      }
      available = Object.fromEntries(
        (selection.resources.length ? selection.resources : allReads).map((operation) => [
          operation,
          run.result![resourceKeys[operation]],
        ]),
      );
      return run.result;
    };
    const observer = new TrajectoryObserver({
      input,
      context,
      adapters,
      agentId: 'benchmark-support-agent',
      provider,
      model: this.selectedModel,
      allowedOperations: [...task.contract.reads],
      origin: measurement.origin,
    });
    try {
      authorizeReads(context, input, task.contract.reads);
      if (selectedMode === 'denied') throw new DomainError('Customer access denied.', 403);
      if (selectedMode === 'compiled_prefetch') await load();
      const originalTools = tools.filter((tool) =>
        task.contract.reads.includes(operations[tool.name]),
      );
      const offered =
        selectedMode === 'compiled_prefetch' && !fallback
          ? []
          : selectedMode === 'compiled_tool'
            ? [...originalTools, ...compiledContextTool]
            : originalTools;
      if (request.execution === 'preview') {
        if (selectedMode === 'compiled_tool') await load();
        else if (selectedMode !== 'compiled_prefetch' || fallback)
          await Promise.all(
            task.requiredReads.map((operation) =>
              observer.read(operation, { source: 'task_input', key: 'customerId' }),
            ),
          );
        response = { ...task.expected, reply: fixtureReply(task.expected) };
        measurement = {
          ...observer.measurement,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          modelCalls: null,
          outcome: 'success',
        };
      } else {
        const agentOptions = {
          adapters,
          context: () => context,
          agentId: 'benchmark-support-agent',
          model: this.selectedModel,
          timeoutMs: 60000,
          maxModelCalls: 6,
          maxToolCalls: 10,
          recoverReadFailures: true,
        };
        agent = this.options.agentFactory
          ? this.options.agentFactory(agentOptions)
          : new CustomerContextAgent(agentOptions);
        await agent.start();
        const run = await agent.runTask({
          input,
          observer,
          tools: offered,
          allowedOperations: [...task.contract.reads],
          executeTool: async (capture, name, args) => {
            z.object({}).strict().parse(args);
            if (!offered.some((tool) => tool.name === name))
              throw new DomainError('Tool not offered.', 403);
            return name === compiledContextTool[0].name ? load() : executeTool(capture, name, args);
          },
          prompt: selectivePrompt(task, available, fallback),
          instructions: selectiveInstructions,
          outputSchema: z.toJSONSchema(selectiveResponseSchema),
          parseResult: (raw) => selectiveResponseSchema.parse(raw),
          effort: 'low',
          maxModelCalls: 6,
          maxToolCalls: 10,
          complete: (_result, capture) => structuredClone(capture.measurement),
        });
        response = run.result;
        measurement = run.measurement;
      }
    } catch (error) {
      authorizationDenied = error instanceof DomainError && error.status === 403;
      measurement = authorizationDenied
        ? { ...emptyMeasurement(measurement.origin), outcome: 'denied' }
        : error instanceof AgentExecutionError
          ? error.measurement
          : {
              ...observer.finishFailure().measurement!,
              inputTokens: null,
              outputTokens: null,
              cachedInputTokens: null,
              totalTokens: null,
              modelCalls: null,
              outcome: 'failed',
            };
      failure =
        error instanceof DomainError && error.status === 403
          ? 'Authorization denied. No fallback bypass is permitted.'
          : 'Execution did not complete. Provider usage may be incomplete; unknown values are not counted as zero.';
    } finally {
      await agent?.close();
    }
    const verification = request.scope === 'agent_decides' ? 'facts_only' : 'contract';
    // For arbitrary agent-decided prompts, verify evidence/policy, never claim to verify intent.
    const oracleTask =
      verification === 'facts_only' && response
        ? (() => {
            const resources = allReads.filter((op) =>
              op === 'crm.getCustomer'
                ? response.eligible !== null
                : op === 'orders.list'
                  ? response.orders !== null
                  : response.refunds !== null,
            );
            return {
              ...task,
              requiredReads: resources,
              expected: expected(task.customerId, resources),
            };
          })()
        : task;
    const checks: Record<string, boolean> = response
      ? assessSelective(response, oracleTask, reads).checks
      : authorizationDenied
        ? { deniedBeforeInferenceAndReads: reads.length === 0 }
        : { completed: false };
    measurement.durationMs = performance.now() - started;
    measurement.toolCalls = reads.length;
    measurement.outcome = authorizationDenied
      ? 'denied'
      : failure || response?.action === 'unavailable'
        ? 'failed'
        : 'success';
    return {
      arm,
      mode: selectedMode,
      reason:
        arm === 'normal' ? 'Original authorized tools; no Foundry prefetch.' : selection.reason,
      measurement,
      estimatedCostUsd:
        request.execution === 'live' &&
        this.selectedModel === model &&
        measurement.inputTokens !== null &&
        measurement.outputTokens !== null &&
        measurement.cachedInputTokens !== null
          ? apiEquivalentCost(
              measurement.inputTokens,
              measurement.cachedInputTokens,
              measurement.outputTokens,
            )
          : null,
      response: response ?? null,
      checks,
      verification,
      reads,
      selectorMs: arm === 'foundry' ? selection.durationMs : 0,
      fallback,
      failure,
    };
  }
}

export async function retainedEvidence(): Promise<BenchmarkEvidence> {
  const number = z.number().finite().nonnegative();
  const nullable = number.nullable();
  const arm = z.object({
    requests: number,
    mean: z.object({
      inputTokens: nullable,
      outputTokens: nullable,
      cachedInputTokens: nullable,
      totalTokens: nullable,
      modelCalls: nullable,
      toolCalls: nullable,
      durationMs: number,
    }),
    latency: z.object({ p50: number, p95: number }),
    apiEquivalentCostUsd: nullable,
    correctnessRate: number,
    successRate: number,
    fallbackRate: number,
  });
  const evidence = z
    .object({
      capturedAt: z.string().datetime(),
      complete: z.literal(true),
      providerMode: z.literal('live'),
      plan: z.object({ cases: number, repeats: number, measuredSupportRequests: number }),
      steadyState: z.record(z.string(), arm),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../docs/selective-agent-v1.1-heldout.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  return {
    capturedAt: evidence.capturedAt,
    requests: evidence.plan.measuredSupportRequests,
    cases: evidence.plan.cases,
    repeats: evidence.plan.repeats,
    arms: evidence.steadyState,
  };
}
