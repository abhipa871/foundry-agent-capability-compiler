import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { ModelClient, sumModelUsage, type ModelEvent } from '../src/agent/providers.js';
import { createApp } from '../src/app.js';
import { json, stable, type Json } from '../src/compiler/contracts.js';
import { TaskObserver } from '../src/exploration/task-observer.js';
import type { TaskClient } from '../src/integration/task-client.js';
import { Store } from '../src/registry/store.js';
import { TaskRegistry, type GenericTaskOptions } from '../src/registry/tasks.js';
import { ArtifactSigner } from '../src/security/signing.js';
import { ApiKeyAuthenticator, localIdentity, withIdentity } from '../src/security/identity.js';
import {
  captureDeparture,
  departureAccess,
  departureAnswerSchema,
  departureBindings,
  departureInputs,
  departureInput,
  departureKind,
  departureName,
  departureOutput,
  departureRegistry,
  departureTools,
  expectedDeparture,
  expectedDepartureAnswer,
} from '../src/examples/departure.js';

// Opt-in live inference; normal tests never use a real provider key.
if (!process.argv.includes('--live'))
  throw new Error('Use --live to authorize provider inference.');
const { TaskClient: PackagedTaskClient } = await import(
  pathToFileURL(resolve('dist-sdk/integration/index.js')).href
);
const model = process.env.FOUNDRY_GEMINI_MODEL ?? 'gemini-3.8-flash';
const repeats = z.coerce
  .number()
  .int()
  .min(1)
  .max(4)
  .parse(process.env.FOUNDRY_DEPARTURE_REPEATS ?? 2);
