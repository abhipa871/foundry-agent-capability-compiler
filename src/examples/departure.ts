import { z } from 'zod';
import { ContractRegistry, type AccessContext, type Json } from '../compiler/contracts.js';
import { TaskObserver } from '../exploration/task-observer.js';
import type { Binding } from '../compiler/task-ir.js';

// Synthetic data only. This domain lives in an application registration, outside the engine.
export const departureInput = z
  .object({ userId: z.string(), now: z.iso.datetime({ offset: true }) })
  .strict();
const owned = { userId: z.string(), tenantId: z.string(), snapshot: z.string() };
const appointment = z
  .object({
    ...owned,
    id: z.string(),
    startsAt: z.iso.datetime({ offset: true }),
    destination: z.string(),
  })
  .strict();
const profile = z.object({ ...owned, origin: z.string() }).strict();
const route = z.object({ ...owned, minutes: z.number().int().nonnegative().max(300) }).strict();
const weather = z.object({ ...owned, condition: z.string(), rain: z.boolean() }).strict();
const plan = z
  .object({ departureTime: z.iso.datetime(), bufferMinutes: z.number().int() })
  .strict();
export const departureContextSchema = z
  .object({ appointment, profile, route, weather, plan })
  .strict();
export const departureAnswerSchema = z
  .object({
    eventId: z.string(),
    departureTime: z.iso.datetime(),
    travelMinutes: z.number().int(),
    bringUmbrella: z.boolean(),
  })
  .strict();
export const departureKind = 'personal_departure';
export const departureName = 'load_next_departure_context';
export const departureTools = [
  'calendar_next',
  'profile_origin',
  'route_eta',
  'weather_forecast',
  'departure_calculate',
];
const records: Record<
  string,
  {
    eventId: string;
    startsAt: string;
    destination: string;
    origin: string;
    minutes: number;
    rain: boolean;
    departureTime: string;
  }
> = {
  alice: {
    eventId: 'dentist-1',
    startsAt: '2026-11-03T15:30:00-05:00',
    destination: 'Dental clinic',
    origin: 'Home A',
    minutes: 28,
    rain: true,
    departureTime: '2026-11-03T19:47:00.000Z',
  },
  bob: {
    eventId: 'library-2',
    startsAt: '2026-11-03T16:00:00-05:00',
    destination: 'Library',
    origin: 'Home B',
    minutes: 12,
    rain: false,
    departureTime: '2026-11-03T20:33:00.000Z',
  },
  carol: {
    eventId: 'class-3',
    startsAt: '2026-11-03T18:15:00-05:00',
    destination: 'Evening class',
    origin: 'Home C',
    minutes: 41,
    rain: true,
    departureTime: '2026-11-03T22:19:00.000Z',
  },
};
export const departureInputs = Object.keys(records).map((userId) => ({
  userId,
  now: '2026-11-03T10:00:00-05:00',
}));
export const departureAccess = (): AccessContext => ({
  tenantId: 'local-demo',
  principalId: 'local-operator',
  scopes: ['calendar:read', 'profile:read', 'route:read', 'weather:read'],
  policyVersion: 'personal-policy-v1',
  snapshot: 'personal-fixtures-v1',
  observedAt: Date.now(),
});
export const departureOutput: Record<string, Binding> = Object.fromEntries(
  ['appointment', 'profile', 'route', 'weather', 'plan'].map((key) => [
    key,
    { source: 'ref', node: key, path: [] } as Binding,
  ]),
);
export const departureBindings: Record<string, { id: string; args: Record<string, Binding> }> = {
  calendar_next: {
    id: 'appointment',
    args: {
      userId: { source: 'input', path: ['userId'] },
      now: { source: 'input', path: ['now'] },
    },
  },
  profile_origin: { id: 'profile', args: { userId: { source: 'input', path: ['userId'] } } },
  route_eta: {
    id: 'route',
    args: {
      userId: { source: 'input', path: ['userId'] },
      origin: { source: 'ref', node: 'profile', path: ['origin'] },
      destination: { source: 'ref', node: 'appointment', path: ['destination'] },
    },
  },
  weather_forecast: {
    id: 'weather',
    args: {
      userId: { source: 'input', path: ['userId'] },
      destination: { source: 'ref', node: 'appointment', path: ['destination'] },
      at: { source: 'ref', node: 'appointment', path: ['startsAt'] },
    },
  },
  departure_calculate: {
    id: 'plan',
    args: {
      startsAt: { source: 'ref', node: 'appointment', path: ['startsAt'] },
      travelMinutes: { source: 'ref', node: 'route', path: ['minutes'] },
    },
  },
};

