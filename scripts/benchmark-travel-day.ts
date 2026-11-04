import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { json, stable, type Json } from '../src/compiler/contracts.js';
import { materialize } from '../src/compiler/task-ir.js';
import type { TaskObserver } from '../src/exploration/task-observer.js';
import type { TaskClient } from '../src/integration/task-client.js';
import { sumModelUsage, type ModelClient, type ModelEvent } from '../src/agent/providers.js';
import { Store } from '../src/registry/store.js';
import { ApiKeyAuthenticator, localIdentity } from '../src/security/identity.js';
import { ArtifactSigner } from '../src/security/signing.js';
import {
  captureTravel,
  expectedTravelAnswer,
  expectedTravelContext,
  travelAccess,
  travelAnswerSchema,
  travelBindings,
  travelInput,
  travelInputs,
  travelKind,
  travelLayers,
  travelName,
  travelOutput,
  travelRegistry,
} from '../src/examples/travel-day.js';

if (!process.argv.includes('--live')) throw new Error('Use --live for Gemini inference.');
const packaged = await import(pathToFileURL(resolve('dist-sdk/integration/index.js')).href);
const packagedProviders = await import(pathToFileURL(resolve('dist-sdk/agent/providers.js')).href);
const model = process.env.FOUNDRY_GEMINI_MODEL ?? 'gemini-3.8-flash';
const repeats = z.coerce
  .number()
  .int()
  .min(1)
  .max(4)
  .parse(process.env.FOUNDRY_TRAVEL_REPEATS ?? 2);
