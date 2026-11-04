import { z } from 'zod';
import { ContractRegistry, json, type AccessContext, type Json } from '../compiler/contracts.js';
import type { Binding } from '../compiler/task-ir.js';
import { TaskObserver } from '../exploration/task-observer.js';

export const travelKind = 'travel_day';
export const travelName = 'load_travel_day_context';
export const travelInput = z
  .object({ userId: z.string(), tripId: z.string(), now: z.iso.datetime() })
  .strict();
const owned = {
  userId: z.string(),
  tripId: z.string(),
  tenantId: z.string(),
  snapshot: z.string(),
};
const baseArgs = z.object({ userId: z.string(), tripId: z.string() }).strict();
const event = z
  .object({ id: z.string(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })
  .strict();
const tripSchema = z
  .object({
    ...owned,
    flightId: z.string(),
    hotelId: z.string(),
    originAirport: z.string(),
    destinationAirport: z.string(),
    date: z.string(),
    flightConfirmed: z.boolean(),
    hotelConfirmed: z.boolean(),
  })
  .strict();
const profileSchema = z
  .object({
    ...owned,
    origin: z.string(),
    airportBufferMinutes: z.number().int(),
    disembarkMinutes: z.number().int(),
    timezone: z.string(),
  })
  .strict();
const flightSchema = z
  .object({
    ...owned,
    flightId: z.string(),
    terminal: z.string(),
    scheduledDeparture: z.iso.datetime(),
    departure: z.iso.datetime(),
    arrival: z.iso.datetime(),
    originTimezone: z.string(),
    destinationTimezone: z.string(),
  })
  .strict();
const hotelSchema = z
  .object({ ...owned, hotelId: z.string(), address: z.string(), checkIn: z.iso.datetime() })
  .strict();
const calendarSchema = z.object({ ...owned, events: z.array(event) }).strict();
const weatherSchema = z
  .object({ ...owned, location: z.string(), rain: z.boolean(), temperatureF: z.number() })
  .strict();
const routeSchema = z
  .object({ ...owned, from: z.string(), to: z.string(), minutes: z.number().int().nonnegative() })
  .strict();
const departureSchema = z
  .object({ ...owned, leaveHomeAt: z.iso.datetime(), flightDelayMinutes: z.number().int() })
  .strict();
const arrivalSchema = z
  .object({
    ...owned,
    hotelArrival: z.iso.datetime(),
    checkInWaitMinutes: z.number().int().nonnegative(),
  })
  .strict();
const conflictsSchema = z.object({ ...owned, conflictingEventIds: z.array(z.string()) }).strict();
const readinessSchema = z
  .object({
    ...owned,
    missingItems: z.array(z.string()),
    bringUmbrella: z.boolean(),
    bringWarmLayer: z.boolean(),
    ready: z.boolean(),
  })
  .strict();
export const travelContextSchema = z
  .object({
    trip: tripSchema,
    profile: profileSchema,
    flight: flightSchema,
    hotel: hotelSchema,
    calendar: calendarSchema,
    weather_origin: weatherSchema,
    weather_destination: weatherSchema,
    route_origin: routeSchema,
    route_destination: routeSchema,
    departure: departureSchema,
    arrival: arrivalSchema,
    conflicts: conflictsSchema,
    readiness: readinessSchema,
  })
  .strict();
export const travelAnswerSchema = z
  .object({
    tripId: z.string(),
    flightId: z.string(),
    terminal: z.string(),
    leaveHomeAt: z.iso.datetime(),
    estimatedHotelArrival: z.iso.datetime(),
    checkInWaitMinutes: z.number().int().nonnegative(),
    flightDelayMinutes: z.number().int(),
    conflictingEventIds: z.array(z.string()),
    missingItems: z.array(z.string()),
    bringUmbrella: z.boolean(),
    bringWarmLayer: z.boolean(),
    ready: z.boolean(),
  })
  .strict();

type Fixture = {
  userId: string;
  flightId: string;
  hotelId: string;
  airport: string;
  terminal: string;
  scheduled: string;
  departure: string;
  arrival: string;
  checkIn: string;
  toAirport: number;
  toHotel: number;
  airportBuffer: number;
  disembark: number;
  originRain: boolean;
  destinationRain: boolean;
  originTemp: number;
  destinationTemp: number;
  flightConfirmed: boolean;
  hotelConfirmed: boolean;
  events: z.infer<typeof event>[];
};
const fixtures: Record<string, Fixture> = {
  'trip-a': {
    userId: 'alice',
    flightId: 'F100',
    hotelId: 'H100',
    airport: 'JFK',
    terminal: '4',
    scheduled: '2026-11-05T14:00:00.000Z',
    departure: '2026-11-05T14:40:00.000Z',
    arrival: '2026-11-05T17:10:00.000Z',
    checkIn: '2026-11-05T21:00:00.000Z',
    toAirport: 55,
    toHotel: 45,
    airportBuffer: 120,
    disembark: 30,
    originRain: true,
    destinationRain: false,
    originTemp: 42,
    destinationTemp: 38,
    flightConfirmed: true,
    hotelConfirmed: false,
    events: [
      {
        id: 'work-call-a',
        startsAt: '2026-11-05T12:00:00.000Z',
        endsAt: '2026-11-05T12:30:00.000Z',
      },
      { id: 'early-a', startsAt: '2026-11-05T08:00:00.000Z', endsAt: '2026-11-05T08:30:00.000Z' },
    ],
  },
  'trip-b': {
    userId: 'bob',
    flightId: 'F200',
    hotelId: 'H200',
    airport: 'BOS',
    terminal: 'B',
    scheduled: '2026-11-05T16:00:00.000Z',
    departure: '2026-11-05T16:00:00.000Z',
    arrival: '2026-11-05T18:00:00.000Z',
    checkIn: '2026-11-05T18:00:00.000Z',
    toAirport: 35,
    toHotel: 30,
    airportBuffer: 90,
    disembark: 20,
    originRain: false,
    destinationRain: false,
    originTemp: 50,
    destinationTemp: 30,
    flightConfirmed: true,
    hotelConfirmed: true,
    events: [
      { id: 'late-b', startsAt: '2026-11-05T19:30:00.000Z', endsAt: '2026-11-05T20:00:00.000Z' },
    ],
  },
  'trip-c': {
    userId: 'carol',
    flightId: 'F300',
    hotelId: 'H300',
    airport: 'EWR',
    terminal: 'C',
    scheduled: '2026-11-05T18:00:00.000Z',
    departure: '2026-11-05T17:45:00.000Z',
    arrival: '2026-11-05T20:30:00.000Z',
    checkIn: '2026-11-05T21:00:00.000Z',
    toAirport: 70,
    toHotel: 65,
    airportBuffer: 120,
    disembark: 30,
    originRain: false,
    destinationRain: true,
    originTemp: 43,
    destinationTemp: 35,
    flightConfirmed: false,
    hotelConfirmed: true,
    events: [
      { id: 'class-c', startsAt: '2026-11-05T16:00:00.000Z', endsAt: '2026-11-05T17:00:00.000Z' },
      { id: 'meeting-c', startsAt: '2026-11-05T21:00:00.000Z', endsAt: '2026-11-05T21:30:00.000Z' },
    ],
  },
};
export const travelInputs = Object.entries(fixtures).map(([tripId, value]) => ({
  userId: value.userId,
  tripId,
  now: '2026-11-04T12:00:00.000Z',
}));
export const travelAccess = (): AccessContext => ({
  tenantId: 'local-demo',
  principalId: 'local-operator',
  scopes: [
    'travel:read',
    'profile:read',
    'flights:read',
    'hotels:read',
    'calendar:read',
    'weather:read',
    'routes:read',
  ],
  policyVersion: 'travel-policy-v1',
  snapshot: 'travel-fixtures-v1',
  observedAt: Date.now(),
});
const inputBinding = (key: string): Binding => ({ source: 'input', path: [key] });
const ref = (node: string, ...path: string[]): Binding => ({ source: 'ref', node, path });
const bound = { userId: inputBinding('userId'), tripId: inputBinding('tripId') };
export const travelBindings: Record<string, { id: string; args: Record<string, Binding> }> = {
  load_trip: { id: 'trip', args: { ...bound, now: inputBinding('now') } },
  load_profile: { id: 'profile', args: bound },
  check_flight: { id: 'flight', args: { ...bound, flightId: ref('trip', 'flightId') } },
  load_hotel: { id: 'hotel', args: { ...bound, hotelId: ref('trip', 'hotelId') } },
  load_calendar: { id: 'calendar', args: { ...bound, date: ref('trip', 'date') } },
  weather_at_origin: {
    id: 'weather_origin',
    args: { ...bound, location: ref('trip', 'originAirport'), date: ref('trip', 'date') },
  },
  weather_at_destination: {
    id: 'weather_destination',
    args: { ...bound, location: ref('trip', 'destinationAirport'), at: ref('flight', 'arrival') },
  },
  route_to_airport: {
    id: 'route_origin',
    args: {
      ...bound,
      origin: ref('profile', 'origin'),
      airport: ref('trip', 'originAirport'),
      terminal: ref('flight', 'terminal'),
    },
  },
  route_to_hotel: {
    id: 'route_destination',
    args: {
      ...bound,
      airport: ref('trip', 'destinationAirport'),
      address: ref('hotel', 'address'),
    },
  },
  calculate_departure: {
    id: 'departure',
    args: {
      ...bound,
      scheduled: ref('flight', 'scheduledDeparture'),
      departure: ref('flight', 'departure'),
      minutes: ref('route_origin', 'minutes'),
      buffer: ref('profile', 'airportBufferMinutes'),
    },
  },
  calculate_arrival: {
    id: 'arrival',
    args: {
      ...bound,
      arrival: ref('flight', 'arrival'),
      minutes: ref('route_destination', 'minutes'),
      buffer: ref('profile', 'disembarkMinutes'),
      checkIn: ref('hotel', 'checkIn'),
    },
  },
  find_conflicts: {
    id: 'conflicts',
    args: {
      ...bound,
      events: ref('calendar', 'events'),
      start: ref('departure', 'leaveHomeAt'),
      end: ref('arrival', 'hotelArrival'),
    },
  },
  check_readiness: {
    id: 'readiness',
    args: {
      ...bound,
      flightConfirmed: ref('trip', 'flightConfirmed'),
      hotelConfirmed: ref('trip', 'hotelConfirmed'),
      conflicts: ref('conflicts', 'conflictingEventIds'),
      originRain: ref('weather_origin', 'rain'),
      destinationRain: ref('weather_destination', 'rain'),
      originTemp: ref('weather_origin', 'temperatureF'),
      destinationTemp: ref('weather_destination', 'temperatureF'),
    },
  },
};
export const travelLayers = [
  ['load_trip', 'load_profile'],
  ['check_flight', 'load_hotel', 'load_calendar', 'weather_at_origin'],
  ['weather_at_destination', 'route_to_airport', 'route_to_hotel'],
  ['calculate_departure', 'calculate_arrival'],
  ['find_conflicts'],
  ['check_readiness'],
];
export const travelOutput: Record<string, Binding> = Object.fromEntries(
  Object.values(travelBindings).map(({ id }) => [id, ref(id)]),
);

export function travelRegistry(
  options: { onCall?: (name: string) => void; fault?: 'malformed' | 'cross_user' } = {},
): ContractRegistry {
  const registry = new ContractRegistry();
  const owns = (context: AccessContext, args: Json) => {
    const input = args as { userId: string; tripId: string };
    return (
      context.tenantId === 'local-demo' &&
      context.principalId === 'local-operator' &&
      fixtures[input.tripId]?.userId === input.userId
    );
  };
  const common = (args: Json, context: AccessContext) => ({
    ...baseArgs.parse({ userId: (args as any).userId, tripId: (args as any).tripId }),
    tenantId: context.tenantId,
    snapshot: context.snapshot,
  });
  const add = (
    name: string,
    description: string,
    schema: z.ZodType,
    output: z.ZodType,
    scope: string | null,
    run: (args: any, fixture: Fixture) => object,
  ) =>
    registry.registerTool({
      name,
      version: '1',
      description,
      effect: scope ? 'read' : 'pure',
      scopes: scope ? [scope] : [],
      replaySafe: true,
      input: schema,
      output,
      timeoutMs: 2000,
      authorize: owns,
      validateResult: (context, args, result) => {
        const value = result as any;
        return (
          value.userId === (args as any).userId &&
          value.tripId === (args as any).tripId &&
          value.tenantId === context.tenantId &&
          value.snapshot === context.snapshot
        );
      },
      run: async (args, context) => {
        options.onCall?.(name);
        if (options.fault === 'malformed' && name === 'check_flight') return { invalid: true };
        const result = { ...common(args, context), ...run(args, fixtures[(args as any).tripId]) };
        return options.fault === 'cross_user' && name === 'check_flight'
          ? { ...result, userId: 'other-user' }
          : result;
      },
    });
  add(
    'load_trip',
    'Read the authorized trip, booking IDs, airports, date and confirmation flags. No prerequisites.',
    travelInput,
    tripSchema,
    'travel:read',
    (args, f) => {
      if (Date.parse(args.now) >= Date.parse(f.departure))
        throw new Error('Fixture trip no longer upcoming.');
      return {
        flightId: f.flightId,
        hotelId: f.hotelId,
        originAirport: f.airport,
        destinationAirport: 'ORD',
        date: '2026-11-05',
        flightConfirmed: f.flightConfirmed,
        hotelConfirmed: f.hotelConfirmed,
      };
    },
  );
  add(
    'load_profile',
    'Read saved origin and airport/disembark buffers. No prerequisites.',
    baseArgs,
    profileSchema,
    'profile:read',
    (_args, f) => ({
      origin: `Home-${f.userId}`,
      airportBufferMinutes: f.airportBuffer,
      disembarkMinutes: f.disembark,
      timezone: 'America/New_York',
    }),
  );
  add(
    'check_flight',
    'Read latest flight times and terminal. Requires load_trip.',
    baseArgs.extend({ flightId: z.string() }),
    flightSchema,
    'flights:read',
    (args, f) => {
      if (args.flightId !== f.flightId) throw new Error('Wrong flight.');
      return {
        flightId: f.flightId,
        terminal: f.terminal,
        scheduledDeparture: f.scheduled,
        departure: f.departure,
        arrival: f.arrival,
        originTimezone: 'America/New_York',
        destinationTimezone: 'America/Chicago',
      };
    },
  );
  add(
    'load_hotel',
    'Read hotel address and check-in time. Requires load_trip.',
    baseArgs.extend({ hotelId: z.string() }),
    hotelSchema,
    'hotels:read',
    (args, f) => {
      if (args.hotelId !== f.hotelId) throw new Error('Wrong hotel.');
      return { hotelId: f.hotelId, address: `Hotel-${f.hotelId}`, checkIn: f.checkIn };
    },
  );
  add(
    'load_calendar',
    'Read calendar events for trip date. Requires load_trip.',
    baseArgs.extend({ date: z.string() }),
    calendarSchema,
    'calendar:read',
    (_args, f) => ({ events: f.events }),
  );
  add(
    'weather_at_origin',
    'Read origin-airport weather for the trip date. Requires load_trip.',
    baseArgs.extend({ location: z.string(), date: z.string() }),
    weatherSchema,
    'weather:read',
    (args, f) => ({ location: args.location, rain: f.originRain, temperatureF: f.originTemp }),
  );
  add(
    'weather_at_destination',
    'Read arrival weather. Requires load_trip and check_flight.',
    baseArgs.extend({ location: z.string(), at: z.string() }),
    weatherSchema,
    'weather:read',
    (args, f) => ({
      location: args.location,
      rain: f.destinationRain,
      temperatureF: f.destinationTemp,
    }),
  );
  add(
    'route_to_airport',
    'Read ground travel to correct terminal. Requires load_trip, load_profile and check_flight.',
    baseArgs.extend({ origin: z.string(), airport: z.string(), terminal: z.string() }),
    routeSchema,
    'routes:read',
    (args, f) => ({
      from: args.origin,
      to: `${args.airport}-${args.terminal}`,
      minutes: f.toAirport,
    }),
  );
  add(
    'route_to_hotel',
    'Read airport-to-hotel travel. Requires load_trip and load_hotel.',
    baseArgs.extend({ airport: z.string(), address: z.string() }),
    routeSchema,
    'routes:read',
    (args, f) => ({ from: args.airport, to: args.address, minutes: f.toHotel }),
  );
  add(
    'calculate_departure',
    'Compute leave-home UTC time and flight delay. Requires check_flight, load_profile and route_to_airport.',
    baseArgs.extend({
      scheduled: z.iso.datetime(),
      departure: z.iso.datetime(),
      minutes: z.number(),
      buffer: z.number(),
    }),
    departureSchema,
    null,
    (args) => ({
      leaveHomeAt: new Date(
        Date.parse(args.departure) - (args.minutes + args.buffer) * 60000,
      ).toISOString(),
      flightDelayMinutes: (Date.parse(args.departure) - Date.parse(args.scheduled)) / 60000,
    }),
  );
  add(
    'calculate_arrival',
    'Compute hotel arrival UTC and minutes until check-in. Requires check_flight, load_profile, route_to_hotel and load_hotel.',
    baseArgs.extend({
      arrival: z.iso.datetime(),
      minutes: z.number(),
      buffer: z.number(),
      checkIn: z.iso.datetime(),
    }),
    arrivalSchema,
    null,
    (args) => {
      const arrival = Date.parse(args.arrival) + (args.minutes + args.buffer) * 60000;
      return {
        hotelArrival: new Date(arrival).toISOString(),
        checkInWaitMinutes: Math.max(0, (Date.parse(args.checkIn) - arrival) / 60000),
      };
    },
  );
  add(
    'find_conflicts',
    'Find calendar events overlapping the travel window. Requires load_calendar, calculate_departure and calculate_arrival.',
    baseArgs.extend({ events: z.array(event), start: z.iso.datetime(), end: z.iso.datetime() }),
    conflictsSchema,
    null,
    (args) => ({
      conflictingEventIds: args.events
        .filter(
          (entry: z.infer<typeof event>) =>
            Date.parse(entry.startsAt) < Date.parse(args.end) &&
            Date.parse(entry.endsAt) > Date.parse(args.start),
        )
        .map((entry: z.infer<typeof event>) => entry.id)
        .sort(),
    }),
  );
  add(
    'check_readiness',
    'Check missing confirmations and conflicts; umbrella if either location has rain, warm layer if either temperature is <=40 F; ready only if no missing confirmations/conflicts. Requires load_trip, find_conflicts, weather_at_origin and weather_at_destination.',
    baseArgs.extend({
      flightConfirmed: z.boolean(),
      hotelConfirmed: z.boolean(),
      conflicts: z.array(z.string()),
      originRain: z.boolean(),
      destinationRain: z.boolean(),
      originTemp: z.number(),
      destinationTemp: z.number(),
    }),
    readinessSchema,
    null,
    (args) => {
      const missingItems = [
        ...(!args.flightConfirmed ? ['flight_confirmation'] : []),
        ...(!args.hotelConfirmed ? ['hotel_confirmation'] : []),
      ];
      return {
        missingItems,
        bringUmbrella: args.originRain || args.destinationRain,
        bringWarmLayer: Math.min(args.originTemp, args.destinationTemp) <= 40,
        ready: missingItems.length === 0 && args.conflicts.length === 0,
      };
    },
  );
  registry.registerTask({
    kind: travelKind,
    version: '1',
    description:
      'Prepare a one-flight, one-hotel travel day with two ground journeys, conflicts, weather and readiness checks.',
    input: travelInput,
    output: travelContextSchema,
    tools: Object.keys(travelBindings),
    maxAgeMs: 60000,
    maxConcurrency: 4,
    timeoutMs: 10000,
    authorize: owns,
  });
  return registry;
}

export async function captureTravel(
  registry: ContractRegistry,
  input: z.infer<typeof travelInput>,
  context = travelAccess(),
) {
  const observer = new TaskObserver(registry, travelKind, input, context);
  for (const layer of travelLayers)
    await Promise.all(
      layer.map((name) => observer.call(travelBindings[name].id, name, travelBindings[name].args)),
    );
  return observer.finish(travelOutput);
}
const answers = {
  'trip-a': {
    tripId: 'trip-a',
    flightId: 'F100',
    terminal: '4',
    leaveHomeAt: '2026-11-05T11:45:00.000Z',
    estimatedHotelArrival: '2026-11-05T18:25:00.000Z',
    checkInWaitMinutes: 155,
    flightDelayMinutes: 40,
    conflictingEventIds: ['work-call-a'],
    missingItems: ['hotel_confirmation'],
    bringUmbrella: true,
    bringWarmLayer: true,
    ready: false,
  },
  'trip-b': {
    tripId: 'trip-b',
    flightId: 'F200',
    terminal: 'B',
    leaveHomeAt: '2026-11-05T13:55:00.000Z',
    estimatedHotelArrival: '2026-11-05T18:50:00.000Z',
    checkInWaitMinutes: 0,
    flightDelayMinutes: 0,
    conflictingEventIds: [],
    missingItems: [],
    bringUmbrella: false,
    bringWarmLayer: true,
    ready: true,
  },
  'trip-c': {
    tripId: 'trip-c',
    flightId: 'F300',
    terminal: 'C',
    leaveHomeAt: '2026-11-05T14:35:00.000Z',
    estimatedHotelArrival: '2026-11-05T22:05:00.000Z',
    checkInWaitMinutes: 0,
    flightDelayMinutes: -15,
    conflictingEventIds: ['class-c', 'meeting-c'],
    missingItems: ['flight_confirmation'],
    bringUmbrella: true,
    bringWarmLayer: true,
    ready: false,
  },
};
export const expectedTravelAnswer = (input: { tripId: string }) =>
  json(answers[input.tripId as keyof typeof answers]);
export function expectedTravelContext(input: { userId: string; tripId: string }): Json {
  const f = fixtures[input.tripId];
  const a = answers[input.tripId as keyof typeof answers];
  const base = {
    userId: input.userId,
    tripId: input.tripId,
    tenantId: 'local-demo',
    snapshot: 'travel-fixtures-v1',
  };
  return json({
    trip: {
      ...base,
      flightId: f.flightId,
      hotelId: f.hotelId,
      originAirport: f.airport,
      destinationAirport: 'ORD',
      date: '2026-11-05',
      flightConfirmed: f.flightConfirmed,
      hotelConfirmed: f.hotelConfirmed,
    },
    profile: {
      ...base,
      origin: `Home-${f.userId}`,
      airportBufferMinutes: f.airportBuffer,
      disembarkMinutes: f.disembark,
      timezone: 'America/New_York',
    },
    flight: {
      ...base,
      flightId: f.flightId,
      terminal: f.terminal,
      scheduledDeparture: f.scheduled,
      departure: f.departure,
      arrival: f.arrival,
      originTimezone: 'America/New_York',
      destinationTimezone: 'America/Chicago',
    },
    hotel: { ...base, hotelId: f.hotelId, address: `Hotel-${f.hotelId}`, checkIn: f.checkIn },
    calendar: { ...base, events: f.events },
    weather_origin: {
      ...base,
      location: f.airport,
      rain: f.originRain,
      temperatureF: f.originTemp,
    },
    weather_destination: {
      ...base,
      location: 'ORD',
      rain: f.destinationRain,
      temperatureF: f.destinationTemp,
    },
    route_origin: {
      ...base,
      from: `Home-${f.userId}`,
      to: `${f.airport}-${f.terminal}`,
      minutes: f.toAirport,
    },
    route_destination: { ...base, from: 'ORD', to: `Hotel-${f.hotelId}`, minutes: f.toHotel },
    departure: { ...base, leaveHomeAt: a.leaveHomeAt, flightDelayMinutes: a.flightDelayMinutes },
    arrival: {
      ...base,
      hotelArrival: a.estimatedHotelArrival,
      checkInWaitMinutes: a.checkInWaitMinutes,
    },
    conflicts: { ...base, conflictingEventIds: a.conflictingEventIds },
    readiness: {
      ...base,
      missingItems: a.missingItems,
      bringUmbrella: a.bringUmbrella,
      bringWarmLayer: a.bringWarmLayer,
      ready: a.ready,
    },
  });
}