export function departureRegistry(
  options: {
    onCall?: (name: string) => void;
    fault?: 'timeout' | 'malformed' | 'cross_user';
    toolVersion?: string;
  } = {},
): ContractRegistry {
  const registry = new ContractRegistry();
  const recordFor = (args: Json) => records[(args as { userId: string }).userId];
  const owns = (context: AccessContext, args: Json) =>
    context.tenantId === 'local-demo' &&
    context.principalId === 'local-operator' &&
    !!recordFor(args);
  const isolated = (context: AccessContext, args: Json, result: Json) => {
    const value = result as { userId: string; tenantId: string; snapshot: string };
    return (
      value.userId === (args as { userId: string }).userId &&
      value.tenantId === context.tenantId &&
      value.snapshot === context.snapshot
    );
  };
  const common = (args: Json, context: AccessContext) => ({
    userId: (args as { userId: string }).userId,
    tenantId: context.tenantId,
    snapshot: context.snapshot,
  });
  const add = (
    name: string,
    description: string,
    input: z.ZodType,
    output: z.ZodType,
    scope: string,
    run: (args: Json, context: AccessContext) => unknown,
  ) => {
    registry.registerTool({
      name,
      version: options.toolVersion ?? '1',
      description,
      effect: 'read',
      replaySafe: true,
      scopes: [scope],
      input,
      output,
      timeoutMs: 2000,
      authorize: owns,
      validateResult: isolated,
      run: async (args, context, signal) => {
        options.onCall?.(name);
        if (options.fault === 'timeout' && name === 'route_eta')
          await new Promise<void>((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('fixture timeout')), {
              once: true,
            }),
          );
        if (options.fault === 'malformed' && name === 'route_eta') return { invalid: true };
        const result = run(args, context);
        if (options.fault === 'cross_user' && name === 'route_eta')
          return { ...(result as object), userId: 'someone-else' };
        return result;
      },
    });
  };
  add(
    'calendar_next',
    'Read the next in-person appointment for the authorized user and current time.',
    departureInput,
    appointment,
    'calendar:read',
    (args, context) => ({
      ...common(args, context),
      id: recordFor(args).eventId,
      startsAt: recordFor(args).startsAt,
      destination: recordFor(args).destination,
    }),
  );
  add(
    'profile_origin',
    'Read the authorized user’s saved origin.',
    z.object({ userId: z.string() }).strict(),
    profile,
    'profile:read',
    (args, context) => ({ ...common(args, context), origin: recordFor(args).origin }),
  );
  add(
    'route_eta',
    'Read travel time. Requires origin from profile_origin and destination from calendar_next.',
    z.object({ userId: z.string(), origin: z.string(), destination: z.string() }).strict(),
    route,
    'route:read',
    (args, context) => {
      const value = args as { origin: string; destination: string };
      if (
        value.origin !== recordFor(args).origin ||
        value.destination !== recordFor(args).destination
      )
        throw new Error('Unknown fixture route.');
      return { ...common(args, context), minutes: recordFor(args).minutes };
    },
  );
  add(
    'weather_forecast',
    'Read destination weather. Requires destination and startsAt from calendar_next.',
    z.object({ userId: z.string(), destination: z.string(), at: z.string() }).strict(),
    weather,
    'weather:read',
    (args, context) => ({
      ...common(args, context),
      condition: recordFor(args).rain ? 'rain' : 'clear',
      rain: recordFor(args).rain,
    }),
  );
  registry.registerTool({
    name: 'departure_calculate',
    version: '1',
    description:
      'Calculate departureTime from appointment startsAt and route travelMinutes using a fixed 15-minute arrival buffer. Requires calendar_next and route_eta.',
    effect: 'pure',
    replaySafe: true,
    scopes: [],
    input: z
      .object({
        startsAt: z.iso.datetime({ offset: true }),
        travelMinutes: z.number().int().nonnegative().max(300),
      })
      .strict(),
    output: plan,
    timeoutMs: 2000,
    authorize: (context) =>
      context.tenantId === 'local-demo' && context.principalId === 'local-operator',
    validateResult: () => true,
    run: async (args) => {
      options.onCall?.('departure_calculate');
      const value = args as { startsAt: string; travelMinutes: number };
      return {
        departureTime: new Date(
          Date.parse(value.startsAt) - (value.travelMinutes + 15) * 60000,
        ).toISOString(),
        bufferMinutes: 15,
      };
    },
  });
  registry.registerTask({
    kind: departureKind,
    version: '1',
    description:
      'Gather appointment, origin, route, weather and departure time for a personal appointment.',
    input: departureInput,
    output: departureContextSchema,
    tools: departureTools,
    maxAgeMs: 30000,
    maxConcurrency: 3,
    timeoutMs: 5000,
    authorize: owns,
  });
  return registry;
}

export async function captureDeparture(
  registry: ContractRegistry,
  input: z.infer<typeof departureInput>,
  context = departureAccess(),
) {
  const observer = new TaskObserver(registry, departureKind, input, context);
  const call = (tool: string) =>
    observer.call(departureBindings[tool].id, tool, departureBindings[tool].args);
  await Promise.all([call('calendar_next'), call('profile_origin')]);
  await Promise.all([call('route_eta'), call('weather_forecast')]);
  await call('departure_calculate');
  return observer.finish(departureOutput);
}
export function expectedDeparture(input: { userId: string }) {
  const record = records[input.userId];
  const base = { userId: input.userId, tenantId: 'local-demo', snapshot: 'personal-fixtures-v1' };
  return {
    appointment: {
      ...base,
      id: record.eventId,
      startsAt: record.startsAt,
      destination: record.destination,
    },
    profile: { ...base, origin: record.origin },
    route: { ...base, minutes: record.minutes },
    weather: { ...base, condition: record.rain ? 'rain' : 'clear', rain: record.rain },
    plan: { departureTime: record.departureTime, bufferMinutes: 15 },
  };
}
export function expectedDepartureAnswer(input: { userId: string }) {
  const record = records[input.userId];
  return {
    eventId: record.eventId,
    departureTime: record.departureTime,
    travelMinutes: record.minutes,
    bringUmbrella: record.rain,
  };
}
