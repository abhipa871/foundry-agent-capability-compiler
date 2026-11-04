import { describe, expect, it, vi } from 'vitest';
import {
  ModelClient,
  normalizeModelUsage,
  sumModelUsage,
  type ModelProvider,
} from '../../src/agent/providers.js';

const tool = {
  name: 'get_weather',
  description: 'Read weather.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};
const usage = {
  prompt_tokens: 100,
  completion_tokens: 25,
  total_tokens: 125,
  prompt_tokens_details: { cached_tokens: 20 },
};
const responseUsage = {
  input_tokens: 100,
  output_tokens: 25,
  total_tokens: 125,
  input_tokens_details: { cached_tokens: 20 },
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('model-independent provider transport', () => {
  it('removes completed tools only when the application requests one call per tool name', async () => {
    const bodies: any[] = [];
    const client = new ModelClient({
      provider: 'openrouter',
      model: 'vendor/new-model',
      apiKey: () => 'fake',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return response({
          choices: [
            {
              finish_reason: body.tools ? 'tool_calls' : 'stop',
              message: body.tools
                ? {
                    tool_calls: [
                      { id: 'c1', function: { name: tool.name, arguments: '{"city":"Boston"}' } },
                    ],
                  }
                : { content: 'Rain' },
            },
          ],
          usage,
        });
      },
    });
    const result = await client.run({
      instructions: '',
      prompt: '',
      tools: [tool],
      execute: async () => ({ rain: true }),
      toolCallPolicy: 'once_per_name',
    });
    expect(result.text).toBe('Rain');
    expect(bodies[0].tools).toHaveLength(1);
    expect(bodies[1].tools).toBeUndefined();
  });
  for (const provider of [
    'openai',
    'moonshot',
    'anthropic',
    'gemini',
    'xai',
    'openrouter',
  ] as ModelProvider[]) {
    it(`preserves ${provider} tool continuation and reports all response tokens`, async () => {
      const bodies: any[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        const first = bodies.length === 1;
        if (provider === 'gemini')
          return response({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: first
                    ? [
                        {
                          functionCall: { id: 'c1', name: 'get_weather', args: { city: 'Boston' } },
                          thoughtSignature: 'opaque-signature',
                        },
                      ]
                    : [{ text: '{"rain":true}' }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 15,
              thoughtsTokenCount: 10,
              totalTokenCount: 125,
            },
          });
        if (provider === 'anthropic')
          return response({
            content: first
              ? [{ type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Boston' } }]
              : [{ type: 'text', text: '{"rain":true}' }],
            stop_reason: first ? 'tool_use' : 'end_turn',
            usage: {
              input_tokens: 70,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 10,
              output_tokens: 25,
            },
          });
        if (['openai', 'xai'].includes(provider))
          return response({
            status: 'completed',
            output: first
              ? [
                  { type: 'reasoning', id: 'r1', encrypted_content: 'opaque' },
                  {
                    type: 'function_call',
                    call_id: 'c1',
                    name: 'get_weather',
                    arguments: '{"city":"Boston"}',
                  },
                ]
              : [{ type: 'message', content: [{ type: 'output_text', text: '{"rain":true}' }] }],
            usage: responseUsage,
          });
        return response({
          choices: [
            {
              finish_reason: first ? 'tool_calls' : 'stop',
              message: first
                ? {
                    role: 'assistant',
                    reasoning_content: 'opaque',
                    content: null,
                    tool_calls: [
                      {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"city":"Boston"}' },
                      },
                    ],
                  }
                : { role: 'assistant', content: '{"rain":true}' },
            },
          ],
          usage,
        });
      });
      const client = new ModelClient({
        provider,
        model: 'any-future-tool-model/version',
        apiKey: () => 'fake-credential',
        fetch: fetchMock,
      });
      const execute = vi.fn(async () => ({ rain: true }));
      const result = await client.run({
        instructions: 'Use provided evidence.',
        prompt: 'Weather in Boston?',
        tools: [tool],
        execute,
      });
      expect(execute).toHaveBeenCalledExactlyOnceWith('get_weather', { city: 'Boston' });
      expect(result.text).toBe('{"rain":true}');
      expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 50, totalTokens: 250 });
      expect(result.events).toHaveLength(2);
      const second = JSON.stringify(bodies[1]);
      expect(second).toContain('c1');
      expect(second).toContain('rain');
      if (provider === 'gemini') expect(second).toContain('opaque-signature');
      if (provider === 'moonshot') expect(second).toContain('reasoning_content');
      if (['openai', 'xai'].includes(provider)) expect(second).toContain('encrypted_content');
      expect(JSON.stringify(result)).not.toContain('fake-credential');
    });
  }
  it('refuses unknown tools before execution, retains failure usage as unknown, and bounds repeated calls', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const client = new ModelClient({
      provider: 'openrouter',
      model: 'vendor/arbitrary',
      apiKey: () => 'fake',
      fetch: async () =>
        response({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  { id: 'c1', function: { name: 'delete_everything', arguments: '{}' } },
                ],
              },
            },
          ],
          usage,
        }),
    });
    await expect(
      client.run({ instructions: '', prompt: '', tools: [tool], execute }),
    ).rejects.toThrow('unauthorized');
    expect(execute).not.toHaveBeenCalled();
    const events: any[] = [];
    const failed = new ModelClient({
      provider: 'openai',
      model: 'any-model',
      apiKey: () => 'fake-secret',
      fetch: async () => new Response('provider echoed fake-secret', { status: 429 }),
    });
    await expect(
      failed.run({
        instructions: '',
        prompt: '',
        tools: [],
        execute,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('usage may be unknown');
    expect(sumModelUsage(events).totalTokens).toBeNull();
    expect(JSON.stringify(events)).not.toContain('fake-secret');
    const repeats = new ModelClient({
      provider: 'openrouter',
      model: 'vendor/arbitrary',
      apiKey: () => 'fake',
      fetch: async () =>
        response({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  { id: 'c1', function: { name: tool.name, arguments: '{"city":"Boston"}' } },
                ],
              },
            },
          ],
          usage,
        }),
    });
    await expect(
      repeats.run({ instructions: '', prompt: '', tools: [tool], execute, maxModelCalls: 2 }),
    ).rejects.toThrow('response budget');
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('supports OpenAI chat mode and OpenRouter discovery without model allowlists', async () => {
    const mock = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/models')
        ? response({
            data: [
              { id: 'vendor/new-model', supported_parameters: ['tools'] },
              { id: 'vendor/no-tools', supported_parameters: [] },
            ],
          })
        : response({ choices: [{ finish_reason: 'stop', message: { content: 'hello' } }], usage }),
    );
    const router = new ModelClient({
      provider: 'openrouter',
      model: 'vendor/new-model',
      apiKey: () => 'fake',
      fetch: mock,
    });
    expect(await router.models()).toEqual([
      { id: 'vendor/new-model', supportsTools: true },
      { id: 'vendor/no-tools', supportsTools: false },
    ]);
    const client = new ModelClient({
      provider: 'openai',
      protocol: 'chat',
      model: 'legacy-tools-model',
      apiKey: () => 'fake',
      fetch: mock,
    });
    await client.run({ instructions: '', prompt: '', tools: [], execute: async () => null });
    expect(String(mock.mock.calls.at(-1)?.[0])).toContain('/chat/completions');
    expect(
      normalizeModelUsage('gemini', {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 30,
        totalTokenCount: 150,
      }),
    ).toMatchObject({ totalTokens: 150, outputTokens: 50, reasoningTokens: 30 });
  });
});
