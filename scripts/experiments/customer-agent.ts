import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { codexLaunch } from '../../src/agent/codex.js';
import { customerInput, type ReadOperation } from '../../src/compiler/ir.js';
import type { CustomerAgent } from '../../src/integration/client.js';
import { TrajectoryObserver } from '../../src/exploration/observe.js';
import { fullContextSchema } from '../../src/runtime/observable.js';
import {
  authorizeContext,
  type AdapterRunner,
  type RuntimeContext,
} from '../../src/runtime/adapters/registry.js';
import { AgentExecutionError } from '../../src/runtime/dispatcher.js';
import { reportedUsageSchema } from '../../src/telemetry/measurement.js';
import type { Measurement } from '../../src/telemetry/measurement.js';

export function incompleteProviderMeasurement(measured: Measurement): Measurement {
  // A failed stream can have consumed inference without reporting usage. Report unknown total
  // work/cost; the response count remains a separate lower bound in the experiment ledger.
  return {
    ...measured,
    modelCalls: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
    costUsd: null,
    outcome: 'failed',
  };
}

export const provider = 'openai-codex-chatgpt';
export const model = 'gpt-5.5';
export const rateCard = {
  source: 'https://developers.openai.com/api/docs/models/gpt-5.5',
  checkedAt: '2026-10-03',
  inputPerMillionUsd: 5,
  cachedInputPerMillionUsd: 0.5,
  outputPerMillionUsd: 30,
};
export function apiEquivalentCost(input: number, cached: number, output: number): number {
  if (![input, cached, output].every((v) => Number.isSafeInteger(v) && v >= 0) || cached > input)
    throw new Error('Invalid provider usage.');
  // This is a rate-card estimate, never a claim about ChatGPT subscription billing.
  return (
    ((input - cached) * rateCard.inputPerMillionUsd +
      cached * rateCard.cachedInputPerMillionUsd +
      output * rateCard.outputPerMillionUsd) /
    1_000_000
  );
}
export const operations: Record<string, ReadOperation> = {
  lookup_customer: 'crm.getCustomer',
  lookup_orders: 'orders.list',
  lookup_refund_history: 'payments.refundHistory',
};
export const tools = Object.entries(operations).map(([name, operation]) => ({
  type: 'function',
  name,
  description: `Read ${operation} for the application-bound, authorized customer in this task. Returns the complete typed resource.`,
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
}));
export async function executeTool(observer: TrajectoryObserver, name: string, args: unknown) {
  if (!Object.hasOwn(operations, name)) throw new Error('Tool outside read allowlist.');
  z.object({}).strict().parse(args);
  // The application knows customerId already: explicit task-input lineage, not string matching
  // or model prose. The model chooses which reads to invoke and may run them concurrently.
  return (await observer.read(operations[name], { source: 'task_input', key: 'customerId' })).value;
}