const started = performance.now();
const sources = [
  'src/integration/task-client.ts',
  'src/compiler/contracts.ts',
  'src/compiler/task-ir.ts',
  'src/runtime/task-runtime.ts',
  'src/registry/tasks.ts',
  'src/agent/providers.ts',
  'src/examples/travel-day.ts',
  'scripts/benchmark-travel-day.ts',
  'dist-sdk/integration/task-client.js',
  'dist-sdk/agent/providers.js',
];
const sourceHashes = Object.fromEntries(
  sources.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
const arms = ['regular_agent', 'compiled_tool', 'compiled_prefetch', 'regular_prefetch'] as const;
type Arm = (typeof arms)[number];
type Phase = 'exploration' | 'warmup' | 'measurement';
const ledger: { phase: Phase; arm?: Arm; caseId: string; event: ModelEvent }[] = [];
let phase: Phase = 'exploration';
let activeArm: Arm | undefined;
let caseId = '';
let toolCalls = 0;
const registry = travelRegistry({ onCall: () => toolCalls++ });
const identity = { ...localIdentity, toolScopes: [...travelAccess().scopes] };
const credential = 'travel_benchmark_local_credential_000000';
const auth = new ApiKeyAuthenticator([
  { sha256: createHash('sha256').update(credential).digest('hex'), identity },
]);
const keys = generateKeyPairSync('ed25519');
const signer = new ArtifactSigner(
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const store = new Store(':memory:');
const { app } = createApp(store, false, {
  auth,
  signer,
  tasks: {
    registry,
    context: travelAccess,
    verificationCases: () =>
      travelInputs.map((input) => ({ input, expected: expectedTravelContext(input) })),
    native: async (_kind, input, context) =>
      (await captureTravel(registry, travelInput.parse(input), context)).result,
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((done) => server.once('listening', done));
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const controlCalls: { path: string; method: string; status: number }[] = [];
const sdk: TaskClient = new packaged.TaskClient({
  registry,
  context: travelAccess,
  endpoint,
  apiKey: credential,
  trustedPublicKey: publicKey,
  lifecycleTimeoutMs: 120000,
  fetch: async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const response = await fetch(url, init);
    controlCalls.push({
      path: new URL(String(url)).pathname,
      method: init?.method ?? 'GET',
      status: response.status,
    });
    return response;
  },
});
const agent: ModelClient = new packagedProviders.ModelClient({
  provider: 'gemini',
  model,
  maxOutputTokens: 4096,
});
const onEvent = (event: ModelEvent) => ledger.push({ phase, arm: activeArm, caseId, event });
const instructions = `You are a read-only personal travel-day assistant. Prepare the full one-flight/one-hotel trip report. Use actual tool results, never invented booking, flight, weather or calendar data. Keep userId and tripId bound to the authorized input and copy its now exactly when required. Retrieve every resource needed to complete the whole report, including all calculations. Confirmations may be missing; report them as findings, not service failures. Call each tool at most once and reuse results. Respect dependencies: load_trip and load_profile first; then check_flight/load_hotel/load_calendar/weather_at_origin; then weather_at_destination/route_to_airport/route_to_hotel; then calculate_departure/calculate_arrival; then find_conflicts; then check_readiness. Tools in a stage can run in parallel when their input data is known. If the compiled context tool is offered, it obtains this entire region. If context is already supplied, use it directly. Copy the calculated departure, arrival, delay, conflicts and readiness fields exactly; use UTC ISO timestamps including milliseconds. Return only JSON matching the supplied schema, without analysis or commentary.`;
const originalTools = Object.keys(travelBindings).map((name) => ({
  name,
  description: registry.tool(name).description,
  inputSchema: registry.toolManifest(name).inputSchema,
}));
const compiledTool = {
  name: travelName,
  description:
    'Load the complete authorized trip, profile, flight status, hotel, calendar, both weather forecasts and both routes; calculate departure, hotel arrival, conflicts and readiness using the approved read-only capability.',
  inputSchema: json(z.toJSONSchema(travelInput)),
};
const runs: {
  phase: Phase;
  arm: Arm;
  caseId: string;
  passed: boolean;
  failure?: string;
  usage: ReturnType<typeof sumModelUsage>;
  modelCalls: number;
  toolCalls: number;
  sdkCalls: number;
  latencyMs: number;
  answer?: Json;
}[] = [];
const stress: { name: string; passed: boolean; requests: number }[] = [];
const lifecycle: { action: string; passed: boolean; digest?: string; checks?: number }[] = [];
const gate = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

function sourceSession(input: (typeof travelInputs)[number]) {
  const observer: TaskObserver = new packaged.TaskObserver(
    registry,
    travelKind,
    input,
    travelAccess(),
  );
  const values = new Map<string, Json>();
  const cache = new Map<string, Promise<Json>>();
  const call = (name: string, rawArgs?: Json): Promise<Json> => {
    const binding = travelBindings[name];
    if (!binding) throw new Error('Unregistered travel tool.');
    const expected = materialize(binding.args, input, values);
    if (
      rawArgs !== undefined &&
      stable(registry.tool(name).input.parse(rawArgs)) !== stable(expected)
    )
      throw new Error('Model arguments did not match authorized input or result provenance.');
    if (!cache.has(name))
      cache.set(
        name,
        (async () => {
          const result = await observer.call(binding.id, name, binding.args);
          values.set(binding.id, result);
          return result;
        })(),
      );
    return cache.get(name)!;
  };
  return { observer, call };
}
function parsedAnswer(text: string): Json {
  const parsed = travelAnswerSchema.parse(JSON.parse(text));
  parsed.conflictingEventIds.sort();
  parsed.missingItems.sort();
  return json(parsed);
}
const prompt = (input: (typeof travelInputs)[number], context?: Json) =>
  `Authorized input: ${JSON.stringify(input)}\nI am flying to Chicago tomorrow. Prepare my complete travel-day plan: when to leave, arrival at the hotel, check-in waiting time, flight changes, calendar conflicts, missing confirmations and weather readiness.${context === undefined ? '' : `\nAuthorized context already loaded: ${JSON.stringify(context)}`}`;

async function execute(input: (typeof travelInputs)[number], arm: Arm) {
  activeArm = arm;
  caseId = input.tripId;
  const at = performance.now();
  const beforeEvents = ledger.length;
  const beforeCalls = toolCalls;
  const beforeSdk = controlCalls.length;
  const source = sourceSession(input);
  let answer: Json | undefined;
  let failure: string | undefined;
  let compiledResult: Promise<Json> | undefined;
  const compiled = (args: Json) => {
    gate(
      stable(travelInput.parse(args)) === stable(input),
      'Compiled tool arguments crossed the authorized task input.',
    );
    return (compiledResult ??= (async () => {
      const run = await sdk.execute({ name: travelName, kind: travelKind, input });
      gate(
        run.mode === 'compiled' && run.outcome === 'success' && run.llmInvocations === 0,
        'Compiled SDK execution failed.',
      );
      gate(
        stable(run.result) === stable(expectedTravelContext(input)),
        'Compiled context did not match independent oracle.',
      );
      return run.result!;
    })());
  };
  try {
    let supplied: Json | undefined;
    if (arm === 'compiled_prefetch') supplied = await compiled(input);
    if (arm === 'regular_prefetch') {
      for (const layer of travelLayers) await Promise.all(layer.map((name) => source.call(name)));
      supplied = source.observer.finish(travelOutput).result;
    }
    const result = await agent.run({
      instructions,
      prompt: prompt(input, supplied),
      tools:
        arm === 'regular_agent' ? originalTools : arm === 'compiled_tool' ? [compiledTool] : [],
      execute: (name, args) => (name === travelName ? compiled(args) : source.call(name, args)),
      outputSchema: json(z.toJSONSchema(travelAnswerSchema)),
      maxModelCalls: 12,
      maxToolCalls: 20,
      maxTotalTokens: 60000,
      toolCallPolicy: 'once_per_name',
      onEvent,
    });
    answer = parsedAnswer(result.text);
    gate(
      stable(answer) === stable(expectedTravelAnswer(input)),
      'Final travel answer failed the independent oracle.',
    );
    if (arm === 'regular_agent' || arm === 'regular_prefetch')
      gate(
        stable(source.observer.finish(travelOutput).result) ===
          stable(expectedTravelContext(input)),
        'Original evidence was incomplete or incorrect.',
      );
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Travel request failed.';
  }
  const events = ledger.slice(beforeEvents).map((entry) => entry.event);
  const run = {
    phase,
    arm,
    caseId,
    passed: !failure,
    failure,
    usage: sumModelUsage(events),
    modelCalls: events.length,
    toolCalls: toolCalls - beforeCalls,
    sdkCalls: controlCalls.length - beforeSdk,
    latencyMs: performance.now() - at,
    answer,
  };
  runs.push(run);
  console.log(
    JSON.stringify({
      phase,
      arm,
      caseId,
      passed: run.passed,
      tokens: run.usage.totalTokens,
      modelCalls: run.modelCalls,
      failure,
    }),
  );
}

let failure: string | undefined;
let artifactId: string | undefined;
let digest: string | undefined;
try {
  const traceIds = [];
  for (const input of travelInputs.slice(0, 2)) {
    caseId = input.tripId;
    activeArm = undefined;
    const source = sourceSession(input);
    const result = await agent.run({
      instructions,
      prompt: prompt(input),
      tools: originalTools,
      execute: source.call,
      outputSchema: json(z.toJSONSchema(travelAnswerSchema)),
      maxModelCalls: 12,
      maxToolCalls: 20,
      maxTotalTokens: 60000,
      toolCallPolicy: 'once_per_name',
      onEvent,
    });
    gate(
      stable(parsedAnswer(result.text)) === stable(expectedTravelAnswer(input)),
      'Exploration answer mismatch.',
    );
    const trace = source.observer.finish(travelOutput);
    gate(
      stable(trace.result) === stable(expectedTravelContext(input)),
      'Exploration evidence mismatch.',
    );
    traceIds.push((await sdk.observe(trace)).id);
    console.log(JSON.stringify({ phase, caseId, capturedTools: trace.events.length }));
  }
  const draft = await sdk.compile(travelName, traceIds);
  artifactId = draft.id;
  digest = draft.digest;
  lifecycle.push({
    action: 'compile_via_sdk',
    passed: draft.status === 'draft' && draft.plan.nodes.length === 13,
    digest,
  });
  const verified = await sdk.verify(draft.id);
  gate(
    verified.status === 'verified' && verified.checks.every((check) => check.passed),
    'Verification failed.',
  );
  lifecycle.push({
    action: 'verify_via_sdk',
    passed: true,
    digest: verified.verifiedDigest,
    checks: verified.checks.length,
  });
  const approved = await sdk.approve(draft.id);
  gate(approved.approvedDigest === digest, 'Approval digest mismatch.');
  lifecycle.push({ action: 'approve_via_sdk', passed: true, digest });
  for (const input of travelInputs) {
    const shadow = await sdk.shadow(draft.id, input);
    gate(shadow.status === 'match' && shadow.digest === digest, 'Trusted native shadow failed.');
  }
  lifecycle.push({ action: 'shadow_via_sdk', passed: true, digest });
  await sdk.deploy(draft.id);
  lifecycle.push({ action: 'deploy_via_sdk', passed: true, digest });
  gate((await sdk.capability(travelName)).digest === digest, 'Signed offer digest mismatch.');
  const results = await Promise.all(
    Array.from({ length: 48 }, (_, index) =>
      sdk.execute({ name: travelName, kind: travelKind, input: travelInputs[index % 3] }),
    ),
  );
  stress.push({
    name: '48_concurrent_packaged_sdk_requests',
    requests: 48,
    passed: results.every(
      (run, index) =>
        run.mode === 'compiled' &&
        run.llmInvocations === 0 &&
        stable(run.result) === stable(expectedTravelContext(travelInputs[index % 3])),
    ),
  });
  gate(
    stress.every((check) => check.passed),
    'Concurrent SDK stress failed.',
  );
  phase = 'warmup';
  for (const arm of arms) await execute(travelInputs[0], arm);
  phase = 'measurement';
  for (let repeat = 0; repeat < repeats; repeat++)
    for (let index = 0; index < travelInputs.length; index++) {
      const rotation = (repeat * travelInputs.length + index) % arms.length;
      for (const arm of [...arms.slice(rotation), ...arms.slice(0, rotation)])
        await execute(travelInputs[index], arm);
    }
  await sdk.revoke(draft.id);
  lifecycle.push({ action: 'revoke_via_sdk', passed: true, digest });
  const revoked = await sdk.execute({ name: travelName, kind: travelKind, input: travelInputs[0] });
  stress.push({
    name: 'revocation_blocks_future_compiled_execution',
    requests: 1,
    passed: revoked.outcome === 'unresolved',
  });
} catch (error) {
  failure = error instanceof Error ? error.message : 'Travel benchmark failed.';
  process.exitCode = 1;
} finally {
  const summary = Object.fromEntries(
    arms.map((arm) => {
      const measured = runs.filter((run) => run.phase === 'measurement' && run.arm === arm);
      const events = ledger
        .filter((entry) => entry.phase === 'measurement' && entry.arm === arm)
        .map((entry) => entry.event);
      const usage = sumModelUsage(events);
      const allEvents = ledger.filter((entry) => entry.arm === arm).map((entry) => entry.event);
      return [
        arm,
        {
          tasks: measured.length,
          passed: measured.filter((run) => run.passed).length,
          ...usage,
          meanTokens:
            usage.totalTokens === null || !measured.length
              ? null
              : usage.totalTokens / measured.length,
          modelCalls: events.length,
          toolCalls: measured.reduce((total, run) => total + run.toolCalls, 0),
          includingWarmup: sumModelUsage(allEvents),
        },
      ];
    }),
  );
  const phaseUsage = Object.fromEntries(
    (['exploration', 'warmup', 'measurement'] as Phase[]).map((label) => [
      label,
      sumModelUsage(ledger.filter((entry) => entry.phase === label).map((entry) => entry.event)),
    ]),
  );
  const report = {
    complete:
      !failure && runs.filter((run) => run.phase === 'measurement').length === 3 * repeats * 4,
    allCorrect: !failure && runs.every((run) => run.passed),
    failure,
    capturedAt: new Date().toISOString(),
    provider: 'gemini',
    model,
    branch: 'abhi-dev',
    methodology: {
      task: 'Full travel-day plan: flight, hotel, calendar, weather, ground travel, timeline and readiness.',
      data: 'Synthetic personal fixtures and live Gemini inference; no real travel accounts.',
      nodes: 13,
      readNodes: 9,
      pureNodes: 4,
      dependencyStages: 6,
      inputs: travelInputs,
      repeatsPerInput: repeats,
      arms,
      armOrder: 'rotated',
      modelToolArguments:
        'Full registered schemas; every model argument is checked against application-owned input/result provenance.',
      oncePerToolPolicy: true,
      sdk: 'Built package supplies observer, provider client, every lifecycle operation and signed execution over HTTP. No direct registry lifecycle calls.',
      usage:
        'Reported tokens across every response, including reasoning; failed calls remain included and unknown usage remains null.',
      limitations: [
        'Small sample of a bounded single-flight/single-hotel workflow.',
        'Generated model responses remain nondeterministic.',
        'All four modes still perform the same underlying reads/calculations.',
      ],
    },
    artifactId,
    digest,
    sourceHashes,
    lifecycle,
    stress,
    summary,
    phaseUsage,
    experimentTotal: sumModelUsage(ledger.map((entry) => entry.event)),
    elapsedMs: performance.now() - started,
    runs,
    ledger,
    controlCalls,
  };
  mkdirSync('docs/experiments', { recursive: true });
  const path = `docs/experiments/travel-day-gemini-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      complete: report.complete,
      allCorrect: report.allCorrect,
      failure,
      output: path,
      summary,
      phaseUsage,
      total: report.experimentTotal,
      stress,
      lifecycle,
    }),
  );
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
}
