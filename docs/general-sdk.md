# General task SDK

The [enterprise billing stress test](enterprise-billing-experiment.md) exercises this SDK with
stateful simulated APIs, read-only compilation and native guarded writes. Its fixture validation
and all 70 live Gemini attempts are complete. The baseline passed 33/35; Foundry passed 32/35.
Foundry reduced model-facing tool invocations by 38.6%, but the 33 fully metered pairs used 4.5%
more tokens and cost an estimated 0.9% more. Two pairs have unknown usage. See the report for
per-condition results and fallback limitations. Use `npm run diagnose:gemini -- --infer` to verify
a newly configured credential.

Build with `npm run build:sdk`. The package in `dist-sdk` now exports the domain-independent
`FoundryClient` (`TaskClient`) by default. The earlier CRM SDK is available at the `./legacy`
subpath. Model transports are at `./providers`. This is a private Node.js 24+ package.

## Register application tools

```ts
import { z } from 'zod';
import { ContractRegistry, TaskObserver, FoundryClient } from '@foundry/read-runtime';

const registry = new ContractRegistry();
const documentInput = z.object({ ownerId: z.string() }).strict();
const documentOutput = z.object({ ownerId: z.string(), titles: z.array(z.string()) }).strict();
registry.registerTool({
  name: 'documents.list',
  version: '1',
  description: 'List the authorized owner’s documents.',
  effect: 'read',
  replaySafe: true, // explicit consent to capture non-secret replay projections
  scopes: ['documents:read'],
  input: documentInput,
  output: documentOutput,
  timeoutMs: 2000,
  authorize: (ctx, args) => documentInput.parse(args).ownerId === ctx.principalId,
  validateResult: (_ctx, args, result) =>
    documentOutput.parse(result).ownerId === documentInput.parse(args).ownerId,
  run: async (args, ctx, signal) => yourDocumentAdapter(documentInput.parse(args), ctx, signal),
});
registry.registerTask({
  kind: 'document_inventory',
  version: '1',
  description: 'Collect my document inventory.',
  input: z.object({ ownerId: z.string() }).strict(),
  output: z
    .object({ documents: z.object({ ownerId: z.string(), titles: z.array(z.string()) }) })
    .strict(),
  tools: ['documents.list'],
  maxAgeMs: 30000,
  maxConcurrency: 3,
  timeoutMs: 5000,
  authorize: (ctx, input) => documentInput.parse(input).ownerId === ctx.principalId,
});
```

The callback arguments are JSON values; narrow them with the corresponding schemas or TypeScript
guards before accessing properties in strict TypeScript. Registered schemas must be representable
as JSON Schema; use separate authorization/result callbacks for application policy. These
callbacks and handler implementations are trusted code. Bump contract versions when they change.

Capture explicit input lineage, not a model-supplied provenance claim:

```ts
const observer = new TaskObserver(registry, 'document_inventory', { ownerId }, context);
await observer.call('documents', 'documents.list', {
  ownerId: { source: 'input', path: ['ownerId'] },
});
const trace = observer.finish({ documents: { source: 'ref', node: 'documents', path: [] } });
await client.observe(trace); // explicitly uploads replay data
```

Register the same manifests and versions on the control plane and in the caller’s runtime.
Adapters/credentials can remain in the caller application. Control-plane verification uses its
own trusted sandbox adapters, with the same manifests, and independent expected results. Do not
send production credentials to verification or allow request JSON to choose handlers.

## Compile and promote

| Action                          | API                                                           |
| ------------------------------- | ------------------------------------------------------------- |
| Inspect registered manifests    | `GET /api/v2/tasks/catalog`                                   |
| Upload explicit replay evidence | `POST /api/v2/tasks/traces`                                   |
| Compile two or more traces      | `POST /api/v2/tasks/compile` with `{name, traceIds}`          |
| Verify exact candidate          | `POST /api/v2/tasks/capabilities/:id/verify`                  |
| Approve/deploy/revoke           | `POST /api/v2/tasks/capabilities/:id/{approve,deploy,revoke}` |
| Obtain signed runtime offer     | `GET /api/v2/tasks/runtime/:name`                             |
| Execute on server               | `POST /api/v2/tasks/dispatch` with `{name, kind, input}`      |

