import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { ModelClient, sumModelUsage, type ModelEvent, type ModelTool } from '../agent/providers.js';
import { diagnoseGemini, geminiStressModel } from '../agent/gemini-diagnostics.js';
import { createApp } from '../app.js';
import { ContractRegistry, digest, json, stable, type Json } from '../compiler/contracts.js';
import { type Binding, type TaskTrace, taskTraceSchema } from '../compiler/task-ir.js';
import { TaskObserver } from '../exploration/task-observer.js';
import { TaskClient } from '../integration/task-client.js';
import { Store } from '../registry/store.js';
import { ArtifactSigner } from '../security/signing.js';
import { ApiKeyAuthenticator, localIdentity } from '../security/identity.js';
import { DomainError } from '../domain.js';
import type { TaskArtifact } from '../runtime/task-runtime.js';
import { startBillingApi } from './billing-http.js';
import {
  billingStatistics,
  billingPricingSchema,
  estimateBillingCost,
} from './billing-statistics.js';
import {
  BillingApiError,
  BillingEnvironment,
  assessBilling,
  billingAccess,
  billingCustomer,
  billingDescriptions,
  billingInstruction,
  billingNow,
  billingReads,
  billingResolution,
  parseBillingAnswer,
  billingToolInputs,
  billingToolOutputs,
  billingVariants,
  billingWrites,
  type BillingTool,
  type BillingVariant,
} from './billing-fixtures.js';

export const billingKind = 'enterprise_billing_reads';
export const billingCapabilityName = 'billing_observed_reads';
export const billingTaskInput = z
  .object({ customer_id: z.literal(billingCustomer), seed: z.number().int().nonnegative() })
  .strict();
export type BillingArm = 'baseline' | 'optimized';
export type BillingRun = {
  origin: 'fixture' | 'observed';
  id: string;
  phase: 'training' | 'measured';
  variant: BillingVariant;
  seed: number;
  arm: BillingArm;
  startedAt: string;
  durationMs: number;
  model: string;
  settings: {
    temperature: 0;
    maxOutputTokens: 16384;
    maxModelCalls: 24;
    maxToolCalls: 100;
    maxTotalTokens?: number;
  };
  events: ModelEvent[];
  usage: ReturnType<typeof sumModelUsage>;
  exchanges: unknown[];
  modelToolCalls: number;
  businessCalls: number;
  toolErrors: number;
  retryCalls: number;
  fallbacks: number;
  transcript: { name: string; args: Json; result: Json; startedAt: string; durationMs: number }[];
  reads: TaskTrace | null;
  answer: Json | null;
  state: Json;
  calls: BillingEnvironment['calls'];
  passed: boolean;
  checks: Record<string, boolean>;
  failure: string | null;
  estimatedCostUsd: number | null;
};
const instruction =
  'You are a billing investigation agent using synthetic APIs. Complete the user task using API evidence, not guesses. Follow every next_cursor to the end. Refresh stale reads; retry retryable reads at most once. A timed-out refund must be retried with the same idempotency key and identical payload. Never bypass denied authorization. The tool schemas and returned refund policy define authorized actions. Record itemized settled-payment decisions, refunds and escalation in the support ticket and audit trail. Return only JSON matching this contract: ' +
  JSON.stringify(z.toJSONSchema(billingResolution)) +
  '. API as_of is the simulated decision time. Failed, pending and reversed payment attempts are not collected charges.';