const breakdown = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .passthrough();
export class UsageLedger {
  private total = 0;
  responses = 0;
  constructor(private readonly observer: TrajectoryObserver) {}
  accept(raw: unknown, startedAt: number, completedAt: number) {
    const usage = z.object({ total: breakdown, last: breakdown }).parse(raw);
    if (usage.total.totalTokens === this.total) return; // initial/duplicate notifications
    const last = usage.last;
    if (
      usage.total.totalTokens < this.total ||
      last.totalTokens !== last.inputTokens + last.outputTokens ||
      usage.total.totalTokens - this.total !== last.totalTokens
    )
      throw new Error('Provider usage is not an additive completed-response update.');
    this.observer.recordModelResponse(
      reportedUsageSchema.parse({
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
        cachedInputTokens: last.cachedInputTokens,
        // Keep measured cost null: estimates live separately in the experiment report.
      }),
      startedAt,
      completedAt,
    );
    this.total = usage.total.totalTokens;
    this.responses++;
    const measured = this.observer.measurement;
    if (
      measured.inputTokens !== usage.total.inputTokens ||
      measured.outputTokens !== usage.total.outputTokens ||
      measured.cachedInputTokens !== usage.total.cachedInputTokens
    )
      throw new Error('Aggregate usage differs from provider cumulative usage.');
  }
}
type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number };
}; // protocol is narrowed at each boundary
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
const tomlValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${tomlValue(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

// Experimental harness only; it does not replace the existing coding-agent adapter or add a
// production provider. Every request uses a fresh ephemeral thread on the existing CLI account.
export class CustomerContextAgent {
  private child?: ChildProcessWithoutNullStreams;
  private readonly cwd = mkdtempSync(join(tmpdir(), 'foundry-agent-experiment-'));
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private onMessage?: (message: Message) => void;
  private readonly timeoutMs: number;
  private running = false;
  startupMs = 0;
  warnings = 0;
  reroutes = 0;
  lastFailure: string | undefined;
  constructor(
    private readonly options: {
      adapters: AdapterRunner;
      context: () => RuntimeContext;
      agentId: string;
      metricsEndpoint?: string;
      timeoutMs?: number;
      onRun?: (run: {
        measurement: ReturnType<TrajectoryObserver['finish']>['measurement'];
        status: string;
        responses: number;
        apiEquivalentCostUsd: number | null;
      }) => void;
    },
  ) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }
  private send(message: unknown) {
    this.child!.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private async rpc(method: string, params: unknown = {}) {
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Provider RPC timeout: ${method}.`));
      }, 30_000);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, method, params });
    });
  }
  async start() {
    if (process.env.FOUNDRY_CODEX_DRY_RUN === 'true')
      throw new Error('Real-agent benchmark refuses dry-run mode.');
    const began = performance.now();
    const launch = codexLaunch();
    const overrides: Record<string, unknown> = {
      mcp_servers: {},
      plugins: {},
      hooks: {},
      'features.shell_tool': false,
      'features.unified_exec': false,
      'features.multi_agent': false,
      'features.memory_tool': false,
      'features.remote_plugin': false,
      'features.apps': false,
      'features.shell_snapshot': false,
      'features.memories': false,
      project_doc_max_bytes: 0,
      'skills.max_context_tokens': 1,
      hide_agent_reasoning: true,
      show_raw_agent_reasoning: false,
      web_search: 'disabled',
      'history.persistence': 'none',
      'otel.exporter': 'none',
      'otel.trace_exporter': 'none',
      'otel.metrics_exporter': this.options.metricsEndpoint
        ? { 'otlp-http': { endpoint: this.options.metricsEndpoint, protocol: 'json' } }
        : 'none',
      'otel.log_user_prompt': false,
      log_dir: this.cwd,
    };
    const args = [...launch.argsPrefix, 'app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(overrides))
      args.push('-c', `${key}=${tomlValue(value)}`);
    this.child = spawn(launch.command, args, {
      cwd: this.cwd,
      shell: false,
      stdio: 'pipe',
      env: { ...process.env, OTEL_METRIC_EXPORT_INTERVAL: '1000' },
    });
    // stderr and all raw reasoning/message deltas are deliberately discarded, never persisted.
    this.child.stderr.on('data', () => {});
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id));
        this.pending.delete(Number(message.id));
        if (message.error)
          pending?.reject(new Error(`Provider protocol error ${message.error.code}.`));
        else pending?.resolve(message.result);
      } else this.onMessage?.(message);
    });
    this.child.on('error', () => {
      for (const pending of this.pending.values())
        pending.reject(new Error('Provider failed to launch.'));
      this.pending.clear();
    });
    this.child.on('exit', () => {
      for (const pending of this.pending.values())
        pending.reject(new Error('Provider process exited.'));
      this.pending.clear();
      this.onMessage?.({ method: 'experiment/processExited' });
    });
    await Promise.race([
      this.rpc('initialize', {
        clientInfo: { name: 'foundry_customer_experiment', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Provider initialization timeout.')),
          15_000,
        );
        timer.unref();
      }),
    ]);
    this.send({ method: 'initialized' });
    this.startupMs = performance.now() - began;
  }
  readonly native: CustomerAgent = async (task, _checkpoint, supplied) => {
    if (this.running) throw new Error('Experiment provider supports one request at a time.');
    const input = customerInput.parse(task.input);
    const context = this.options.context();
    authorizeContext(context, input); // denial occurs before any inference or data access
    const observer =
      supplied ??
      new TrajectoryObserver({
        input,
        context,
        adapters: this.options.adapters,
        agentId: this.options.agentId,
        provider,
        model,
        apiCallsKnown: true,
      });
    const ledger = new UsageLedger(observer);
    this.running = true;
    let responseStarted = performance.now();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let stage = 'thread/start';
    let final = '';
    let timer: ReturnType<typeof setTimeout>;
    let rejectTurn: (error: Error) => void = () => {};
    try {
      const done = new Promise<void>((resolve, reject) => {
        rejectTurn = reject;
        timer = setTimeout(() => reject(new Error('Provider turn timeout.')), this.timeoutMs);
        this.onMessage = (message) => {
          const p = message.params;
          if (p?.threadId && threadId && p.threadId !== threadId) return;
          if (message.method === 'item/tool/call') {
            void executeTool(observer, String(p?.tool), p?.arguments).then(
              (result) =>
                this.send({
                  id: message.id,
                  result: {
                    contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
                    success: true,
                  },
                }),
              () => {
                this.send({
                  id: message.id,
                  result: {
                    contentItems: [{ type: 'inputText', text: 'Authorized read failed.' }],
                    success: false,
                  },
                });
                reject(new Error('Agent tool request failed.'));
              },
            );
          } else if (message.id !== undefined && message.method) {
            this.send({
              id: message.id,
              error: { code: -32601, message: 'Experiment permits only the three read tools.' },
            });
            reject(new Error('Unexpected provider tool or approval request.'));
          } else if (message.method === 'thread/tokenUsage/updated') {
            try {
              ledger.accept(p?.tokenUsage, responseStarted, performance.now());
              responseStarted = performance.now();
            } catch {
              reject(new Error('Provider usage accounting failed.'));
            }
          } else if (
            message.method === 'item/completed' &&
            p?.item?.type === 'agentMessage' &&
            p.item.phase !== 'commentary'
          ) {
            final = String(p.item.text);
          } else if (message.method === 'model/rerouted') {
            this.reroutes++;
            reject(new Error('Provider changed the pinned model.'));
          } else if (message.method === 'warning' || message.method === 'error') {
            this.warnings++; // no raw error/reasoning text is retained
            if (message.method === 'error')
              reject(new Error('Provider reported a transport or inference error.'));
          } else if (message.method === 'turn/completed') {
            if (p?.turn?.status === 'completed') resolve();
            else reject(new Error('Provider turn failed.'));
          } else if (message.method === 'experiment/processExited')
            reject(new Error('Provider exited during request.'));
        };
      });
      // Avoid leaking an unhandled rejection if thread/start fails before awaiting completion.
      void done.catch(() => {});
      const thread = await this.rpc('thread/start', {
        model,
        modelProvider: 'openai',
        allowProviderModelFallback: false,
        serviceTier: 'default',
        cwd: this.cwd,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: true,
        environments: [],
        dynamicTools: tools,
        baseInstructions:
          'You retrieve customer context using supplied read tools. Return complete data faithfully. Do not invent values. Use only tools needed to complete the task. Return the required JSON object without commentary.',
        developerInstructions:
          'The application binds every tool to the authorized customerId. No tool arguments are needed. You may call independent reads together.',
      });
      threadId = thread.thread.id;
      if (thread.model !== model) throw new Error('Provider did not accept the pinned model.');
      stage = 'turn/start';
      const turn = await this.rpc('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: `Load the complete customer context for ${input.customerId}: customer, all orders, and complete refund history.`,
          },
        ],
        effort: 'none',
        summary: 'none',
        serviceTierForTurn: 'default',
        outputSchema: z.toJSONSchema(fullContextSchema),
      });
      turnId = turn.turn.id;
      stage = 'provider completion/usage';
      await done;
      if (!ledger.responses)
        throw new Error('No provider-reported usage; refusing estimated tokens.');
      stage = 'final JSON validation';
      const result = fullContextSchema.parse(JSON.parse(final));
      const trace = observer.finish(result);
      this.options.onRun?.({
        measurement: structuredClone(trace.measurement),
        status: 'success',
        responses: ledger.responses,
        apiEquivalentCostUsd: apiEquivalentCost(
          observer.measurement.inputTokens!,
          observer.measurement.cachedInputTokens!,
          observer.measurement.outputTokens!,
        ),
      });
      return {
        resolved: true,
        summary: 'Provider-backed customer context.',
        llmInvocations: ledger.responses,
        tokens: observer.measurement.totalTokens!,
        measurement: trace.measurement,
        result,
      };
    } catch (error) {
      this.lastFailure = `${stage}: ${error instanceof Error && /^(Provider|No provider|Unexpected|Agent tool)/.test(error.message) ? error.message : 'Boundary validation failed.'}`;
      rejectTurn(new Error('Experiment request aborted.'));
      if (threadId && turnId)
        await this.rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
      const measured = incompleteProviderMeasurement(observer.finishFailure().measurement!);
      this.options.onRun?.({
        measurement: structuredClone(measured),
        status: 'failed',
        responses: ledger.responses,
        apiEquivalentCostUsd: null,
      });
      throw new AgentExecutionError(measured);
    } finally {
      clearTimeout(timer!);
      this.onMessage = undefined;
      this.running = false;
      if (threadId) await this.rpc('thread/archive', { threadId }).catch(() => {});
    }
  };
  async close() {
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([
        new Promise<void>((resolve) => this.child!.once('exit', () => resolve())),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.child?.kill('SIGKILL');
            resolve();
          }, 5000);
          timer.unref();
        }),
      ]);
    }
    rmSync(this.cwd, { recursive: true, force: true });
  }
}
