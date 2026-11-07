# Reusing selection across read-only workflows

Repetition does not establish safety, equivalence or profitability. A repeated task may depend on
new facts, judgment, different permissions or irreversible actions. Foundry does not automatically
compile arbitrary repetitive tasks. Its executable v2 capability remains customer-context retrieval.

The SDK now exports `createReadWorkflowSelector`, a reusable deterministic routing policy for
other application-owned read-only workflows. The existing customer selector delegates to it and
retains its contracts, modes, reasons, cost veto, candidate guards and default behavior. The new
policy does not add a second compiler or executor, new adapters or a new capability family.

## What an integration supplies

1. A bounded list of uniquely named operations, each explicitly declared `effect: 'read'`.
   Names and contract reads are schema-checked; write declarations are rejected. Declaring a
   read does not prove its implementation has no effects: the integration must verify that.
2. A synchronous authorization function that validates inputs, tenant/principal identity, scopes
   and record access. It returns `undefined` on success and throws on denial. Non-void or
   asynchronous authorization fails closed. No-read/public tasks must have appropriate explicit
   authorization semantics rather than requiring unrelated private-record access.
3. Code-registered task contracts: exact known reads, explicitly supported subsets, or a complete
   set the agent may decide whether to retrieve. Contracts are immutable and scoped to the
   selector instance. Copied JSON, model output and contracts from another selector cannot opt
   into optimization.
4. A synchronous per-selection readiness callback returning `{ status: 'ready' }`,
   `{ status: 'unavailable', reason }`, or `{ status: 'denied', reason }`. It must evaluate the
   actual validated execution path, including subset prerequisites, approval, compatibility,
   freshness and security. Broken or malformed checks fail closed as denial. A readiness check
   must not optimistically return ready simply because task metadata is valid.
5. A separately validated read-only execution path and original authorized fallback. The host
   application must honor the decision and recheck runtime guards at execution. The factory
   does not validate or execute generated code, register a new IR opcode, implement remote
   rollout or issue approval/signatures.

For example, an inventory application could register `inventory.stock` and `catalog.price`;
a document application could register `documents.metadata` and `documents.permissions`.
These are fixture routing examples in tests, not shipped connectors or compiled capabilities.

```ts
import { createReadWorkflowSelector } from '@foundry/read-runtime';

// The application implements these against its own validated runtime and authorization rules.
type InventoryRead = 'inventory.stock' | 'catalog.price';
type InventoryContext = { tenantId: string; principalId: string };
declare function authorizeInventory(
  input: unknown,
  context: InventoryContext,
  reads: readonly InventoryRead[],
): undefined;

const inventory = createReadWorkflowSelector<InventoryRead, InventoryContext>({
  operations: [
    { name: 'inventory.stock', effect: 'read' },
    { name: 'catalog.price', effect: 'read' },
  ],
  supportsSubsets: true, // Only if the validated execution path actually supports them.
  authorize: authorizeInventory,
});

const contract = inventory.defineContract({
  requirement: 'subset',
  reads: ['inventory.stock'],
});
// inventory.select(contract, input, context, {
//   readiness: resources => yourRuntime.checkReadiness(input, context, resources),
//   prefetchCostComparison: yourComparableMeasuredProfile, // optional; never fixture pricing
// });
```

## Placement and safety rules

- `known` complete contract: recommend prefetch if readiness and optional economics pass.
- `subset`: recommend only the requested resources if subset execution is supported and its
  prerequisite/security checks pass. Resource order follows the registered operation order.
- `agent_decides` complete contract: offer the validated tool, with no prefetch resources.
- `known` partial, no-read or unsupported subset: normal execution. Model-selected partial tools
  after reasoning remain a separate next milestone, not implemented by this extraction.
- Authorization/readiness denial: terminal denial, not ordinary fallback. Unavailability selects
  normal execution, whose original tools must independently enforce authorization.
- Equal/higher measured prefetch cost or malformed supplied cost evidence: normal execution.
  Omitted cost evidence preserves the contract/readiness decision. Do not interpret absent costs
  as zero. Profile comparability remains the application's responsibility.

The policy adds no model calls, network requests, database or learning process. It checks at most
64 declared operations and invokes application-supplied synchronous guards. Those guards must stay
bounded; the factory does not sandbox application code or guarantee its runtime. Selector duration
includes authorization/readiness validation; complete application cost must also include execution,
fallback, telemetry, setup and revalidation as appropriate.

## Evidence and limits

Local tests cover inventory/document routing, cross-selector and forged contracts, unauthorized
tasks, unsupported subsets, unavailable and broken guards, cost vetoes, write declarations and
asynchronous authorization. Existing customer runtime/equivalence tests cover the preserved path.
No model requests or live benchmark runs were used for this change. No savings, full-context
equivalence, or working compiled execution are claimed for inventory, documents or arbitrary tasks.

To onboard an actual additional workflow, provide its typed adapters, evidence, independent oracle,
equivalence/failure tests, approval and fallback integration. Work involving writes, payments,
open-ended research or creative judgment needs additional design and cannot be enabled merely by
registering a contract. Normal agent execution remains necessary for unsupported portions.