export class BillingWorkspace {
  readonly runs: BillingRun[] = [];
  artifact: TaskArtifact | null = null;
  compilation: {
    durationMs: number;
    limitations: string[];
    sourceTraceIds: string[];
    candidateReads: number;
    shadowMatches: number;
    deploymentStatus: string;
    checks: { name: string; passed: boolean }[];
  } = {
    durationMs: 0,
    limitations: [
      'Writes, inferred loops and branches are not supported by the compiler; only observed read regions may compile.',
    ],
    sourceTraceIds: [],
    candidateReads: 0,
    shadowMatches: 0,
    deploymentStatus: 'not_compiled',
    checks: [],
  };
  private registry = new ContractRegistry();
  private api?: Awaited<ReturnType<typeof startBillingApi>>;
  private sdk?: TaskClient;
  private store?: Store;
  private controlServer?: ReturnType<ReturnType<typeof createApp>['app']['listen']>;
  private initialize?: Promise<void>;
  private busy = false;
  private origin: 'agent' | 'compiled' | 'validation' = 'agent';
  private origins = new AsyncLocalStorage<'compiled'>();
  private usageUnknown = false;
  private preflightPassed = false;
  private observedCalls: { id: string; tool: BillingTool; args: Json }[] = [];
  private totalTokens = 0;
  private reservedUnknownTokens = 0;
  private totalModelCalls = 0;
  private initializationMs = 0;
  private limits: { totalTokens: number; taskTokens: number };
  private pricing = process.env.FOUNDRY_BILLING_PRICING
    ? billingPricingSchema.parse(JSON.parse(process.env.FOUNDRY_BILLING_PRICING))
    : null;
  constructor(
    private options: {
      Client?: typeof TaskClient;
      provider?: ModelClient;
      skipPreflightForFixtures?: boolean;
      limits?: { totalTokens: number; taskTokens: number };
    } = {},
  ) {
    this.limits = z
      .object({
        totalTokens: z.number().int().positive().max(24000000),
        taskTokens: z.number().int().positive().max(500000),
      })
      .strict()
      .parse(options.limits ?? { totalTokens: 5000000, taskTokens: 250000 });
  }
  restoreObservedTraining(runs: readonly BillingRun[]) {
    if (
      this.busy ||
      this.runs.length ||
      runs.length !== 2 ||
      new Set(runs.map((run) => run.seed)).size !== 2
    )
      throw new DomainError(
        'Two distinct completed training runs are required before starting a fresh study.',
        409,
      );
    for (const run of runs) {
      if (
        run.origin !== 'observed' ||
        run.phase !== 'training' ||
        !run.passed ||
        run.model !== geminiStressModel ||
        run.settings.temperature !== 0 ||
        run.settings.maxOutputTokens !== 16384 ||
        !run.events.length ||
        run.events.some(
          (event) => event.status !== 'success' || event.usage.totalTokens === null,
        ) ||
        !run.reads ||
        stable(sumModelUsage(run.events)) !== stable(run.usage)
      )
        throw new DomainError(
          'Only complete observed training with matching model/settings and reported usage can be restored.',
          409,
        );
      taskTraceSchema.parse(run.reads);
    }
    this.runs.push(...structuredClone(runs));
    this.totalTokens = runs.reduce((sum, run) => sum + run.usage.totalTokens!, 0);
    this.totalModelCalls = runs.reduce((sum, run) => sum + run.events.length, 0);
  }
  restoreMeasuredStudy(runs: readonly BillingRun[], unknownRequestBound: number) {
    if (this.busy || this.runs.some((run) => run.phase === 'measured'))
      throw new DomainError('Measured study can only be restored once before execution.', 409);
    z.number().int().positive().max(2000000).parse(unknownRequestBound);
    const keys = new Set<string>();
    let known = 0,
      calls = 0,
      unknown = 0;
    for (const run of runs) {
      const key = `${run.variant}:${run.seed}:${run.arm}`;
      if (
        run.origin !== 'observed' ||
        run.phase !== 'measured' ||
        run.model !== geminiStressModel ||
        run.settings.temperature !== 0 ||
        run.settings.maxOutputTokens !== 16384 ||
        run.settings.maxTotalTokens !== this.limits.taskTokens ||
        keys.has(key) ||
        !billingVariants.includes(run.variant) ||
        !['baseline', 'optimized'].includes(run.arm)
      )
        throw new DomainError(
          'Resumed measurements must match the frozen study configuration and have unique matched keys.',
          409,
        );
      keys.add(key);
      for (const event of run.events) {
        calls++;
        if (event.usage.totalTokens === null) unknown++;
        else known += z.number().int().nonnegative().parse(event.usage.totalTokens);
      }
    }
    this.runs.push(...structuredClone(runs));
    this.totalTokens += known;
    this.totalModelCalls += calls;
    // Missing usage remains null in measurements. Reserve the full advertised input limit
    // plus configured maximum output, rather than treating the failed request as free.
    this.reservedUnknownTokens = unknown * unknownRequestBound;
  }
  catalog() {
    return {
      label: 'Enterprise Billing Investigation',
      instruction: billingInstruction,
      model: geminiStressModel,
      variants: billingVariants,
      minimumPairs: 5,
      live: !this.options.skipPreflightForFixtures,
      tools: (Object.keys(billingToolInputs) as BillingTool[]).map((name) => ({
        name,
        effect: billingWrites.has(name) ? 'write' : 'read',
        compilable: billingReads.includes(name),
        description: billingDescriptions[name],
        inputSchema: z.toJSONSchema(billingToolInputs[name]),
        outputSchema: z.toJSONSchema(billingToolOutputs[name]),
      })),
      limits: {
        maxModelCallsPerTask: 24,
        maxToolCallsPerTask: 100,
        totalTokenLimit: this.limits.totalTokens,
        taskTokenLimit: this.limits.taskTokens,
        totalModelCallLimit: 1753,
      },
      pricing: this.pricing,
    };
  }
  summary() {
    return {
      catalog: this.catalog(),
      busy: this.busy,
      compilation: this.compilation,
      artifact: this.artifact,
      runs: this.runs.map(({ exchanges, transcript, reads, calls, state, ...summary }) => summary),
      totalReportedTokens: this.totalTokens,
      reservedUnknownTokens: this.reservedUnknownTokens,
      totalModelCalls: this.totalModelCalls,
    };
  }
  async preflight() {
    if (this.preflightPassed || this.options.skipPreflightForFixtures) return;
    const report = await diagnoseGemini({ key: process.env.GEMINI_API_KEY ?? '' });
    if (report.discovery.httpStatus !== 200)
      throw new DomainError(
        `Gemini Developer API model discovery failed: HTTP ${report.discovery.httpStatus ?? 'network error'}. No agent task ran.`,
        503,
      );
    if (!report.discovery.requiredModelListed)
      throw new DomainError(
        `${geminiStressModel} was not returned by the project model catalog; refusing to substitute another model.`,
        409,
      );
    this.preflightPassed = true;
  }
  private async runtime() {
    if (!this.initialize) this.initialize = this.build();
    return this.initialize;
  }
  private async build() {
    const began = performance.now();
    this.api = await startBillingApi();
    for (const name of billingReads)
      this.registry.registerTool({
        name,
        version: 'billing-api-v1',
        description: billingDescriptions[name],
        effect: 'read',
        scopes: ['billing:read'],
        input: billingToolInputs[name],
        output: billingToolOutputs[name],
        timeoutMs: 3000,
        replaySafe: true,
        authorize: (context, args) =>
          context.tenantId === 'local-demo' &&
          context.principalId === 'local-operator' &&
          (!('customer_id' in (args as object)) || (args as any).customer_id === billingCustomer),
        validateResult: (context, _args, result) =>
          (result as any).customer_id === billingCustomer &&
          (result as any).tenant_id === context.tenantId &&
          (result as any).snapshot === context.snapshot &&
          (result as any).fresh === true,
        run: (args) => this.api!.request(name, args, this.origins.getStore() ?? this.origin),
      });
    this.registry.registerTask({
      kind: billingKind,
      version: 'billing-investigation-v1',
      description:
        'Observed authorized read-only regions of the exact enterprise billing investigation; never refunds or ticket writes.',
      input: billingTaskInput,
      output: z.record(z.string(), z.json()),
      tools: billingReads,
      maxAgeMs: 30000,
      maxConcurrency: 8,
      timeoutMs: 20000,
      authorize: (context, input) =>
        context.tenantId === 'local-demo' &&
        context.principalId === 'local-operator' &&
        (input as any).customer_id === billingCustomer,
    });
    const keys = generateKeyPairSync('ed25519');
    const signer = new ArtifactSigner(
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const credential = randomUUID();
    const identity = { ...localIdentity, toolScopes: billingAccess().scopes };
    const auth = new ApiKeyAuthenticator([
      { sha256: createHash('sha256').update(credential).digest('hex'), identity },
    ]);
    this.store = new Store(':memory:');
    const golden = async () => {
      const world = new BillingEnvironment();
      const result: Record<string, Json> = {};
      for (const call of this.observedCalls)
        result[call.id] = await world.call(call.tool, call.args, undefined, 'validation');
      return json(result);
    };
    const { app } = createApp(this.store, false, {
      auth,
      signer,
      billing: false,
      tasks: {
        registry: this.registry,
        context: billingAccess,
        verificationCases: () =>
          [101, 102, 103].map((seed) => ({
            input: { customer_id: billingCustomer, seed },
            expected: this.goldenResult(),
          })),
        native: () => golden(),
      },
    });
    this.controlServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((done) => this.controlServer!.once('listening', done));
    this.sdk = new (this.options.Client ?? TaskClient)({
      registry: this.registry,
      context: billingAccess,
      endpoint: `http://127.0.0.1:${(this.controlServer.address() as AddressInfo).port}`,
      apiKey: credential,
      trustedPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    this.initializationMs = performance.now() - began;
  }
  private goldenValues: Record<string, Json> = {};
  private goldenResult() {
    return json(this.goldenValues);
  }
  async runArm(
    arm: BillingArm,
    variant: BillingVariant,
    seed: number,
    phase: BillingRun['phase'] = 'measured',
  ) {
    if (this.busy) throw new DomainError('Billing workspace is busy.', 409);
    this.busy = true;
    try {
      if (
        this.totalTokens + this.reservedUnknownTokens >= this.limits.totalTokens ||
        this.totalModelCalls >= 1753 ||
        this.usageUnknown
      )
        throw new DomainError(
          'Live budget reached or provider usage became unknown; refusing further agent tasks.',
          429,
        );
      await this.preflight();
      await this.runtime();
      return await this.execute(arm, variant, seed, phase);
    } finally {
      this.busy = false;
    }
  }
  private async execute(
    arm: BillingArm,
    variant: BillingVariant,
    seed: number,
    phase: BillingRun['phase'],
  ): Promise<BillingRun> {
    const began = performance.now();
    const world = new BillingEnvironment(variant, seed);
    this.api!.activate(world);
    this.origin = 'agent';
    const input = { customer_id: billingCustomer, seed };
    const observer = new TaskObserver(this.registry, billingKind, input, billingAccess());
    const events: ModelEvent[] = [];
    const exchanges: unknown[] = [];
    const transcript: BillingRun['transcript'] = [];
    const outputs: Record<string, Binding> = {};
    const nodeCounts = new Map<string, number>();
    let answer: Json | null = null;
    let failure: string | null = null;
    let modelToolCalls = 0;
    let fallbacks = arm === 'optimized' && this.compilation.deploymentStatus !== 'deployed' ? 1 : 0;
    const tools: ModelTool[] = (Object.keys(billingToolInputs) as BillingTool[]).map((name) => ({
      name,
      description: billingDescriptions[name],
      inputSchema: json(z.toJSONSchema(billingToolInputs[name])),
    }));
    if (
      arm === 'optimized' &&
      this.artifact?.status === 'approved' &&
      this.compilation.deploymentStatus === 'deployed'
    )
      tools.push({
        name: billingCapabilityName,
        description: `Validated read-only capability replaying observed API reads: ${[...new Set(this.observedCalls.map((c) => c.tool))].join(', ')}. Returns named API responses; only observed pages and records are covered. Original APIs remain for missing pages, refreshes and unsupported branches. Performs no refunds, ticket updates or audit writes.`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      });
    const provider =
      this.options.provider ??
      new ModelClient({
        provider: 'gemini',
        model: geminiStressModel,
        temperature: 0,
        maxOutputTokens: 16384,
      });
    try {
      const result = await provider.run({
        instructions: instruction,
        prompt: billingInstruction,
        tools,
        maxModelCalls: 24,
        maxToolCalls: 100,
        maxTotalTokens: this.limits.taskTokens,
        beforeRequest: () => {
          if (
            this.totalTokens + this.reservedUnknownTokens >= this.limits.totalTokens ||
            this.totalModelCalls >= 1753 ||
            this.usageUnknown
          )
            throw new Error('Overall live budget reached before provider request.');
        },
        onEvent: (event) => {
          events.push(event);
          this.totalModelCalls++;
          this.totalTokens += event.usage.totalTokens ?? 0;
          if (event.usage.totalTokens === null) {
            this.usageUnknown = true;
            throw new Error(
              'Provider usage unknown; no further inference is authorized by this run.',
            );
          }
          if (
            this.totalTokens + this.reservedUnknownTokens > this.limits.totalTokens ||
            this.totalModelCalls > 1753
          )
            throw new Error('Overall live inference budget exceeded after usage update.');
        },
        onGeminiExchange: (exchange) => exchanges.push(exchange),
        execute: async (name, raw) => {
          const started = performance.now();
          const startedAt = new Date().toISOString();
          let result: Json;
          try {
            if (name === billingCapabilityName) {
              z.object({}).strict().parse(raw);
              try {
                const run = await this.origins.run('compiled', () =>
                  this.sdk!.execute({
                    name: billingCapabilityName,
                    kind: billingKind,
                    input,
                  }),
                );
                if (run.outcome === 'denied')
                  result = {
                    error: { http_status: 403, code: 'COMPILED_ACCESS_DENIED', retryable: false },
                  };
                else if (run.outcome !== 'success') {
                  fallbacks++;
                  result = json({
                    unavailable: true,
                    available_reads: run.checkpoint?.liveValues ?? {},
                    message: 'Use original authorized APIs for missing reads.',
                  });
                } else result = run.result!;
              } finally {
                this.origin = 'agent';
              }
            } else {
              const tool = name as BillingTool;
              if (!billingToolInputs[tool])
                throw new BillingApiError(403, 'UNKNOWN_TOOL', 'Tool not offered.');
              const args = json(billingToolInputs[tool].parse(raw));
              if (billingReads.includes(tool)) {
                const base = `${tool}_${digest(args).slice(0, 12)}`;
                const count = (nodeCounts.get(base) ?? 0) + 1;
                nodeCounts.set(base, count);
                const id = count === 1 ? base : `${base}_${count}`;
                const bindings = Object.fromEntries(
                  Object.entries(args as Record<string, Json>).map(([key, value]) => [
                    key,
                    key === 'customer_id'
                      ? { source: 'input', path: ['customer_id'] }
                      : { source: 'literal', value },
                  ]),
                ) as Record<string, Binding>;
                result = await observer.call(id, tool, bindings);
                outputs[id] = { source: 'ref', node: id, path: [] };
              } else result = await this.api!.request(tool, args);
            }
          } catch (error) {
            const status =
              error instanceof BillingApiError
                ? error.status
                : error instanceof DomainError
                  ? error.status
                  : 400;
            result = {
              error: {
                http_status: status,
                code:
                  error instanceof BillingApiError ? error.code : 'TOOL_ARGUMENT_OR_GUARD_ERROR',
                message:
                  error instanceof BillingApiError
                    ? error.message
                    : 'Typed API arguments or runtime guards rejected this call.',
                retryable: error instanceof BillingApiError ? error.retryable : false,
              },
            };
          }
          transcript.push({
            name,
            args: raw,
            result,
            startedAt,
            durationMs: performance.now() - started,
          });
          return result;
        },
      });
      modelToolCalls = result.toolCalls;
      answer = parseBillingAnswer(result.text);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Agent execution failed.';
    }
    let reads: TaskTrace | null = null;
    try {
      reads = observer.finish(outputs);
    } catch {
      /* Insufficient successful read evidence is retained as a limitation. */
    }
    const correctness = assessBilling(world, answer);
    const retryCalls = world.calls.filter((call, index, calls) =>
      calls
        .slice(0, index)
        .some(
          (previous) =>
            previous.tool === call.tool &&
            stable(previous.args) === stable(call.args) &&
            previous.httpStatus !== 200,
        ),
    ).length;
    const run: BillingRun = {
      origin: this.options.skipPreflightForFixtures ? 'fixture' : 'observed',
      id: randomUUID(),
      phase,
      variant,
      seed,
      arm,
      startedAt: new Date(Date.now() - (performance.now() - began)).toISOString(),
      durationMs: performance.now() - began,
      model: geminiStressModel,
      settings: {
        temperature: 0,
        maxOutputTokens: 16384,
        maxModelCalls: 24,
        maxToolCalls: 100,
        maxTotalTokens: this.limits.taskTokens,
      },
      events,
      usage: events.length
        ? sumModelUsage(events)
        : {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            totalTokens: null,
            reasoningTokens: null,
          },
      exchanges,
      modelToolCalls: transcript.length || modelToolCalls,
      businessCalls: world.calls.length,
      toolErrors: world.calls.filter((c) => c.httpStatus >= 400).length,
      retryCalls,
      fallbacks,
      transcript,
      reads,
      answer,
      state: world.state(),
      calls: world.calls,
      passed: !failure && correctness.passed,
      checks: correctness.checks,
      failure,
      estimatedCostUsd: estimateBillingCost(events, this.pricing),
    };
    this.runs.push(run);
    if (events.some((event) => event.usage.totalTokens === null)) this.usageUnknown = true;
    return run;
  }
  async compile() {
    if (this.busy) throw new DomainError('Billing workspace is busy.', 409);
    this.busy = true;
    const began = performance.now();
    try {
      await this.runtime();
      this.origin = 'validation';
      this.api!.activate(new BillingEnvironment());
      const source = this.runs
        .filter((run) => run.arm === 'baseline' && run.reads && run.passed)
        .slice(0, 2)
        .map((run) => run.reads!);
      if (source.length < 2)
        throw new DomainError(
          'Two correct baseline runs with distinct seeds are required. No fixture trace may substitute for live source evidence.',
          409,
        );
      // Discover repeated exact read nodes from actual observed provenance. No billing-specific
      // combined function, guessed references, inferred loops or write nodes are manufactured.
      const repeated = source[0].events.filter((event) =>
        source[1].events.some(
          (other) =>
            other.id === event.id &&
            stable({ tool: other.tool, args: other.args, contractDigest: other.contractDigest }) ===
              stable({ tool: event.tool, args: event.args, contractDigest: event.contractDigest }),
        ),
      );
      if (!repeated.length)
        throw new DomainError(
          'Compiler limitation: no compatible observed read region repeated.',
          409,
        );
      this.observedCalls = repeated.map((event) => ({
        id: event.id,
        tool: event.tool as BillingTool,
        args: event.argsValue,
      }));
      const oracle = new BillingEnvironment();
      this.goldenValues = {};
      for (const call of this.observedCalls)
        this.goldenValues[call.id] = await oracle.call(
          call.tool,
          call.args,
          undefined,
          'validation',
        );
      const output = Object.fromEntries(
        repeated.map((event) => [event.id, { source: 'ref', node: event.id, path: [] } as Binding]),
      );
      const traces = source.map((trace) =>
        taskTraceSchema.parse({
          ...trace,
          id: randomUUID(),
          events: trace.events.filter((event) =>
            repeated.some((repeated) => repeated.id === event.id),
          ),
          output,
          result: Object.fromEntries(
            trace.events
              .filter((event) => repeated.some((repeated) => repeated.id === event.id))
              .map((event) => [event.id, event.result]),
          ),
        }),
      );
      const ids: string[] = [];
      for (const trace of traces) ids.push((await this.sdk!.observe(trace)).id);
      this.compilation.sourceTraceIds = source.map((trace) => trace.id);
      this.compilation.candidateReads = repeated.length;
      this.artifact = await this.sdk!.compile(billingCapabilityName, ids);
      this.artifact = await this.sdk!.verify(this.artifact.id);
      this.compilation.checks = this.artifact.checks;
      if (this.artifact.status !== 'verified')
        throw new DomainError(
          'Observed candidate failed independent verification; deployment remains blocked.',
          409,
        );
      this.compilation.shadowMatches = 0;
      for (const seed of [201, 202, 203]) {
        const shadow = await this.sdk!.shadow(this.artifact.id, {
          customer_id: billingCustomer,
          seed,
        });
        if (shadow.status !== 'match')
          throw new DomainError('Native-authoritative shadow comparison failed.', 409);
        this.compilation.shadowMatches++;
      }
      this.compilation.deploymentStatus = 'verified_not_approved';
      return this.artifact;
    } catch (error) {
      this.compilation.limitations.push(
        error instanceof Error ? error.message : 'Compilation failed.',
      );
      throw error;
    } finally {
      this.origin = 'agent';
      this.compilation.durationMs += performance.now() - began;
      this.busy = false;
    }
  }
  async deploy() {
    if (this.busy) throw new DomainError('Billing workspace is busy.', 409);
    if (!this.artifact || this.artifact.status !== 'verified')
      throw new DomainError(
        'Passing verification and shadows required before approval/deployment.',
        409,
      );
    this.busy = true;
    const began = performance.now();
    try {
      this.artifact = await this.sdk!.approve(this.artifact.id);
      this.artifact = await this.sdk!.deploy(this.artifact.id);
      this.compilation.deploymentStatus = 'deployed';
      return this.artifact;
    } finally {
      this.compilation.durationMs += performance.now() - began;
      this.busy = false;
    }
  }
  report() {
    const measured = this.runs.filter((run) => run.phase === 'measured');
    const totals = (arm: BillingArm) => {
      const runs = measured.filter((run) => run.arm === arm);
      const sum = (field: keyof ReturnType<typeof sumModelUsage>) =>
        !runs.length || runs.some((run) => run.usage[field] === null)
          ? null
          : runs.reduce((sum, run) => sum + run.usage[field]!, 0);
      return {
        requests: runs.length,
        successes: runs.filter((run) => run.passed).length,
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        cachedInputTokens: sum('cachedInputTokens'),
        totalTokens: sum('totalTokens'),
        modelCalls: runs.reduce((sum, run) => sum + run.events.length, 0),
        businessCalls: runs.reduce((sum, run) => sum + run.businessCalls, 0),
        toolCalls: runs.reduce((sum, run) => sum + run.modelToolCalls, 0),
        latencyMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
        fallbacks: runs.reduce((sum, run) => sum + run.fallbacks, 0),
        toolErrors: runs.reduce((sum, run) => sum + run.toolErrors, 0),
        retryCalls: runs.reduce((sum, run) => sum + run.retryCalls, 0),
        estimatedCostUsd:
          !runs.length || runs.some((run) => run.estimatedCostUsd === null)
            ? null
            : runs.reduce((sum, run) => sum + run.estimatedCostUsd!, 0),
      };
    };
    const baseline = totals('baseline'),
      optimized = totals('optimized');
    const statistics = billingStatistics(this.runs);
    return {
      format: 'foundry-enterprise-billing-v1',
      createdAt: new Date().toISOString(),
      catalog: this.catalog(),
      evaluationMode: this.options.skipPreflightForFixtures
        ? 'fixture_no_inference'
        : 'live_gemini',
      complete: statistics.perVariant.every((variant) => variant.pairedTrials >= 5),
      initializationMs: this.initializationMs,
      budgetAccounting: {
        knownReportedTokens: this.totalTokens,
        reservedUnknownTokens: this.reservedUnknownTokens,
        totalTokenLimit: this.limits.totalTokens,
      },
      statistics,
      acceptance: {
        liveInferenceEvidence:
          !this.options.skipPreflightForFixtures &&
          measured.length > 0 &&
          measured.every((run) => run.events.length > 0 && run.usage.totalTokens !== null),
        pairedCoverageComplete: statistics.perVariant.every((variant) => variant.pairedTrials >= 5),
        correctnessPreserved: statistics.correctnessEquivalent,
        compiledCapabilityDeployed: this.compilation.deploymentStatus === 'deployed',
        observedTokenReduction:
          baseline.totalTokens !== null &&
          optimized.totalTokens !== null &&
          baseline.totalTokens > optimized.totalTokens,
      },
      compilation: this.compilation,
      artifact: this.artifact,
      baseline,
      optimized,
      tokenReductionPercent:
        baseline.totalTokens && optimized.totalTokens !== null
          ? (100 * (baseline.totalTokens - optimized.totalTokens)) / baseline.totalTokens
          : null,
      costReductionPercent:
        baseline.estimatedCostUsd && optimized.estimatedCostUsd !== null
          ? (100 * (baseline.estimatedCostUsd - optimized.estimatedCostUsd)) /
            baseline.estimatedCostUsd
          : null,
      pricingBasis: this.pricing
        ? {
            ...this.pricing,
            note: 'Operator-configured API-equivalent estimate, not provider billing. Cache and reasoning usage included; requests outside the configured input tier remain unknown.',
          }
        : 'No verified gemini-3.8-flash price configured. Monetary costs remain unknown, not zero.',
      breakEvenExecutions: null,
      setupRuns: this.runs.filter((run) => run.phase === 'training'),
      runs: measured,
    };
  }
  async close() {
    await this.api?.close();
    if (this.controlServer)
      await new Promise<void>((done) => this.controlServer!.close(() => done()));
    this.store?.close();
  }
}
