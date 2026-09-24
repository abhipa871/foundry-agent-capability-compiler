import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AgentProviderOption, CodingAgentEvent, CodingPolicy, TokenUsage } from '../domain.js';

export type CodexRun = {
  status: 'success' | 'failed';
  output: string;
  error?: string;
  events: CodingAgentEvent[];
  finalEventId?: string;
  usage: TokenUsage;
  durationMs: number;
};

export const agentProviders: AgentProviderOption[] = [
  {
    id: 'codex-cli-gpt-5-5-high',
    label: 'Codex CLI - GPT 5.5 High',
    kind: 'codex-cli',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    enabled: true,
    note: 'Local Codex CLI adapter. Uses the logged-in CLI account on this machine.',
  },
  {
    id: 'openai-responses-future',
    label: 'OpenAI Responses API',
    kind: 'future',
    model: 'configurable',
    reasoningEffort: 'medium',
    enabled: false,
    note: 'Placeholder for hosted API execution and model selection.',
  },
  {
    id: 'custom-provider-future',
    label: 'Custom provider',
    kind: 'future',
    model: 'configurable',
    reasoningEffort: 'medium',
    enabled: false,
    note: 'Placeholder for BYO model gateway.',
  },
];

export function providerById(id?: string) {
  return agentProviders.find((provider) => provider.id === id) ?? agentProviders[0];
}

export async function runCodexTask(
  task: string,
  options: {
    provider: AgentProviderOption;
    cwd: string;
    deployment?: boolean;
    timeoutMs?: number;
    policy?: CodingPolicy;
  },
): Promise<CodexRun> {
  if (options.provider.kind !== 'codex-cli' || !options.provider.enabled) {
    return dryRun(
      task,
      options.provider,
      'Selected provider is not enabled yet.',
      options.deployment,
    );
  }
  if (process.env.FOUNDRY_CODEX_DRY_RUN === 'true') {
    return dryRun(task, options.provider, undefined, options.deployment);
  }
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const prompt = buildPrompt(task, options.deployment);
  const args = buildCodexExecArgs(options.provider, options.cwd, options.policy);
  const launch = codexLaunch();
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(launch.command, [...launch.argsPrefix, ...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex CLI failed to launch.';
      const usage = estimateUsage(prompt, message);
      const event = eventFromRun('codex.launch', 'failed', startedAt, usage, message);
      resolve({
        status: 'failed',
        output: '',
        error: message,
        events: [event],
        usage,
        durationMs: performance.now() - start,
      });
      return;
    }
    let stopReason: string | undefined;
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
        }).on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => {
        stop('Codex CLI timed out. Review any partial file changes.');
      },
      options.timeoutMs ?? 10 * 60_000,
    );
    let outputBytes = 0;
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (stopReason) return;
      outputBytes += chunk.length;
      if (outputBytes > (options.policy?.maxOutputBytes ?? 2000000)) {
        stop('Codex CLI output limit exceeded.');
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.stdin.on('error', () => stop('Codex CLI closed its input unexpectedly.'));
    child.on('error', (error) => {
      clearTimeout(timer);
      const usage = estimateUsage(prompt, stdout + stderr);
      const event = eventFromRun('codex.exec', 'failed', startedAt, usage, error.message);
      resolve({
        status: 'failed',
        output: stdout,
        error: error.message,
        events: [event],
        usage,
        durationMs: performance.now() - start,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseJsonLines(stdout);
      const output = lastAssistantMessage(parsed) || stdout.trim();
      const usage = usageFromEvents(parsed) ?? estimateUsage(prompt, `${stdout}\n${stderr}`);
      const status = code === 0 && !stopReason ? 'success' : 'failed';
      if (stopReason) stderr = stopReason;
      const events = eventsFromCodex(parsed, startedAt, usage, status, stderr);
      resolve({
        status,
        output,
        error: status === 'failed' ? stderr.trim() || `Codex CLI exited with ${code}.` : undefined,
        events,
        finalEventId: status === 'success' ? events.at(-1)?.id : undefined,
        usage,
        durationMs: performance.now() - start,
      });
    });
    child.stdin.end(prompt);
  });
}

