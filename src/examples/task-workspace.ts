import { ContractRegistry, type Json } from '../compiler/contracts.js';
import { DomainError } from '../domain.js';
import type { GenericTaskOptions } from '../registry/tasks.js';
import { localIdentity } from '../security/identity.js';
import {
  captureDeparture,
  departureAccess,
  departureInput,
  departureInputs,
  departureKind,
  departureRegistry,
  expectedDeparture,
} from './departure.js';
import {
  captureTravel,
  expectedTravelContext,
  travelAccess,
  travelInput,
  travelInputs,
  travelKind,
  travelRegistry,
} from './travel-day.js';

// Server-owned, synthetic examples. No provider calls, credentials, or user-uploaded code.
export function createDemoTaskWorkspace() {
  const registry = new ContractRegistry();
  for (const source of [departureRegistry(), travelRegistry()]) {
    for (const tool of source.catalog().tools) registry.registerTool(source.tool(tool.name));
    for (const task of source.catalog().tasks) registry.registerTask(source.task(task.kind));
  }
  const context = (kind?: string) => (kind === departureKind ? departureAccess() : travelAccess());
  const capture = async (kind: string, input: Json, access = context(kind)) => {
    if (kind === travelKind) return captureTravel(registry, travelInput.parse(input), access);
    if (kind === departureKind)
      return captureDeparture(registry, departureInput.parse(input), access);
    throw new DomainError('Example task not found.', 404);
  };
  const tasks: GenericTaskOptions = {
    registry,
    context,
    verificationCases: (kind) =>
      kind === travelKind
        ? travelInputs.map((input) => ({ input, expected: expectedTravelContext(input) }))
        : departureInputs.map((input) => ({ input, expected: expectedDeparture(input) })),
    native: async (kind, input, access) => (await capture(kind, input, access)).result,
  };
  return {
    tasks,
    identity: {
      ...localIdentity,
      toolScopes: [
        ...new Set([
          ...localIdentity.toolScopes,
          ...registry.catalog().tools.flatMap((tool) => tool.scopes),
        ]),
      ],
    },
    examples: [
      ...travelInputs.map((input) => ({
        kind: travelKind,
        label: `${input.tripId} (${input.userId})`,
        input,
      })),
      ...departureInputs.map((input) => ({ kind: departureKind, label: input.userId, input })),
    ],
    samples: async (kind: string) => {
      const inputs =
        kind === travelKind ? travelInputs : kind === departureKind ? departureInputs : undefined;
      if (!inputs) throw new DomainError('No fixture evidence for this task.', 404);
      return Promise.all(inputs.slice(0, 2).map((input) => capture(kind, input)));
    },
  };
}
