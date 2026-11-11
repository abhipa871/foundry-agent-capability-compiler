export const geminiStressModel = 'gemini-3.8-flash';
const origin = 'https://generativelanguage.googleapis.com/v1beta';

export async function diagnoseGemini(options: {
  key: string;
  fetch?: typeof fetch;
  inference?: boolean;
}) {
  const request = async (path: string, body?: unknown) => {
    try {
      const response = await (options.fetch ?? fetch)(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-goog-api-key': options.key, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      const value = await response.json().catch(() => ({}));
      const clean = (text: unknown) =>
        String(text ?? '')
          .split(options.key || '__no_key__')
          .join('[REDACTED]')
          .replace(/AIza[\w-]{20,}/g, '[REDACTED]')
          .slice(0, 240);
      const model = Array.isArray(value.models)
        ? value.models.find(
            (model: { name?: string }) => model.name === `models/${geminiStressModel}`,
          )
        : undefined;
      return {
        httpStatus: response.status,
        error: value.error
          ? { status: clean(value.error.status), message: clean(value.error.message) }
          : null,
        requiredModelListed: Array.isArray(value.models)
          ? value.models.some(
              (model: { name?: string }) => model.name === `models/${geminiStressModel}`,
            )
          : null,
        usage: value.usageMetadata ?? null,
        modelInputTokenLimit: Number.isSafeInteger(model?.inputTokenLimit)
          ? model.inputTokenLimit
          : null,
      };
    } catch {
      return {
        httpStatus: null,
        error: {
          status: 'NETWORK_FAILURE',
          message: 'Request failed; credential and transport details omitted.',
        },
        requiredModelListed: null,
        usage: null,
      };
    }
  };
  if (!options.key) throw new Error('Missing GEMINI_API_KEY.');
  const discovery = await request('/models');
  const inference = options.inference
    ? await request(`/models/${geminiStressModel}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly OK.' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 32 },
      })
    : null;
  return {
    model: geminiStressModel,
    api: 'Gemini Developer API',
    credentialPresent: true,
    surroundingWhitespace: options.key !== options.key.trim(),
    discovery,
    inference,
  };
}
