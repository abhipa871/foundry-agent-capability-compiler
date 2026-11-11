import { z } from 'zod';
import { json, stable, type Json } from '../compiler/contracts.js';

export const providerNames = [
  'openai',
  'moonshot',
  'anthropic',
  'gemini',
  'xai',
  'openrouter',
] as const;
export type ModelProvider = (typeof providerNames)[number];
export type ModelTool = { name: string; description: string; inputSchema: Json };
export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
};
export type ModelEvent = {
  failure?: { kind: 'http' | 'timeout' | 'transport'; httpStatus: number | null };
  usage: ModelUsage;
  latencyMs: number;
  status: 'success' | 'failed';
  toolNames?: string[];
};
export type ModelConfig = {
  provider: ModelProvider;
  model: string;
  // Credentials are supplied by trusted server code and never enter artifacts or telemetry.
  apiKey?: () => string;
  protocol?: 'responses' | 'chat';
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
};
const settings: Record<ModelProvider, { base: string; env: string }> = {
  openai: { base: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
  moonshot: { base: 'https://api.moonshot.ai/v1', env: 'MOONSHOT_API_KEY' },
  anthropic: { base: 'https://api.anthropic.com/v1', env: 'ANTHROPIC_API_KEY' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta', env: 'GEMINI_API_KEY' },
  xai: { base: 'https://api.x.ai/v1', env: 'XAI_API_KEY' },
  openrouter: { base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY' },
};
type Wire = Record<string, any>;
const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const sum = (...values: (number | null)[]) =>
  values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + value!, 0);
export function normalizeModelUsage(
  provider: ModelProvider,
  raw: Wire,
  protocol?: string,
): ModelUsage {
  let input: number | null;
  let output: number | null;
  let cached: number | null;
  let total: number | null;
  let reasoning: number | null;
  if (provider === 'gemini') {
    input = count(raw.promptTokenCount);
    total = count(raw.totalTokenCount);
    output = input !== null && total !== null ? total - input : null;
    cached = count(raw.cachedContentTokenCount ?? 0);
    reasoning = count(raw.thoughtsTokenCount ?? 0);
  } else if (provider === 'anthropic') {
    cached = count(raw.cache_read_input_tokens ?? 0);
    input = sum(count(raw.input_tokens), cached, count(raw.cache_creation_input_tokens ?? 0));
    output = count(raw.output_tokens);
    total = sum(input, output);
    reasoning = null;
  } else {
    input = count(raw.input_tokens ?? raw.prompt_tokens);
    total = count(raw.total_tokens);
    output = count(raw.output_tokens ?? raw.completion_tokens);
    if (total === null) total = sum(input, output);
    cached = count(
      raw.input_tokens_details?.cached_tokens ??
        raw.prompt_tokens_details?.cached_tokens ??
        raw.prompt_cache_hit_tokens ??
        0,
    );
    reasoning = count(
      raw.output_tokens_details?.reasoning_tokens ??
        raw.completion_tokens_details?.reasoning_tokens ??
        0,
    );
    if (input !== null && total !== null) output = total - input;
  }
  if ((output !== null && output < 0) || (cached !== null && input !== null && cached > input))
    throw new Error('Provider reported inconsistent token usage.');
  void protocol;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    totalTokens: total,
    reasoningTokens: reasoning,
  };
}
export function sumModelUsage(events: readonly ModelEvent[]): ModelUsage {
  const keys = [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'totalTokens',
    'reasoningTokens',
  ] as const;
  return Object.fromEntries(
    keys.map((key) => [key, sum(...events.map((event) => event.usage[key]))]),
  ) as ModelUsage;
}
const unknownUsage = (): ModelUsage => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  totalTokens: null,
  reasoningTokens: null,
});