export function codexCommand() {
  return codexLaunch().command;
}

export function codexLaunch(): { command: string; argsPrefix: string[] } {
  if (process.env.FOUNDRY_CODEX_BIN) {
    return { command: process.env.FOUNDRY_CODEX_BIN, argsPrefix: [] };
  }
  const npmCodex = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : '';
  if (npmCodex && existsSync(npmCodex)) {
    return { command: process.execPath, argsPrefix: [npmCodex] };
  }
  return { command: process.platform === 'win32' ? 'codex.exe' : 'codex', argsPrefix: [] };
}

export function buildCodexExecArgs(
  provider: AgentProviderOption,
  cwd: string,
  policy?: CodingPolicy,
) {
  return [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    policy?.sandbox ?? 'workspace-write',
    ...(policy
      ? [
          '--ignore-user-config',
          '--ignore-rules',
          '--ephemeral',
          '-c',
          'sandbox_workspace_write.network_access=false',
          '-c',
          'sandbox_workspace_write.writable_roots=[]',
          '-c',
          'sandbox_workspace_write.exclude_tmpdir_env_var=true',
          '-c',
          'sandbox_workspace_write.exclude_slash_tmp=true',
          '-c',
          'web_search="disabled"',
        ]
      : []),
    '-m',
    provider.model,
    '-c',
    `model_reasoning_effort="${provider.reasoningEffort}"`,
    '-C',
    cwd,
    '-',
  ];
}

function buildPrompt(task: string, deployment?: boolean) {
  const mode = deployment ? 'DEPLOYMENT INVOCATION' : 'EXPLORATION INVOCATION';
  return [
    `You are running inside Foundry's coding-agent ${mode}.`,
    'Complete the user task in this repository. Keep changes scoped, run relevant checks if practical, and summarize files changed.',
    'At the end, include a short "Trajectory summary" with successful steps and any failed attempts that caused you to switch tools or approach.',
    '',
    `User task:\n${task}`,
  ].join('\n');
}

function dryRun(
  task: string,
  provider: AgentProviderOption,
  reason?: string,
  deployment?: boolean,
): CodexRun {
  const startedAt = new Date().toISOString();
  const output = deployment
    ? `Dry-run deployment completed for: ${task}`
    : `Dry-run coding agent completed for: ${task}`;
  const usage = deployment
    ? { inputTokens: 120, outputTokens: 36, totalTokens: 156, estimated: false }
    : { inputTokens: 420, outputTokens: 150, totalTokens: 570, estimated: false };
  const root = eventFromRun(
    'task.received',
    'success',
    startedAt,
    undefined,
    undefined,
    'Task accepted from chat.',
  );
  const failed = eventFromRun(
    'codex.initial_context_scan',
    'failed',
    startedAt,
    undefined,
    'Dry-run simulated an overly broad first scan.',
    'First approach was discarded.',
  );
  failed.parentId = root.id;
  const exec = eventFromRun(
    provider.kind === 'codex-cli' ? 'codex.exec' : 'provider.disabled',
    reason ? 'failed' : 'success',
    startedAt,
    usage,
    reason,
    output,
  );
  exec.parentId = root.id;
  return {
    status: reason ? 'failed' : 'success',
    output,
    error: reason,
    events: [root, failed, exec],
    finalEventId: reason ? undefined : exec.id,
    usage,
    durationMs: 25,
  };
}

function eventFromRun(
  operation: string,
  status: CodingAgentEvent['status'],
  startedAt: string,
  usage?: TokenUsage,
  error?: string,
  description = operation,
): CodingAgentEvent {
  return {
    id: `${operation.replace(/[^A-Za-z0-9_.:-]/g, '_')}-${randomUUID().slice(0, 8)}`,
    operation,
    status,
    transport: 'cli',
    description: description.slice(0, 250),
    error: error?.slice(0, 250),
    startedAt,
    endedAt: new Date().toISOString(),
    usage,
  };
}

