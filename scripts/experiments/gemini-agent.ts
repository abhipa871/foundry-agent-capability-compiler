import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { TrajectoryObserver } from '../../src/exploration/observe.js';
import type { Measurement } from '../../src/telemetry/measurement.js';

export const geminiProvider = 'google-gemini-api';
export const geminiModel = process.env.FOUNDRY_GEMINI_MODEL ?? 'gemini-3.8-flash';

const usageSchema = z
  .object({
    promptTokenCount: z.number().int().nonnegative(),
    candidatesTokenCount: z.number().int().nonnegative().default(0),
    cachedContentTokenCount: z.number().int().nonnegative().default(0),
    thoughtsTokenCount: z.number().int().nonnegative().default(0),
    totalTokenCount: z.number().int().nonnegative(),
  })
  .passthrough();

const functionCallSchema = z
  .object({
    id: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

type GeminiPart = {
  text?: string;
  functionCall?: z.infer<typeof functionCallSchema>;
  thoughtSignature?: string;
  [key: string]: unknown;
};

const responseSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            finishReason: z.string().optional(),
            content: z
              .object({
                role: z.string().optional(),
                parts: z.array(z.record(z.string(), z.unknown())),
              })
              .optional(),
          })
          .passthrough(),
      )
      .min(1),
    usageMetadata: usageSchema,
  })
  .passthrough();

export type GeminiTool = {
  type: 'function';
  name: string;
  description: string;
  inputSchema: unknown;
};

export type GeminiUsage = {
  inputTokens: number;
  candidateTokens: number;
  thoughtTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

export type GeminiRun<T> = {
  result: T;
  measurement: Measurement;
  usage: GeminiUsage;
  toolCalls: { name: string; status: 'success' | 'failed'; latencyMs: number }[];
  providerRequests: number;
};

function functionSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(functionSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['additionalProperties', '$schema'].includes(key))
      .map(([key, entry]) => [key, functionSchema(entry)]),
  );
}

export class GeminiAgent {
  private readonly apiKey: string;
  private readonly endpoint: string;
  constructor(
    private readonly options: {
      model?: string;
      timeoutMs?: number;
      maxModelCalls?: number;
      maxToolCalls?: number;
    } = {},
  ) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is required for the live benchmark.');
    this.apiKey = key;
    const model = options.model ?? geminiModel;
    if (!/^[a-z0-9][a-z0-9._-]{1,80}$/.test(model)) throw new Error('Invalid Gemini model ID.');
    this.endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  }

  async runTask<T>(task: {
    observer: TrajectoryObserver;
    tools: GeminiTool[];
    executeTool: (observer: TrajectoryObserver, name: string, args: unknown) => Promise<unknown>;
    prompt: string;
    instructions: string;
    outputSchema: unknown;
    parseResult: (raw: unknown) => T;
    complete: (result: T, observer: TrajectoryObserver) => Measurement;
  }): Promise<GeminiRun<T>> {
    const contents: Record<string, unknown>[] = [{ role: 'user', parts: [{ text: task.prompt }] }];
    const toolCalls: GeminiRun<T>['toolCalls'] = [];
    const usage: GeminiUsage = {
      inputTokens: 0,
      candidateTokens: 0,
      thoughtTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
    };
    let providerRequests = 0;
    const maxModelCalls = this.options.maxModelCalls ?? 6;
    const maxToolCalls = this.options.maxToolCalls ?? 10;

    for (let responseIndex = 0; responseIndex < maxModelCalls; responseIndex++) {
      const startedAt = performance.now();
      const response = await this.request({
        systemInstruction: { parts: [{ text: task.instructions }] },
        contents,
        ...(task.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: task.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: functionSchema(tool.inputSchema),
                  })),
                },
              ],
            }
          : {}),
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: task.outputSchema,
          temperature: 0,
        },
      });
      providerRequests += 1;
      const completedAt = performance.now();
      const reported = response.usageMetadata;
      const normalizedOutput = reported.totalTokenCount - reported.promptTokenCount;
      if (normalizedOutput < 0)
        throw new Error('Gemini usage total is smaller than its prompt token count.');
      task.observer.recordModelResponse(
        {
          inputTokens: reported.promptTokenCount,
          outputTokens: normalizedOutput,
          cachedInputTokens: reported.cachedContentTokenCount,
        },
        startedAt,
        completedAt,
      );
      usage.inputTokens += reported.promptTokenCount;
      usage.candidateTokens += reported.candidatesTokenCount;
      usage.thoughtTokens += reported.thoughtsTokenCount;
      usage.cachedInputTokens += reported.cachedContentTokenCount;
      usage.totalTokens += reported.totalTokenCount;

      const candidate = response.candidates[0];
      if (!candidate.content?.parts?.length) throw new Error('Gemini returned no content parts.');
      const modelParts = candidate.content.parts as GeminiPart[];
      const calls = modelParts.flatMap((part) =>
        part.functionCall ? [functionCallSchema.parse(part.functionCall)] : [],
      );
      if (calls.length) {
        if (!task.tools.length) throw new Error('Gemini requested an unavailable tool.');
        if (toolCalls.length + calls.length > maxToolCalls)
          throw new Error('Gemini tool-call budget exceeded.');
        contents.push({ role: 'model', parts: modelParts });
        const responses = await Promise.all(
          calls.map(async (call) => {
            const tool = task.tools.find((entry) => entry.name === call.name);
            if (!tool) throw new Error('Gemini requested a tool outside the allowlist.');
            const began = performance.now();
            const ledger = { name: call.name, status: 'success' as const, latencyMs: 0 };
            try {
              const result = await task.executeTool(task.observer, call.name, call.args);
              ledger.latencyMs = performance.now() - began;
              toolCalls.push(ledger);
              return {
                functionResponse: {
                  ...(call.id ? { id: call.id } : {}),
                  name: call.name,
                  response: { result },
                },
              };
            } catch (error) {
              const failed = {
                name: call.name,
                status: 'failed' as const,
                latencyMs: performance.now() - began,
              };
              toolCalls.push(failed);
              throw error;
            }
          }),
        );
        contents.push({ role: 'user', parts: responses });
        continue;
      }

      const text = modelParts
        .map((part) => part.text ?? '')
        .join('')
        .trim();
      if (!text) throw new Error('Gemini returned neither tool calls nor final JSON.');
      const result = task.parseResult(JSON.parse(text));
      const measurement = task.complete(result, task.observer);
      measurement.apiCalls = providerRequests;
      measurement.toolCalls = task.observer.events.length;
      if (measurement.totalTokens !== usage.totalTokens)
        throw new Error('Gemini aggregate token usage did not reconcile.');
      return { result, measurement, usage, toolCalls, providerRequests };
    }
    throw new Error('Gemini model-call budget exceeded.');
  }

  private async request(body: unknown): Promise<z.infer<typeof responseSchema>> {
    let lastStatus = 0;
    let lastReason = 'provider rejected the request';
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        redirect: 'error',
      });
      lastStatus = response.status;
      if (response.ok) return responseSchema.parse(await response.json());
      const providerError = z
        .object({ error: z.object({ message: z.string() }).passthrough() })
        .safeParse(await response.json().catch(() => null));
      if (providerError.success)
        lastReason = providerError.data.error.message.replace(/[\r\n]+/g, ' ').slice(0, 300);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw new Error(`Gemini API request failed with HTTP ${lastStatus}: ${lastReason}`);
  }
}
