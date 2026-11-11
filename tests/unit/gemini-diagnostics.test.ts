import { expect, it, vi } from 'vitest';
import { diagnoseGemini } from '../../src/agent/gemini-diagnostics.js';
import { ModelClient } from '../../src/agent/providers.js';

it('enforces the application budget before sending another provider request', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  const client = new ModelClient({
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    apiKey: () => 'fake',
    fetch: fetchMock,
  });
  await expect(
    client.run({
      instructions: '',
      prompt: '',
      tools: [],
      execute: async () => null,
      beforeRequest: () => {
        throw new Error('Budget reached');
      },
    }),
  ).rejects.toThrow('Budget reached');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('uses the Developer API key header, pins the required model, and never reports credentials', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('synthetic-private-key');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    return new Response(
      JSON.stringify({
        error: { status: 'UNAUTHENTICATED', message: 'Rejected synthetic-private-key' },
      }),
      { status: 401 },
    );
  });
  const report = await diagnoseGemini({
    key: 'synthetic-private-key',
    fetch: fetchMock,
    inference: true,
  });
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
  ]);
  expect(report.discovery.httpStatus).toBe(401);
  expect(report.inference?.httpStatus).toBe(401);
  expect(JSON.stringify(report)).not.toContain('synthetic-private-key');
});

it('requires the specified model to be returned by actual discovery without inference by default', async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash' }] })),
  );
  const report = await diagnoseGemini({ key: 'fake', fetch: fetchMock });
  expect(report.discovery.requiredModelListed).toBe(true);
  expect(report.inference).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('passes the exact required model and identical explicit temperature to real transport construction', async () => {
  const exchanges: unknown[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig.temperature).toBe(0);
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('synthetic-test-key');
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'private thought' },
                { text: 'OK', thoughtSignature: 'private-signature' },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 2, totalTokenCount: 5, thoughtsTokenCount: 2 },
      }),
    );
  });
  const result = await new ModelClient({
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    temperature: 0,
    apiKey: () => 'synthetic-test-key',
    fetch: fetchMock,
  }).run({
    instructions: '',
    prompt: 'OK',
    tools: [],
    execute: async () => null,
    onGeminiExchange: (exchange) => exchanges.push(exchange),
  });
  expect(result.text).toBe('OK');
  expect(result.usage.outputTokens).toBe(3);
  expect(JSON.stringify(exchanges)).not.toContain('private thought');
  expect(JSON.stringify(exchanges)).not.toContain('private-signature');
  expect(JSON.stringify(exchanges)).not.toContain('synthetic-test-key');
});
