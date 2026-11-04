import type { GenericTaskOptions } from '../src/registry/tasks.js';
import {
  captureTravel,
  expectedTravelContext,
  travelAccess,
  travelInput,
  travelInputs,
  travelRegistry,
} from '../src/examples/travel-day.js';

// Synthetic integration example. Production applications supply their own data and access rules.
export function createTaskOptions(): GenericTaskOptions {
  const registry = travelRegistry();
  return {
    registry,
    context: travelAccess,
    verificationCases: () =>
      travelInputs.map((input) => ({ input, expected: expectedTravelContext(input) })),
    native: async (_kind, input, context) =>
      (await captureTravel(registry, travelInput.parse(input), context)).result,
  };
}