const started = performance.now();
const sourceHashes = Object.fromEntries(
  [
    'src/compiler/contracts.ts',
    'src/compiler/task-ir.ts',
    'src/exploration/task-observer.ts',
    'src/runtime/task-runtime.ts',
    'src/registry/tasks.ts',
    'src/integration/task-client.ts',
    'src/agent/providers.ts',
    'src/examples/departure.ts',
    'scripts/benchmark-departure.ts',
    'dist-sdk/integration/task-client.js',
    'dist-sdk/runtime/task-runtime.js',
  ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
const arms = ['regular_api', 'compiled_tool', 'compiled_prefetch', 'regular_prefetch'] as const;
type Arm = (typeof arms)[number];
const ledger: { phase: string; arm?: Arm; caseId: string; event: ModelEvent }[] = [];
const runs: {
  phase: string;
  arm: Arm;
  caseId: string;
  passed: boolean;
  failure?: string;
  usage: ReturnType<typeof sumModelUsage>;
  modelCalls: number;
  modelToolCalls: number;
  physicalToolCalls: number;
  sdkCalls: number;
  latencyMs: number;
  answer?: Json;
}[] = [];
let phase = 'setup';
let currentArm: Arm | undefined;
let caseId = '';
let physicalCalls = 0;
let sdkCalls = 0;
const registry = departureRegistry({ onCall: () => physicalCalls++ });
const provider = new ModelClient({ provider: 'gemini', model, maxOutputTokens: 4096 });
const identity = { ...localIdentity, toolScopes: [...departureAccess().scopes] };
const keys = generateKeyPairSync('ed25519');
const signer = new ArtifactSigner(
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
);
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const credential = 'departure_experiment_local_credential_00000';
const auth = new ApiKeyAuthenticator([
  { sha256: createHash('sha256').update(credential).digest('hex'), identity },
]);
const store = new Store(':memory:');
const taskOptions: GenericTaskOptions = {
  registry,
  context: departureAccess,
  verificationCases: () =>
    departureInputs.map((input) => ({ input, expected: expectedDeparture(input) })),
  native: async (_kind, input, context) =>
    (await captureDeparture(registry, departureInput.parse(input), context)).result,
};
const lifecycle = new TaskRegistry(store, taskOptions);
const { app } = createApp(store, false, { auth, signer, tasks: taskOptions });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((done) => server.once('listening', done));
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const sdk: TaskClient = new PackagedTaskClient({
  registry,
  context: departureAccess,
  endpoint,
  apiKey: credential,
  trustedPublicKey: publicKey,
  fetch: (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    sdkCalls++;
    return fetch(url, init);
  },
});
const instructions =
  'You are a personal appointment assistant. Use all required appointment, profile, route, weather and departure calculation evidence. Call each tool at most once and reuse returned values. First load calendar_next and profile_origin; route_eta requires both. weather_forecast requires calendar_next. departure_calculate requires calendar_next and route_eta. Tool inputs are securely bound by the application. If context is supplied, use it directly. Return only JSON with eventId, departureTime (UTC ISO with milliseconds), travelMinutes and bringUmbrella. Bring an umbrella exactly when rain is true. Use departure_calculate’s departureTime exactly. Do not invent data.';
const onEvent = (event: ModelEvent) => ledger.push({ phase, arm: currentArm, caseId, event });
const originalTools = departureTools.map((name) => ({
  name,
  description: registry.tool(name).description,
  inputSchema: json({ type: 'object', properties: {}, required: [], additionalProperties: false }),
}));
const compiledTool = {
  name: departureName,
  description:
    'Load the authorized user’s next appointment, origin, travel time, weather and calculated departure plan in one validated read-only capability.',
  inputSchema: json({ type: 'object', properties: {}, required: [], additionalProperties: false }),
};

async function execute(input: (typeof departureInputs)[number], arm: Arm) {
  currentArm = arm;
  caseId = input.userId;
  const at = performance.now();
  const before = physicalCalls;
  const beforeSdk = sdkCalls;
  const beforeEvents = ledger.length;
  let answer: Json | undefined;
  let failure: string | undefined;
  let modelToolCalls = 0;
  const observer = new TaskObserver(registry, departureKind, input, departureAccess());
  const cache = new Map<string, Promise<Json>>();
  const original = (name: string): Promise<Json> => {
    if (!departureBindings[name]) throw new Error('Unknown application tool.');
    if (!cache.has(name))
      cache.set(
        name,
        observer.call(departureBindings[name].id, name, departureBindings[name].args),
      );
    return cache.get(name)!;
  };
  const compiled = (): Promise<Json> => {
    if (!cache.has(departureName))
      cache.set(
        departureName,
        (async () => {
          const run = await sdk.execute({ name: departureName, kind: departureKind, input });
          if (
            run.outcome !== 'success' ||
            run.mode !== 'compiled' ||
            run.result === undefined ||
            run.llmInvocations !== 0
          )
            throw new Error('Compiled capability did not succeed.');
          if (stable(run.result) !== stable(expectedDeparture(input)))
            throw new Error('Compiled output mismatch.');
          return run.result;
        })(),
      );
    return cache.get(departureName)!;
  };
  try {
    let supplied: Json | undefined;
    if (arm === 'compiled_prefetch') supplied = await compiled();
    if (arm === 'regular_prefetch') {
      await Promise.all([original('calendar_next'), original('profile_origin')]);
      await Promise.all([original('route_eta'), original('weather_forecast')]);
      await original('departure_calculate');
      supplied = observer.finish(departureOutput).result;
    }
    const offered =
      arm === 'regular_api' ? originalTools : arm === 'compiled_tool' ? [compiledTool] : [];
    const result = await provider.run({
      instructions,
      prompt: `Authorized input: ${JSON.stringify(input)}\nWhen should I leave for my next appointment, how long is the trip, and do I need an umbrella?${supplied === undefined ? '' : `\nVerified context: ${JSON.stringify(supplied)}`}`,
      tools: offered,
      execute: async (name, args) => {
        z.object({}).strict().parse(args);
        return name === departureName ? compiled() : original(name);
      },
      outputSchema: json(z.toJSONSchema(departureAnswerSchema)),
      maxModelCalls: 8,
      maxToolCalls: 16,
      maxTotalTokens: 30000,
      toolCallPolicy: 'once_per_name',
      onEvent,
    });
    modelToolCalls = result.toolCalls;
    answer = json(departureAnswerSchema.parse(JSON.parse(result.text)));
    if (stable(answer) !== stable(expectedDepartureAnswer(input)))
      throw new Error('Final answer failed independent oracle.');
    if (arm === 'regular_api') {
      const trace = observer.finish(departureOutput);
      if (stable(trace.result) !== stable(expectedDeparture(input)))
        throw new Error('Original reads differ from oracle.');
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Task failed.';
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
    modelToolCalls,
    physicalToolCalls: physicalCalls - before,
    sdkCalls: sdkCalls - beforeSdk,
    latencyMs: performance.now() - at,
    answer,
  };
  runs.push(run);
  console.log(
    JSON.stringify({
      stage: phase,
      arm,
      caseId,
      passed: run.passed,
      totalTokens: run.usage.totalTokens,
      modelCalls: run.modelCalls,
      failure,
    }),
  );
  return run;
}

let failure: string | undefined;
let artifactId: string | undefined;
const stress: { name: string; passed: boolean; requests: number; modelCalls: number }[] = [];
try {
  await withIdentity(identity, async () => {
    const traces = [];
    // Real Gemini exploration generates the tool events used as compiler evidence.
    for (const input of departureInputs.slice(0, 2)) {
      currentArm = undefined;
      caseId = input.userId;
      const observer = new TaskObserver(registry, departureKind, input, departureAccess());
      const cache = new Map<string, Promise<Json>>();
      await provider.run({
        instructions,
        prompt: `Authorized input: ${JSON.stringify(input)}\nGather all departure context, then answer when to leave and whether to bring an umbrella.`,
        tools: originalTools,
        execute: async (name, args) => {
          z.object({}).strict().parse(args);
          const binding = departureBindings[name];
          if (!binding) throw new Error('Unknown exploration tool.');
          if (!cache.has(name)) cache.set(name, observer.call(binding.id, name, binding.args));
          return cache.get(name)!;
        },
        outputSchema: json(z.toJSONSchema(departureAnswerSchema)),
        onEvent,
        maxModelCalls: 8,
        maxToolCalls: 16,
        toolCallPolicy: 'once_per_name',
      });
      const trace = observer.finish(departureOutput);
      if (stable(trace.result) !== stable(expectedDeparture(input)))
        throw new Error('Exploration oracle mismatch.');
      traces.push(trace);
      await sdk.observe(trace);
    }
    const artifact = lifecycle.compile(
      departureName,
      traces.map((trace) => trace.id),
    );
    artifactId = artifact.id;
    const verified = await lifecycle.verify(artifact.id);
    if (verified.checks.some((check) => !check.passed))
      throw new Error('Candidate verification failed.');
    lifecycle.approve(artifact.id);
    for (const input of departureInputs) {
      const shadow = await lifecycle.shadow(artifact.id, input);
      if (shadow.status !== 'match') throw new Error('Trusted native shadow comparison failed.');
    }
    lifecycle.deploy(artifact.id);
    console.log(
      JSON.stringify({
        stage: 'compiled',
        artifactId,
        digest: artifact.digest,
        checks: verified.checks.length,
      }),
    );
    phase = 'stress';
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        sdk.execute({
          name: departureName,
          kind: departureKind,
          input: departureInputs[index % 3],
        }),
      ),
    );
    stress.push({
      name: 'packaged_sdk_24_concurrent',
      requests: results.length,
      modelCalls: 0,
      passed: results.every(
        (run, index) =>
          run.mode === 'compiled' &&
          stable(run.result) === stable(expectedDeparture(departureInputs[index % 3])),
      ),
    });
    if (stress.some((check) => !check.passed)) throw new Error('Packaged SDK stress test failed.');
    phase = 'warmup';
    for (const arm of arms) await execute(departureInputs[0], arm);
    phase = 'measurement';
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (let index = 0; index < departureInputs.length; index++) {
        const rotation = (repeat * departureInputs.length + index) % arms.length;
        const order = [...arms.slice(rotation), ...arms.slice(0, rotation)];
        for (const arm of order) await execute(departureInputs[index], arm);
      }
    }
    lifecycle.revoke(artifact.id);
    const revoked = await sdk.execute({
      name: departureName,
      kind: departureKind,
      input: departureInputs[0],
    });
    stress.push({
      name: 'revocation_handoff',
      requests: 1,
      modelCalls: 0,
      passed: revoked.outcome === 'unresolved',
    });
  });
} catch (error) {
  failure = error instanceof Error ? error.message : 'Experiment failed.';
  process.exitCode = 1;
} finally {
  const summary = Object.fromEntries(
    arms.map((arm) => {
      const measured = runs.filter((run) => run.phase === 'measurement' && run.arm === arm);
      const events = ledger
        .filter((entry) => entry.phase === 'measurement' && entry.arm === arm)
        .map((entry) => entry.event);
      const usage = sumModelUsage(events);
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
          physicalToolCalls: measured.reduce((total, run) => total + run.physicalToolCalls, 0),
          sdkCalls: measured.reduce((total, run) => total + run.sdkCalls, 0),
        },
      ];
    }),
  );
  const phaseUsage = Object.fromEntries(
    ['setup', 'warmup', 'measurement'].map((label) => [
      label,
      sumModelUsage(ledger.filter((entry) => entry.phase === label).map((entry) => entry.event)),
    ]),
  );
  const report = {
    complete:
      !failure && runs.filter((run) => run.phase === 'measurement').length === repeats * 3 * 4,
    failure,
    capturedAt: new Date().toISOString(),
    branch: 'abhi-dev',
    provider: 'gemini',
    model,
    methodology: {
      task: 'Personal next-appointment departure and umbrella plan.',
      inputs: departureInputs,
      arms,
      repeatsPerInput: repeats,
      armOrder: 'rotated',
      compiledRegion:
        'Five registered read/pure tools, explicit value provenance, verified and approved exact IR digest.',
      finalAnswer: 'Gemini generates the same four evidence fields in every arm.',
      data: 'Synthetic personal fixtures; live Gemini inference. No real calendar, maps or weather accounts.',
      tokenDefinition:
        'Provider usage totals summed across every response including reasoning, retries requested by the model and failures with reported usage. Missing provider usage remains null.',
      sdk: 'Built dist-sdk package loaded dynamically; signed capability offers over loopback HTTP.',
      limitations: [
        'Small controlled sample, not a production load or cross-model benchmark.',
        'All contexts have a fixed snapshot. External live-data outputs depend on their providers.',
        'Only Gemini was exercised live. Other provider adapters have mocked protocol tests.',
      ],
    },
    artifactId,
    sourceHashes,
    summary,
    phaseUsage,
    experimentTotal: sumModelUsage(ledger.map((entry) => entry.event)),
    elapsedMs: performance.now() - started,
    stress,
    runs,
    ledger,
  };
  mkdirSync('docs/experiments', { recursive: true });
  const path = `docs/experiments/departure-gemini-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      complete: report.complete,
      failure,
      output: path,
      summary,
      phaseUsage,
      experimentTotal: report.experimentTotal,
      stress,
    }),
  );
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
}
