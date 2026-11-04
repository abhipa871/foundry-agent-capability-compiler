import {
  captureDeparture,
  departureAccess,
  departureInput,
  departureInputs,
  departureRegistry,
  expectedDeparture,
} from '../src/examples/departure.js';
import type { GenericTaskOptions } from '../src/registry/tasks.js';

// Trusted application module. Replace synthetic handlers and ownership rules with your own.
export function createTaskOptions(): GenericTaskOptions {
  const registry = departureRegistry();
  return {
    registry,
    context: departureAccess,
    verificationCases: () =>
      departureInputs.map((input) => ({ input, expected: expectedDeparture(input) })),
    native: async (_kind, input, context) =>
      (await captureDeparture(registry, departureInput.parse(input), context)).result,
  };
}