export function geminiParametersJsonSchema(value: Json): Json {
  const schema = json(value) as Wire;
  if (!schema || typeof schema !== 'object' || !schema.$defs) return schema;
  for (const [name, definition] of Object.entries(schema.$defs)) {
    const reference = { $ref: `#/$defs/${name}` };
    const anyJson = {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
        { type: 'array', items: reference },
        { type: 'object', propertyNames: { type: 'string' }, additionalProperties: reference },
      ],
    };
    // Zod's unconstrained JSON union is equivalent to {} over JSON wire values. Only this
    // exact shape is simplified; application-specific recursive constraints stay intact.
    if (stable(definition) === stable(anyJson)) schema.$defs[name] = {};
  }
  return schema;
}

export function publicGeminiExchange(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter((item) => !(item && typeof item === 'object' && (item as Wire).thought === true))
      .map(publicGeminiExchange);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'thoughtSignature' && key !== 'thought')
        .map(([key, item]) => [key, publicGeminiExchange(item)]),
    );
  return value;
}

class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`Provider API returned HTTP ${status}.`);
  }
}

export class ModelClient {
  private readonly provider: ModelProvider;
  private readonly model: string;
  constructor(private readonly config: ModelConfig) {
    this.provider = z.enum(providerNames).parse(config.provider);
    // Model IDs are open-ended. The provider decides availability and tool support.
    this.model = z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)
      .parse(config.model);
  }
  private headers(): Record<string, string> {
    const key = this.config.apiKey?.() ?? process.env[settings[this.provider].env];
    if (!key) throw new Error(`Missing ${settings[this.provider].env}.`);
    if (/[\r\n]/.test(key)) throw new Error('Invalid provider credential.');
    return this.provider === 'gemini'
      ? { 'x-goog-api-key': key, 'content-type': 'application/json' }
      : this.provider === 'anthropic'
        ? {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          }
        : { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  }
  private async request(path: string, body?: unknown): Promise<Wire> {
    const response = await (this.config.fetch ?? fetch)(`${settings[this.provider].base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderHttpError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Provider returned no body.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 2097152) throw new Error('Provider response exceeds budget.');
        chunks.push(next.value);
      }
      return z
        .record(z.string(), z.any())
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async models(): Promise<{ id: string; supportsTools: boolean | null }[]> {
    const raw = await this.request('/models');
    const entries = z.array(z.record(z.string(), z.any())).parse(raw.data ?? raw.models);
    return entries.map((entry) => ({
      id: String(entry.id ?? entry.name).replace(/^models\//, ''),
      supportsTools:
        this.provider === 'openrouter' && Array.isArray(entry.supported_parameters)
          ? entry.supported_parameters.includes('tools')
          : null,
    }));
  }
  async run(options: {
    instructions: string;
    prompt: string;
    tools: ModelTool[];
    execute: (name: string, args: Json) => Promise<Json>;
    outputSchema?: Json;
    maxModelCalls?: number;
    maxToolCalls?: number;
    maxTotalTokens?: number;
    onEvent?: (event: ModelEvent) => void;
    beforeRequest?: () => void;
    // Gemini public request/response transcripts only: private thought parts and signatures
    // are removed before observation. Credentials are in headers and never passed here.
    onGeminiExchange?: (exchange: {
      at: string;
      request: unknown;
      response: unknown;
      status: 'success' | 'failed';
    }) => void;
    toolCallPolicy?: 'repeatable' | 'once_per_name';
  }): Promise<{ text: string; usage: ModelUsage; events: ModelEvent[]; toolCalls: number }> {
    const events: ModelEvent[] = [];
    const provider = this.provider;
    const protocol =
      this.config.protocol ?? (['openai', 'xai'].includes(provider) ? 'responses' : 'chat');
    const messages: Wire[] = [{ role: 'user', content: options.prompt }];
    const contents: Wire[] = [{ role: 'user', parts: [{ text: options.prompt }] }];
    const responsesInput: Wire[] = [{ role: 'user', content: options.prompt }];
    const allSchemas = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    if (new Set(allSchemas.map((tool) => tool.name)).size !== allSchemas.length)
      throw new Error('Duplicate model tools.');
    let toolCalls = 0;
    const completedTools = new Set<string>();
    const limit = z
      .number()
      .int()
      .min(1)
      .max(32)
      .parse(options.maxModelCalls ?? 8);
    const maxTools = z
      .number()
      .int()
      .min(0)
      .max(128)
      .parse(options.maxToolCalls ?? 32);
    for (let index = 0; index < limit; index++) {
      options.beforeRequest?.();
      const schemas = allSchemas.filter(
        (tool) => options.toolCallPolicy !== 'once_per_name' || !completedTools.has(tool.name),
      );
      let body: Wire;
      let path: string;
      if (provider === 'gemini') {
        path = `/models/${encodeURIComponent(this.model)}:generateContent`;
        body = {
          systemInstruction: { parts: [{ text: options.instructions }] },
          contents,
          ...(schemas.length
            ? {
                tools: [
                  {
                    functionDeclarations: schemas.map(({ parameters, ...tool }) => ({
                      ...tool,
                      parametersJsonSchema: geminiParametersJsonSchema(parameters),
                    })),
                  },
                ],
              }
            : {}),
          generationConfig: {
            maxOutputTokens: this.config.maxOutputTokens ?? 4096,
            ...(this.config.temperature === undefined
              ? {}
              : { temperature: z.number().min(0).max(2).parse(this.config.temperature) }),
            ...(options.outputSchema
              ? { responseMimeType: 'application/json', responseJsonSchema: options.outputSchema }
              : {}),
          },
        };
      } else if (provider === 'anthropic') {
        path = '/messages';
        body = {
          model: this.model,
          system: options.instructions,
          messages,
          max_tokens: this.config.maxOutputTokens ?? 4096,
          ...(schemas.length
            ? {
                tools: schemas.map(({ parameters, ...tool }) => ({
                  ...tool,
                  input_schema: parameters,
                })),
              }
            : {}),
        };
      } else if (protocol === 'responses') {
        path = '/responses';
        body = {
          model: this.model,
          instructions: options.instructions,
          input: responsesInput,
          store: false,
          ...(provider === 'openai' ? { include: ['reasoning.encrypted_content'] } : {}),
          max_output_tokens: this.config.maxOutputTokens ?? 4096,
          ...(schemas.length
            ? { tools: schemas.map((tool) => ({ type: 'function', ...tool, strict: false })) }
            : {}),
        };
      } else {
        path = '/chat/completions';
        body = {
          model: this.model,
          messages: [{ role: 'system', content: options.instructions }, ...messages],
          ...(schemas.length
            ? { tools: schemas.map((tool) => ({ type: 'function', function: tool })) }
            : {}),
          max_tokens: this.config.maxOutputTokens ?? 4096,
        };
      }
      const started = performance.now();
      let raw: Wire;
      try {
        raw = await this.request(path, body);
      } catch (error) {
        const failure: NonNullable<ModelEvent['failure']> = {
          kind:
            error instanceof ProviderHttpError
              ? 'http'
              : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
                ? 'timeout'
                : 'transport',
          httpStatus: error instanceof ProviderHttpError ? error.status : null,
        };
        if (provider === 'gemini')
          options.onGeminiExchange?.({
            at: new Date().toISOString(),
            request: publicGeminiExchange(body),
            response: { error: failure },
            status: 'failed',
          });
        const event: ModelEvent = {
          usage: unknownUsage(),
          latencyMs: performance.now() - started,
          status: 'failed',
          failure,
        };
        events.push(event);
        options.onEvent?.(event);
        throw new Error(`${provider} inference failed; usage may be unknown.`);
      }
      if (provider === 'gemini')
        options.onGeminiExchange?.({
          at: new Date().toISOString(),
          request: publicGeminiExchange(body),
          response: publicGeminiExchange(raw),
          status: 'success',
        });
      const event: ModelEvent = {
        usage: normalizeModelUsage(provider, raw.usageMetadata ?? raw.usage ?? {}, protocol),
        latencyMs: performance.now() - started,
        status: 'success',
      };
      events.push(event);
      options.onEvent?.(event);
      const usage = sumModelUsage(events);
      if (usage.totalTokens !== null && usage.totalTokens > (options.maxTotalTokens ?? 100000))
        throw new Error('Model token budget exceeded.');
      let calls: { id: string; name: string; args: Json }[] = [];
      let text = '';
      if (provider === 'gemini') {
        const candidate = raw.candidates?.[0];
        const content = candidate?.content;
        if (!content || !Array.isArray(content.parts)) throw new Error('Invalid Gemini content.');
        if (candidate.finishReason && candidate.finishReason !== 'STOP')
          throw new Error('Gemini response incomplete.');
        contents.push(content);
        calls = content.parts
          .filter((part: Wire) => part.functionCall)
          .map((part: Wire, i: number) => ({
            id: part.functionCall.id ?? `call_${i}`,
            name: part.functionCall.name,
            args: json(part.functionCall.args ?? {}),
          }));
        text = content.parts
          .filter((part: Wire) => !part.thought)
          .map((part: Wire) => part.text ?? '')
          .join('');
      } else if (provider === 'anthropic') {
        if (!Array.isArray(raw.content) || ['max_tokens', 'refusal'].includes(raw.stop_reason))
          throw new Error('Claude response incomplete.');
        messages.push({ role: 'assistant', content: raw.content });
        calls = raw.content
          .filter((part: Wire) => part.type === 'tool_use')
          .map((part: Wire) => ({ id: part.id, name: part.name, args: json(part.input) }));
        text = raw.content
          .filter((part: Wire) => part.type === 'text')
          .map((part: Wire) => part.text)
          .join('');
      } else if (protocol === 'responses') {
        if (!Array.isArray(raw.output) || (raw.status && raw.status !== 'completed'))
          throw new Error('Responses result incomplete.');
        responsesInput.push(...raw.output);
        calls = raw.output
          .filter((part: Wire) => part.type === 'function_call')
          .map((part: Wire) => ({
            id: part.call_id,
            name: part.name,
            args: json(JSON.parse(part.arguments)),
          }));
        text = raw.output
          .filter((part: Wire) => part.type === 'message')
          .flatMap((part: Wire) => part.content ?? [])
          .filter((part: Wire) => part.type === 'output_text')
          .map((part: Wire) => part.text)
          .join('');
      } else {
        const choice = raw.choices?.[0];
        const message = choice?.message;
        if (!message || !['stop', 'tool_calls'].includes(choice.finish_reason))
          throw new Error('Chat result incomplete.');
        messages.push(message);
        calls = (message.tool_calls ?? []).map((call: Wire) => ({
          id: call.id,
          name: call.function?.name,
          args: json(JSON.parse(call.function.arguments)),
        }));
        text = message.content ?? '';
      }
      event.toolNames = calls.map((call) => call.name);
      if (!calls.length) {
        if (!text.trim()) throw new Error('Model produced no final answer.');
        return { text, usage, events, toolCalls };
      }
      if (toolCalls + calls.length > maxTools) throw new Error('Model tool budget exceeded.');
      const ids = new Set<string>();
      for (const call of calls) {
        if (
          typeof call.id !== 'string' ||
          !call.id ||
          ids.has(call.id) ||
          !schemas.some((tool) => tool.name === call.name)
        )
          throw new Error('Invalid or unauthorized model tool call.');
        ids.add(call.id);
      }
      toolCalls += calls.length;
      const results = await Promise.all(
        calls.map(async (call) => ({
          ...call,
          result: json(await options.execute(call.name, call.args)),
        })),
      );
      results.forEach((call) => completedTools.add(call.name));
      if (provider === 'gemini')
        contents.push({
          role: 'user',
          parts: results.map((call) => ({
            functionResponse: { id: call.id, name: call.name, response: { result: call.result } },
          })),
        });
      else if (provider === 'anthropic')
        messages.push({
          role: 'user',
          content: results.map((call) => ({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(call.result),
          })),
        });
      else if (protocol === 'responses')
        responsesInput.push(
          ...results.map((call) => ({
            type: 'function_call_output',
            call_id: call.id,
            output: JSON.stringify(call.result),
          })),
        );
      else
        messages.push(
          ...results.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(call.result),
          })),
        );
    }
    throw new Error('Model response budget exceeded.');
  }
}