All lifecycle mutations require the corresponding role permission. The registry isolates both
tenant and principal. Tool scopes are open-ended strings in authenticated identity configuration;
resource/user access still requires application policy callbacks. The `customerIds` identity
field exists only for compatibility and can be an empty array for general tasks.

Deployment requires trusted native shadow matches on three distinct inputs for the current
verification stamp and access context, with no failures or mismatches. Register a server-owned
`native` callback, then call `POST /api/v2/tasks/capabilities/:id/shadow` with `{input}` for each
case. Callers cannot supply baseline results. For smaller input domains, trusted code can set
`requiredShadowInputs` to 2–32. Reverification invalidates prior coverage and removes deployment.

An operator can supply `FOUNDRY_TASK_MODULE=/absolute/path/to/trusted-module.ts` to the standalone
server. It must export `createTaskOptions(): GenericTaskOptions`. See `config/tasks.example.ts`
and `src/examples/departure.ts` for an executable personal task. Without a custom module, local
demo mode registers synthetic travel-day and departure workflows. Authenticated mode starts
with an empty catalog unless a trusted module supplies contracts.

The **Developer console** now exposes the generic lifecycle with contract-driven task inputs,
SDK trace import, verification, native shadow comparisons, separate approval/deployment, execution,
revocation and a version registry. See [the console guide](task-console.md). Fixture capture is
local-only and explicitly labeled; it does not call a model or measure token savings. The browser
console is a local development surface, not an authenticated hosted login experience.

## Execute through the SDK

```ts
const client = new FoundryClient({
  registry,
  context: authorizedContext,
  endpoint: process.env.FOUNDRY_ENDPOINT,
  apiKey: process.env.FOUNDRY_API_KEY,
  trustedPublicKey: pinnedEd25519PublicKey,
});
const run = await client.execute({
  name: 'load_my_documents',
  kind: 'document_inventory',
  input: { ownerId },
});
if (run.outcome === 'denied') throw new Error('Access denied');
if (run.outcome === 'unresolved') return yourOriginalAgent({ checkpoint: run.checkpoint });
return run.result;
```

`selectTaskExecution` checks an application-owned required-tool set against the approved plan.
Known complete regions select `compiled_prefetch`; agent-decided complete regions select
`compiled_tool`. Partial or incompatible regions select normal execution. The caller applies the
selection; the SDK does not classify user prose or silently invoke a model. It cannot resume a
compiled checkpoint. Automatic retry of external writes is unsupported.

## Compile and manage capabilities through the SDK

The SDK exposes `observe`, `compile`, `verify`, `shadow`, `approve`, `deploy`, `revoke`,
`capabilities`, `capability`, and `execute`. Lifecycle operations use the authenticated HTTP API;
applications do not need to import the server registry or access SQLite. These methods do not
grant permissions: use credentials with the appropriate observation, compilation, verification,
approval, deployment and invocation roles.

```ts
const uploaded = await Promise.all([traceA, traceB].map((trace) => client.observe(trace)));
const draft = await client.compile(
  'load_my_documents',
  uploaded.map((trace) => trace.id),
);
const verified = await client.verify(draft.id);
if (verified.status !== 'verified' || verified.checks.some((check) => !check.passed)) {
  throw new Error('Verification failed');
}
for (const input of authorizedShadowInputs) {
  const comparison = await client.shadow(draft.id, input);
  if (comparison.status !== 'match') throw new Error('Shadow comparison failed');
}
// Invoke only after your application's review/approval process.
await client.approve(draft.id);
await client.deploy(draft.id);
const available = await client.capabilities();
// Later, revoke future offers/execution:
await client.revoke(draft.id);
```

Compilation needs at least two distinct evidence inputs. Deployment normally requires three
distinct passing shadow inputs. The control plane must have matching trusted contracts, sandbox
verification cases and a native baseline callback registered by the operator. The SDK uploads
replay data and lifecycle requests; it does not upload executable handlers or provider credentials.

Lifecycle responses are schema-validated and HTTP failures retain their status code without
echoing response bodies. `lifecycleTimeoutMs` configures bounded verification/shadow waits
(default 120 seconds); `networkTimeoutMs` configures ordinary requests. A failed lifecycle call
does not silently approve or deploy anything. Inspect `capabilities()` if a connection fails
after a mutation and its completion is uncertain.

## Model providers

