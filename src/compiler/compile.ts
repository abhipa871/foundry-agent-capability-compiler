import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  inputSchema,
  operations,
  scopes,
  type Capability,
  type Policy,
  type Trajectory,
} from '../domain.js';

export function compile(
  trajectory: Trajectory,
  policy: Policy,
  version: number,
  contractVersion: number,
): Capability {
  const implementation = `// Compiled from trajectory ${trajectory.id}\n// Deterministic plan v${version}; runtime adapter contract ${contractVersion}\nexport async function ${trajectory.name}(input, ctx) {\n  const args = ctx.validate(input);\n  const shipments = await ctx.shipments.list(args.delay_days);\n  ctx.policy.authorize(shipments, args.credit_amount);\n  return ctx.transaction(async () => {\n    for (const shipment of shipments) {\n      await ctx.credits.issue(shipment, args.credit_amount);\n      await ctx.crm.update(shipment, "credited");\n      await ctx.notifications.send(shipment.owner);\n    }\n    return ctx.receipt();\n  });\n}\n`;
  const base = {
    id: randomUUID(),
    name: trajectory.name,
    version,
    trajectoryId: trajectory.id,
    createdAt: new Date().toISOString(),
    status: 'draft' as const,
    description:
      'Resolve delayed shipments with customer credits, CRM updates, and owner notifications.',
    operations: [...operations],
    policy,
    contractVersion,
    inputSchema: z.toJSONSchema(inputSchema),
    outputSchema: {
      type: 'object',
      required: ['customers', 'totalCredit', 'effects', 'attempts'],
      properties: {
        customers: { type: 'integer', minimum: 0 },
        totalCredit: { type: 'number', minimum: 0 },
        effects: { type: 'array', items: { type: 'object' } },
        attempts: { type: 'integer', minimum: 1 },
      },
    },
    implementation,
    checks: [],
    requiredScopes: [...scopes],
    sideEffects: ['Customer credit', 'CRM resolution update', 'Account-manager notification'],
    invariants: [
      'Only eligible shipments strictly beyond delay_days',
      'No duplicate credit per shipment',
      'Atomic local demo writes',
      'Policy checked on every execution',
      ...(trajectory.branchAnalysis ? ['Raw failed branches excluded from the runtime plan'] : []),
    ],
    sourceEventIds: trajectory.branchAnalysis?.keptEventIds,
    discardedBranches: trajectory.branchAnalysis?.discarded,
  };
  return { ...base, digest: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}