function parseJsonLines(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function eventsFromCodex(
  items: unknown[],
  startedAt: string,
  usage: TokenUsage,
  status: CodexRun['status'],
  stderr: string,
): CodingAgentEvent[] {
  const root = eventFromRun(
    'task.received',
    'success',
    startedAt,
    undefined,
    undefined,
    'Task accepted from chat.',
  );
  const observedEvents = items
    .map((item, index) => eventFromJson(item, index, startedAt))
    .filter((event): event is CodingAgentEvent => event !== undefined);
  const events = observedEvents;
  const exec = eventFromRun(
    'codex.exec',
    status,
    startedAt,
    usage,
    status === 'failed' ? stderr.trim() || 'Codex CLI failed.' : undefined,
    status === 'success'
      ? 'Codex CLI completed the coding task.'
      : 'Codex CLI failed before completing the task.',
  );
  let previous = root.id;
  for (const event of [...events, exec]) {
    event.parentId = previous;
    previous = event.id;
  }
  return [root, ...events, exec];
}

function eventFromJson(
  item: unknown,
  index: number,
  startedAt: string,
): CodingAgentEvent | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  const type = String(record.type ?? record.event ?? record.kind ?? '');
  if (!type || type === 'token_count') return undefined;
  const detail =
    record.item && typeof record.item === 'object'
      ? (record.item as Record<string, unknown>)
      : record;
  const failed =
    type === 'error' ||
    type === 'turn.failed' ||
    detail.status === 'failed' ||
    (typeof detail.exit_code === 'number' && detail.exit_code !== 0) ||
    Boolean(detail.error);
  const pending = type.endsWith('.started') || detail.status === 'in_progress';
  return eventFromRun(
    `codex.${type}`,
    failed ? 'failed' : pending ? 'skipped' : 'success',
    startedAt,
    undefined,
    failed ? 'Codex event reported an error.' : undefined,
    typeof detail.command === 'string'
      ? detail.command
      : `Observed Codex event ${type} #${index + 1}.`,
  );
}

function lastAssistantMessage(items: unknown[]) {
  for (const item of items.toReversed()) {
    const text = textFrom(item);
    if (text) return text;
  }
  return '';
}

function textFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.type === 'agent_message' && typeof record.text === 'string') {
    return record.text;
  }
  if (record.type === 'item.completed' && record.item) {
    return textFrom(record.item);
  }
  for (const key of ['message', 'content', 'output', 'final_message']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (Array.isArray(candidate)) {
      for (const item of candidate.toReversed()) {
        const text = textFrom(item);
        if (text) return text;
      }
    }
    const nested = textFrom(candidate);
    if (nested) return nested;
  }
  return '';
}

function usageFromEvents(items: unknown[]): TokenUsage | undefined {
  let best: TokenUsage | undefined;
  for (const item of items) {
    const usage = usageFrom(item);
    if (usage && (!best || usage.totalTokens > best.totalTokens)) best = usage;
  }
  return best;
}

function usageFrom(value: unknown, depth = 0): TokenUsage | undefined {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  const record = value as Record<string, unknown>;
  const input = numberField(record, [
    'input_tokens',
    'prompt_tokens',
    'inputTokens',
    'promptTokens',
  ]);
  const output = numberField(record, [
    'output_tokens',
    'completion_tokens',
    'outputTokens',
    'completionTokens',
  ]);
  const total = numberField(record, ['total_tokens', 'totalTokens']);
  if (input !== undefined || output !== undefined || total !== undefined) {
    const inputTokens = input ?? Math.max(0, (total ?? 0) - (output ?? 0));
    const outputTokens = output ?? Math.max(0, (total ?? 0) - inputTokens);
    return {
      inputTokens,
      outputTokens,
      totalTokens: total ?? inputTokens + outputTokens,
      cachedInputTokens: numberField(record, ['cached_input_tokens', 'cachedInputTokens']),
      estimated: false,
    };
  }
  for (const child of Object.values(record)) {
    const usage = usageFrom(child, depth + 1);
    if (usage) return usage;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function estimateUsage(input: string, output: string): TokenUsage {
  const inputTokens = Math.max(1, Math.ceil(input.length / 4));
  const outputTokens = Math.max(1, Math.ceil(output.length / 4));
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
}