```ts
import { ModelClient } from '@foundry/read-runtime/providers';
const agent = new ModelClient({ provider: 'gemini', model: yourModelId });
const result = await agent.run({
  instructions,
  prompt,
  tools: toolDeclarations,
  execute: executeAuthorizedTool,
  maxModelCalls: 8,
  maxToolCalls: 32,
  maxTotalTokens: 100000,
  onEvent: recordNumericUsage,
});
```

| Provider     | Credential environment variable | Default protocol |
| ------------ | ------------------------------- | ---------------- |
| `openai`     | `OPENAI_API_KEY`                | Responses        |
| `moonshot`   | `MOONSHOT_API_KEY`              | Chat Completions |
| `anthropic`  | `ANTHROPIC_API_KEY`             | Messages         |
| `gemini`     | `GEMINI_API_KEY`                | GenerateContent  |
| `xai`        | `XAI_API_KEY`                   | Responses        |
| `openrouter` | `OPENROUTER_API_KEY`            | Chat Completions |

For local Gemini configuration, put `GEMINI_API_KEY=your-key` in the Git-ignored
`.env.server.local` at the repository root. `npm run dev` (API process), `npm start`,
`npm run benchmark:departure` and `npm run benchmark:travel-day` load this optional file.
An existing shell environment value takes precedence. Restart the server after changing the file.
The file is not a standard Vite environment filename; provider keys must remain server-side and
must never use a `VITE_` prefix. Other commands continue to use exported environment variables.
Configuring Gemini does not switch the legacy customer benchmark playground from Codex CLI or
turn the local developer-console fixture examples into live agents. Live experiments still require
their explicit `--live` argument and consume provider inference.

IDs are not restricted to a frozen model list. `models()` returns the provider catalog and, for
OpenRouter, the advertised tool support flag. Providers may reject unavailable/non-tool models.
OpenAI/xAI callers can set `protocol: 'chat'` for compatible older models. Credentials may also be
provided with an application-owned `apiKey: () => secret` callback. Endpoints are fixed to the
provider’s official origin; keys cannot be redirected by model input.

Provider tool arguments are untrusted. `ModelClient` enforces the offered name set and budgets;
the application must execute via `ContractRegistry.invoke` (or equivalent scoped tooling) to
enforce argument schemas and access checks. No provider/model call is made by the IR interpreter.
API failures are sanitized, not automatically retried, and unknown usage stays unknown. Gemini
reasoning tokens are included in total/output usage. Anthropic input includes cache-read and
cache-creation tokens. Cached input is a subset and must not be added to input a second time.

For application-bound tools that should run once, `toolCallPolicy: 'once_per_name'` removes each
successfully completed tool from subsequent offers. The default allows repeated calls, including
different arguments. The departure experiment applies the once-per-name policy to both tool arms.

Protocol references: [OpenAI](https://developers.openai.com/api/docs/guides/function-calling),
[Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use),
[Moonshot](https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls),
[Gemini](https://ai.google.dev/gemini-api/docs/function-calling),
[xAI](https://docs.x.ai/developers/tools/function-calling),
and [OpenRouter](https://openrouter.ai/docs/guides/features/tool-calling).

## Four-arm experiment

```sh
npm run build:sdk
npm run benchmark:departure -- --live
```

Set `GEMINI_API_KEY` in the environment. Optional settings: `FOUNDRY_GEMINI_MODEL` and
`FOUNDRY_DEPARTURE_REPEATS` (1–4, default 2). The script captures real Gemini trajectories,
compiles/verifies/approves the personal departure plan, stresses the packaged SDK with 24
concurrent requests, and compares ordinary tools, a compiled tool, compiled prefetch and ordinary
prefetch on the same synthetic personal records. It retains every measured task, including
failures, and reports setup/warmup/measured/overall provider token totals separately. JSON reports
use unique paths under `docs/experiments/`. Normal tests make no live provider calls.

The more complex travel-day benchmark uses 13 tools across six dependency stages and exercises
every compilation/deployment action through the built SDK:

```sh
npm run build:sdk
npm run benchmark:travel-day -- --live
```

It uses live Gemini inference and synthetic trips. `FOUNDRY_TRAVEL_REPEATS` controls repeats per
trip (1–4, default 2). Ordinary-agent calls use full registered argument schemas, with supplied
arguments checked against authorized input and previous-result provenance. The report includes
per-arm totals, warmups, exploration, failures, source fingerprints, lifecycle HTTP receipts and
48 concurrent SDK executions.
