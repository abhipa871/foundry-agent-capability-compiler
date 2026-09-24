# Agent JIT Compiler — Product Thesis and Implementation Design

> **Status:** Proposed architecture and engineering plan, grounded in the supplied `Agent JIT Compiler.zip` prototype. This is a design document, **not** a claim that the full JIT system is implemented today.
>
> **North star:** An agent should not have to reason through the same _reusable computation_ every time it encounters a related task.

## 0. Executive summary

Agent JIT is an adaptive execution layer that observes agent tool-use trajectories, identifies reusable computations, compiles the supported portions into typed executable programs, verifies those programs, and dispatches future compatible tasks to them. When execution reaches an unsupported situation, the system checkpoints its state and hands control to an agent. An agent-resolved exception can become a new, independently verified specialization.

**Do not pitch it as:** “An agent that automatically writes `SKILL.md` files,” “a workflow recorder,” “an LLM that writes scripts,” or “a replacement for subagents.” Those are useful interfaces, but they are not the core differentiation.

**Pitch it as:** “A profile-guided, guarded JIT runtime for agent workflows: it turns recurring agent experience into executable software and spends inference only where it is still needed.”

**The three contributions to implement and demonstrate:**

1. **Trace-to-program compilation.** Infer data dependencies, parameters, effects, and reusable subgraphs from structured trajectories, then generate an actual executable artifact.
2. **Guarded partial execution + deoptimization.** Run only when schema, environment, permissions, freshness, and semantic guards hold; otherwise transfer a precise checkpoint to an agent rather than restarting the task.
3. **Incremental specialization.** Observe the agent's recovery from a new case; propose and test a new branch; deploy a versioned capability while retaining safe rollback.

A fourth, later contribution is **profile-guided profitability:** compile and optimize only when expected reuse justifies the compile/verify/maintenance cost.

---

## 1. The real distinction from `SKILL.md` and subagents

An agent skill can contain instructions **and** executable scripts. A strong manually engineered skill can already reduce tokens, bypass LLM steps, validate inputs, and call APIs. Therefore the distinction cannot be “Markdown versus code” or even “LLM versus no LLM.”

| Question                    | Skill / subagent                                                | Proposed Agent JIT                                                                                       |
| --------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Who discovers the workflow? | Normally the developer, or another tool that generates a skill  | A compiler infers it from execution evidence                                                             |
| Unit of reuse               | Named skill, script, or delegated task                          | Parameterized subgraph that may occur _inside many_ skills and tasks                                     |
| Optimization target         | Instructions and authored code                                  | The actual computation: redundant reads, dependency-aware parallelism, batching, guarded specialization  |
| Repeated orchestration      | Agent typically decides what to invoke                          | Runtime can dispatch a compatible subgraph directly                                                      |
| Unfamiliar input            | Agent improvises under skill instructions                       | Runtime fails a guard, emits checkpoint, transfers to agent, later learns an optional specialization     |
| Evolution                   | Edit the skill/script or run a separate skill-generation system | Profile → compile candidate → differential tests → approve → dispatch new version                        |
| Trust                       | Depends on skill developer and tools                            | Typed contracts, capability scopes, effect ledger, independent invariants, version pinning, review gates |

**Precise claim:** Agent JIT automates the _life cycle of converting observed agent computation into optimized, executable, guarded capabilities_. An equally sophisticated system packaged inside `SKILL.md` is not fundamentally different; the system, not the file format, is the contribution.

**Compatible design:** expose approved capabilities through `SKILL.md`, MCP, HTTP, a TypeScript SDK, or a subagent tool. Those are front ends to the same runtime registry.

### The non-trivial demo moment

1. An agent resolves a new shipment exception and generates a structured trace.
2. The compiler discovers a reusable subgraph and produces a verified artifact.
3. A related request takes the fast path: **no model invocation for that subgraph**.
4. A partial-refund case misses a semantic guard, and execution transfers to the agent with completed effects recorded.
5. The agent resolves it. A new branch is compiled and tested.
6. The next comparable partial-refund case takes a newly verified fast path.

This is a much stronger story than “we saved the agent's steps to a skill.”

---

## 2. Ground truth: what the supplied prototype actually does

The existing code has real building blocks: Zod schemas, a branch-pruning demo, an explicit capability lifecycle (`draft` / `verified` / `approved`), policy checks, versioned registry, local SQLite transactions, idempotency by run key, drift simulation, tests, local API, and an operator UI. Preserve them.

The current limitations are specific:

| Existing file                   | Observed limitation                                                                                                                           | Design change                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/domain.ts`                 | `operations` enumerates four shipment operations; `trajectorySchema.steps` requires exactly four; run input is `delay_days` / `credit_amount` | Define generic operation contracts, event schemas, IR, dispatch guards, checkpoint and effect records. Keep old demo types under `examples/shipping/` during migration.                                |
| `src/exploration/capture.ts`    | Selects a successful path matching the fixed operation order; parent lineage does not prove data or causal dependency                         | Capture input/output references and true data/control/effect edges; preserve failed paths as _exception evidence_, not merely discard them.                                                            |
| `src/compiler/compile.ts`       | `implementation` is a fixed late-shipment TypeScript string irrespective of input trace structure                                             | Build IR from evidence; compile supported operations from IR; create artifact digest from IR, adapter contract versions, guard/policy versions, and generated output.                                  |
| `src/runtime/execute.ts`        | Interprets the fixed four-operation plan against local shipment fixtures; it does not execute `cap.implementation`                            | Add a generic, constrained IR interpreter **first** (counts as genuine compiled execution), then optionally emit a restricted TS module.                                                               |
| `src/verification/verify.ts`    | Strong demo checks, but hardcoded shipment fixture and outcome                                                                                | Test the _candidate IR/artifact itself_, compare normalized observable results, generate boundary/fault tests, validate allowed effects.                                                               |
| `src/service.ts`                | `deployCodingAgentSession()` prompts Codex again with a summarized trajectory                                                                 | Split into `captureAgentSession`, `compileCandidate`, `verifyCandidate`, `approve`, `runCompiledOrFallback`; do not call re-prompting “deployment.”                                                    |
| `src/agent/codex.ts`            | Converts Codex events into simplified operation/description events; not enough for argument/dataflow inference                                | Instrument actual tool invocation boundaries or a controlled wrapper, including arguments/results, timestamps, resource keys, versions, and effects. Do not infer tool calls from free-form summaries. |
| `src/registry/store.ts`         | Stores versions and local demo effects; local compensation removes rows                                                                       | Persist artifacts, profiles, checkpoints, dispatch decisions, and per-external-operation effect records; distinguish local rollback from real-world compensation.                                      |
| `src/app.ts`, `src/web/App.tsx` | Existing capture/compile/approve/run flow is oriented around the fixed demo                                                                   | Surface IR diff, guards, covered input classes, dispatch mode, checkpoint/recovery, and measured cost by run.                                                                                          |

**Important technical honesty:** today, a generated TypeScript `implementation` string in the capability record does _not_ establish that the string is actually run. Today, rerunning Codex with a better prompt does _not_ demonstrate the absence of agent reasoning. The first milestone below closes these gaps.

---

## 3. Scope the first real workload

### Initial use case: enterprise support exception handling

Support workflows have recurring reads and parameterized decisions, but they also have rare exceptions. They demonstrate why partial compilation is more useful than whole-workflow caching.

Mock adapters at first:

- Shipping: `shipping.getDelayedOrders`, `shipping.getOrder`
- CRM: `crm.getCustomer`, `crm.updateCase`
- Payments: `payments.getRefundHistory`, `payments.issueCredit`
- Notifications: `notifications.sendOwnerNotice`

A task might be “find orders delayed more than five days; issue eligible accounts a $20 credit and notify account managers.” The system must enforce independently supplied rules for eligibility, refund amount, spending cap, approval, and duplicate-credit prevention. Never infer permission from an agent having done something once.

**Best first demonstrated reusable unit:** `load_customer_context(customerId)` combines independent CRM/order/refund-history reads. It is read-only, easy to optimize, and avoids committing money during the first true compiler demo.

**Second demonstrated unit:** guarded credit issuance with durable effect records, exact idempotency, explicit approvals, and exception fallback. Do not run real transfers in the first iteration; use fixture-backed/sandboxed providers.

### Why this is better than a coding agent as the _first_ target

Coding trajectories include open-ended reasoning and repository-specific edits, making it difficult to infer safe reusable computation from sparse summaries. Keep the Codex integration for later as a trace source and a fallback executor. Use a constrained typed business-tool environment to establish the compiler/runtime thesis first. After it works, apply it to coding-agent subgraphs (read-only repository inspection, schema checks, test execution, package metadata discovery), not arbitrary code edits on day one.

---

## 4. Proposed architecture

```text
                  Agent + skills + MCP/tools
                            |
                   Structured event capture
                            |
               Trace normalizer / provenance DAG
                            |
              Pattern miner + parameter inference
                            |
                         Typed IR
                            |
           Optimization passes + guard inference
                            |
            Candidate artifact + contract manifest
                            |
      Sandboxed differential tests + invariants + faults
                            |
                 Review / approve / version
                            |
                   Capability registry
                            |
             Guarded runtime dispatcher
                   /                 \
          Compiled fast path       Agent slow path
                   \                 /
                  Checkpoint + effect ledger
                            |
               New exception trace / profiles
                            |
                     Recompile candidate
```

### Control-plane / data-plane split

- **Control plane:** capture, mining, compilation, testing, approval, registry, versioning, profitability decisions. May use an LLM to propose parameter mappings or predicates, but those proposals are not authoritative.
- **Data plane:** schema and guard checking, deterministic IR execution, provider adapters, checkpoints, effect recording, and agent handoff. Dispatch should not itself require an LLM for recognized typed tasks.
- **Profiling plane:** timings, tokens, retries, costs, failure reasons, guard misses, invariant violations, and observed task frequencies. It informs optimization but cannot override safety guards.

---

## 5. Concrete data contracts

The key implementation detail is to stop using event descriptions as if they were a program.

### 5.1 Structured event schema (TypeScript sketch)

```ts
type ToolEvent = {
  eventId: string;
  traceId: string;
  parentSpanId?: string; // observability lineage, NOT automatically a dependency
  startMs: number;
  endMs: number;
  adapterId: string;
  adapterVersion: string;
  operation: string;
  args: unknown; // redact secrets before persistence
  result?: unknown; // may store hash + typed projection instead
  status: 'success' | 'failed' | 'skipped';
  errorClass?: string;
  reads: ResourceRef[];
  writes: ResourceRef[];
  explicitInputRefs: ValueRef[];
  policyVersion: string;
  credentialScopeIds: string[]; // identifiers, NOT credentials
};

type ResourceRef = {
  system: string;
  kind: string;
  key: string;
  observedVersion?: string;
};

type ValueRef = { producerEventId: string; outputPath: string };
```

**Trace-capture rule:** keep provenance separate from chronology. `parentSpanId`, temporal order, and actual value-dependency are three different concepts. A node can only be reordered if data dependencies and effect constraints permit it.

**Security rule:** use adapters to redact secrets/PII and record only needed typed projections; do not persist raw model context or unrestricted tool outputs by default.

### 5.2 Intermediate representation

Start with a small, safe IR instead of transpiling arbitrary observed natural-language steps.

```ts
type IRNode = {
  id: string;
  opcode: 'adapter.read' | 'adapter.write' | 'filter' | 'map' | 'branch' | 'join';
  operation?: string;
  args: Record<string, IRExpr>;
  deps: string[];
  effect: 'pure' | 'read' | 'write' | 'external_write';
  requiredScopes: string[];
  outputSchemaId: string;
};

type CapabilityIR = {
  name: string;
  version: number;
  inputsSchemaId: string;
  outputsSchemaId: string;
  nodes: IRNode[];
  guards: Guard[];
  invariants: Invariant[];
  adapterVersions: Record<string, string>;
  policyVersion: string;
  provenance: { traceIds: string[]; eventIds: string[] };
};
```

Never execute LLM-produced JS with `eval` or `new Function`. Compile to a whitelisted IR interpreted by trusted adapters. A later TS backend can generate source for inspection/packaging but must run in a restricted execution environment and obey the same contracts.

### 5.3 Example compiled IR

```json
{
  "name": "load_customer_context",
  "version": 1,
  "nodes": [
    {
      "id": "customer",
      "opcode": "adapter.read",
      "operation": "crm.getCustomer",
      "args": { "customerId": { "input": "customerId" } },
      "deps": [],
      "effect": "read",
      "requiredScopes": ["crm:read"],
      "outputSchemaId": "customer.v1"
    },
    {
      "id": "orders",
      "opcode": "adapter.read",
      "operation": "orders.list",
      "args": { "customerId": { "input": "customerId" } },
      "deps": [],
      "effect": "read",
      "requiredScopes": ["orders:read"],
      "outputSchemaId": "orders.v1"
    },
    {
      "id": "refunds",
      "opcode": "adapter.read",
      "operation": "payments.refundHistory",
      "args": { "customerId": { "input": "customerId" } },
      "deps": [],
      "effect": "read",
      "requiredScopes": ["payments:read"],
      "outputSchemaId": "refunds.v1"
    }
  ],
  "guards": [{ "kind": "input_schema", "schemaId": "customer_id.v1" }],
  "invariants": [{ "kind": "customer_id_matches", "field": "customerId" }],
  "adapterVersions": { "crm": "1", "orders": "1", "payments": "1" },
  "policyVersion": "1",
  "provenance": { "traceIds": ["trace-a", "trace-b"], "eventIds": ["e1", "e2", "e3"] }
}
```

This example intentionally shows three independent reads. The scheduler can run them concurrently if consistency and rate-limit contracts allow it. Do not claim the compiler inferred independence merely because calls appear sequentially in a log.

---

## 6. The compiler: exactly what it does

### Phase A — Normalize and validate

1. Capture typed tool invocations at the adapter boundary.
2. Resolve explicit input references, not just common argument strings.
3. Build a DAG with value, control, and effect dependencies.
4. Preserve error branches for candidate exception handling.
5. Reject traces with missing outcomes, ambiguous side effects, or unsupported operations; allow **partial** compilation of clearly supported nodes.

### Phase B — Discover reusable patterns

Use exact typed-operation matching initially, then parameterize arguments:

```text
crm.getCustomer("C-101") + orders.list("C-101")
crm.getCustomer("C-202") + orders.list("C-202")
                 ->
crm.getCustomer(X) + orders.list(X)
```

Only generalize a literal to a parameter when data lineage or repeated evidence supports that binding. Similar strings are insufficient proof of semantic equivalence.

For MVP: compare normalized subgraph signatures composed of opcode, adapter contract, effect class, and dependency topology. Later add anti-unification, canonical graph hashes, and small frequent-subgraph mining. Avoid claiming general graph mining until implemented.

### Phase C — Apply safe compiler passes

Implement in this order:

1. **Constant/parameter extraction:** determine caller-supplied vs invariant values.
2. **Dead exploratory branch removal:** remove truly abandoned operations, but retain failed-call evidence for exception learning; do not remove policy checks.
3. **Redundant read elimination:** only if same arguments, principal, version, and freshness window; never coalesce writes.
4. **Dependency-aware scheduling:** parallelize independent reads with explicit read-consistency and rate-limit bounds.
5. **Read fusion/batching:** only when an adapter exposes a proven equivalent bulk API.
6. **Guarded specialization:** create distinct paths for supported input classes (e.g. no prior refund vs partial refund).

Every compiler pass must have a test proving it preserves relevant observable behavior on the supported domain.

### Phase D — Emit executable artifact + manifest

Artifact contains IR, schemas, adapter-version requirements, required scopes, effect declarations, guards, invariants, provenance, compiler version, and content digest. Store optional human-readable TS as a _derived artifact_. Runtime executes the actual IR / packaged backend, not a separately hardcoded shipment function.

### Phase E — Verify and approve

- Verify IR structural validity, forbidden operations, required scopes, and policy-version compatibility.
- Run boundary, property, and fault-injection tests.
- Compare original and compiled _observable results_, rather than expecting identical API call order or email wording.
- For externally visible writes, verify exact affected IDs, amounts, decision predicates, and idempotency behavior.
- Require explicit human approval for new write-effect behavior. Read-only capabilities can use a lighter promotion policy if desired.

**Test-oracle warning:** matching an agent is not enough; an agent may have made a policy error. Independent business rules are the correctness oracle.

---

## 7. Runtime: guards, partial execution, and fallback

### 7.1 Dispatcher

```ts
async function dispatch(request: Task, context: RuntimeContext) {
  const candidates = registry.findByTypedTask(request.kind);
  for (const cap of candidates) {
    const decision = checkGuards(cap, request, context);
    if (!decision.ok) continue;
    return executeIR(cap, request, context);
  }
  return runAgent(request, context);
}
```

Semantic matching may _suggest_ a candidate, but the last-mile selection must check deterministic schema, policy, permission, adapter-version, data-freshness, and semantic-domain guards.

### 7.2 Partial execution

Split the program into safe regions. An unsupported branch or failed precondition may deoptimize to an agent at a boundary:

```ts
type ExecutionCheckpoint = {
  runId: string;
  capabilityId: string;
  capabilityDigest: string;
  nextNodeIds: string[];
  liveValues: Record<string, unknown>; // redacted or referenced
  observedResourceVersions: ResourceRef[];
  completedEffects: EffectReceipt[];
  pendingEffects: EffectIntent[];
  reason: 'guard_miss' | 'adapter_drift' | 'unsupported_state' | 'runtime_failure';
};
```

The agent receives the user task, reason, relevant live values, allowed actions, completed-effects ledger, and continuation point. It must **not blindly redo** successful writes. Resume the compiled plan only if resource versions, permissions, and invariants still hold; otherwise enter a reconciliation or explicit abort path.

### 7.3 Effect ledger, not “rollback everything”

Local SQLite transactions are useful for the demo, but they do not undo Stripe-like credits, CRM updates, or emails after an external provider accepts them. Before every external mutation:

1. Record an effect intent with a stable idempotency key: `tenant/run/resource/operation` (use a uniqueness constraint).
2. Invoke the adapter with provider-supported idempotency where available.
3. Record the provider receipt or reconciliation-needed state.
4. On retry or fallback, check provider status before repeating an uncertain operation.
5. Compensate only where the provider supports a defined inverse; sending an email has no true undo.

Track `planned`, `in_flight`, `confirmed`, `unknown`, `compensated`, `failed` separately. “Exactly once” is not a blanket guarantee across external providers; the honest goal is at-most-once logical effects where supported, plus reconciliation.

---

## 8. Exception-driven incremental recompilation

```text
capability v1, guard: no prior refund
          |
partial-refund input arrives
          |
guard miss; checkpoint / no new financial write
          |
agent resolves case within policy
          |
new structured trace + candidate branch
          |
compile candidate v2; independent tests
          |
manual review for financial behavior
          |
registry atomically promotes v2
          |
next comparable case uses v2 fast path
```

Version v2 must preserve old supported inputs and old invariants unless an explicit policy change requires otherwise. Deploy new versions as immutable artifacts; retain old artifact and deployment pointers for rollback. Record the input class that each specialization covers, not just a global “verified” flag.

**Do not automate approval just because one recovery succeeded.** A single trace establishes a candidate, not universal correctness. Require tests and explicit rules. Multiple traces improve pattern confidence, not permission.

---

## 9. Repo implementation plan (specific modules)

Recommended layout. These are _proposed additions_; don't rename the entire repository before a small vertical slice works.

```text
src/
  domain.ts                    # Keep compatibility types; migrate gradually
  exploration/
    capture.ts                 # Existing entry point; route to new collector
    tool-events.ts             # Typed raw events / redaction
    provenance.ts              # Data/control/effect graph builder
  compiler/
    compile.ts                 # Orchestrates pipeline instead of emitting fixed text
    ir.ts                      # IR schemas and validation
    parameterize.ts            # Constant vs parameter inference
    patterns.ts                # Cross-trace candidate subgraphs
    passes/
      prune.ts
      dedupe-reads.ts
      schedule.ts
      specialize.ts
    emit.ts                    # Artifact packaging + digest
  runtime/
    execute.ts                 # Generic IR interpreter entry point
    dispatcher.ts              # Typed selection + guard evaluation
    checkpoint.ts              # Resume and deoptimization
    effects.ts                 # Effect intent, receipts, reconciliation
    adapters/
      registry.ts
      crm.mock.ts
      orders.mock.ts
      payments.mock.ts
  verification/
    verify.ts                  # Verification orchestrator
    equivalence.ts             # Normalize observable outputs/effects
    generate-cases.ts          # Input boundaries and failures
  registry/
    store.ts                   # Add artifact/profile/checkpoint/effect tables
  telemetry/
    metrics.ts                 # Split agent vs compiled cost
  agent/
    codex.ts                   # Agent fallback; structured tool wrapper later
  service.ts                   # Coordinates versions and calls dispatcher
  app.ts                       # New compile/run/trace/profile endpoints
  web/App.tsx                  # Trace -> IR -> tests -> dispatch dashboard
examples/
  shipping/                    # Existing shipping domain fixtures and adapters
tests/
  compiler/
  runtime/
  differential/
  benchmark/
```

### PR-sized milestones and acceptance tests

| Phase                               | Work                                                                                                                                   | Acceptance criterion                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 — Honest execution**           | Make `executePlan()` consume capability-owned generic IR instead of fixed `operations` array; stop coupling source string to what runs | Two distinct supported IR plans produce two distinct outputs; mutating the artifact changes what executes or fails verification; compiled read path invokes zero LLMs |
| **P1 — Trace fidelity**             | Add `args`, typed outputs or references, dependencies, effect metadata, adapter version                                                | Instrumented events reconstruct the `customer → orders/refunds` dataflow; free-form description alone cannot create an executable node                                |
| **P2 — First genuine optimization** | Parallelize independent reads; eliminate provably duplicate reads                                                                      | Same normalized results and resource-version semantics; lower wall time/call count in a controlled fixture                                                            |
| **P3 — Dynamic compilation**        | Derive a parameterized `load_customer_context` IR from at least two different input traces                                             | Compiler creates the program from trace data; changing operation order in traces does not change correct dependency graph                                             |
| **P4 — Guarded dispatcher**         | Match typed task, validate preconditions, select artifact or fallback                                                                  | Valid typed case executes without an agent; invalid/adaptor-drift case never runs unsafe path                                                                         |
| **P5 — Checkpoint handoff**         | Persist live values and effect receipts; resume at next safe node                                                                      | Agent does not repeat a committed write after fallback/restart; unknown external state triggers reconciliation                                                        |
| **P6 — Incremental learning**       | Compile separately tested partial-refund branch as v2                                                                                  | v2 handles new case without agent and passes all v1 regressions; v1 remains rollback-able                                                                             |
| **P7 — Economic policy**            | Add cost/frequency model                                                                                                               | Low-reuse pattern remains agent-handled; hot repeatable pattern becomes compilation candidate for measured reasons                                                    |

**Implement P0–P4 before attempting fully autonomous exception learning.** Those four phases already support a credible “skills vs JIT” demo.

### First development ticket, fully specified

**Ticket:** Replace fixed shipment runtime with a generic three-read IR interpreter.

- Input: `{ "customerId": "C-101" }`.
- Adapters: `crm.getCustomer`, `orders.list`, `payments.refundHistory` fixtures.
- IR: three `adapter.read` nodes referencing the same input, plus a `join` node.
- Runner: validates schema and permissions, resolves references, topologically executes nodes, runs independent read nodes concurrently under a configured concurrency limit, validates outputs.
- Artifact: persisted IR, adapter contract versions, invariants, required scopes, SHA-256 digest.
- Guard: customer ID type; allowed tenant; exact supported adapter versions.
- Tests: happy path, invalid input, missing scope, adapter drift, one read timeout, consistency violation, duplicate read, different `customerId`, zero LLM use, artifact digest tamper.
- Demo result: show the same artifact executing with two customer IDs directly through the runtime.

This is deliberately smaller and stronger than generating an open-ended script from an entire coding session.

---

## 10. Example service API and runtime outcomes

Preserve current endpoints where possible and add a generic v2 flow:

```text
POST /api/v2/traces                    # ingest structured events
POST /api/v2/compile                   # source trace(s) -> candidate
GET  /api/v2/capabilities/:id/ir       # inspect actual executable plan
POST /api/v2/capabilities/:id/verify   # evaluate candidate artifact
POST /api/v2/capabilities/:id/approve  # review gate
POST /api/v2/tasks/dispatch           # guard -> compiled or agent
GET  /api/v2/runs/:id                  # trace, checkpoint, effect ledger
POST /api/v2/runs/:id/recover          # controlled fallback/recovery
GET  /api/v2/profiles/:name           # execution statistics
```

Representative dispatch response:

```json
{
  "mode": "compiled",
  "capability": "load_customer_context",
  "capabilityVersion": 2,
  "coverageGuard": "customer_context.v1",
  "llmInvocations": 0,
  "executedNodeIds": ["customer", "orders", "refunds", "join"],
  "durationMs": 46,
  "result": { "customerId": "C-101", "orderCount": 3, "refundCount": 1 }
}
```

The numbers above are **illustrative response fields, not benchmark results**.

---

## 11. UI design notes: make the differentiation visible

Do not make the main product view a list of generated skills. Show actual compilation and dispatch:

1. **Trajectory view:** tool calls with arguments (redacted), outputs, failed exploratory branches, _real_ dependency edges.
2. **Compiler view:** original trace DAG next to optimized IR; annotate `parameterized`, `removed redundant read`, `parallelized reads`, `guard added`.
3. **Artifact view:** executable IR, input/output schema, required scopes, adapter versions, provenance, digest, tests, approval.
4. **Dispatcher view:** latest task, selected artifact, guard evaluations, mode `compiled | hybrid | agent`, reason for fallback.
5. **Exception view:** exact checkpoint, completed external effects, agent recovery, v1 → v2 diff.
6. **Performance view:** agent tokens, LLM invocations, tool calls, p50/p95 latency, total cost, verification cost, correctness, guard-miss rate.

Use an explicit label: **“LLM calls inside compiled portion: 0”** when that is measured and true. Show agent calls separately for hybrid runs. Avoid computing a token-reduction percentage from two different tasks/prompts and presenting it as a controlled comparison.

---

## 12. Evaluation: make the comparison fair

### Baselines

A. General-purpose agent with access to raw tools.

B. Agent using a carefully written `SKILL.md` **with scripts**, not a weak text-only straw man.

C. Agent using automatically generated skills/scripts based on the same previous traces.

D. Manually engineered deterministic workflow for the known cases (useful performance ceiling/reference).

E. Agent JIT, with ablations: no cross-trace mining; no optimizer; no specialization; no deoptimization.

### Workload

Run related but nonidentical tasks in phases: normal delayed shipments, customer-specific variations, prior-credit cases, partial refunds, simulated adapter schema drift, intermittent timeouts, and permission changes. Keep train/observation traces separate from held-out evaluation tasks and use identical backend fixtures for all systems.

### Primary metrics

- Correct task outcomes and exact external-effect invariants (must not trade away safety).
- LLM invocations and billable tokens per task, including fallback and compile/verify amortization.
- End-to-end p50/p95 latency, tool-call count, provider cost, and failure rate.
- Percentage of tasks handled as compiled / hybrid / agent-only.
- Number of distinct agent-resolved exceptions subsequently served by verified fast paths.
- Time and traces to specialization; guard false-accept and false-reject rates.
- Engineering effort to create and maintain a new supported workflow.

### Honest cost model

For a candidate used `N` future times, compile only if projected value justifies overhead:

```text
N × (agent execution cost − compiled execution cost)
    > compilation + verification + maintenance + expected recovery cost
```

Include false-start costs, reviewer time, and changes in provider pricing. The decision can start with a static threshold and become profile-guided later.

### Claims that require measurement, not assumption

- “Lower token cost” must include compiler/verification inference amortized over actual reuse.
- “Faster” requires controlled comparable work, not original exploration versus a shorter second prompt.
- “More reliable” requires task correctness and effect-safety results, including guard misses.
- “General” requires multiple materially distinct workflow structures, not only changed shipment parameters.

---

## 13. Safety and engineering invariants

- **No silent privilege expansion.** Compiled artifacts inherit at most the caller's scopes; observed successful actions never grant new permissions.
- **No arbitrary generated code in the trusted runtime.** Whitelisted IR/adapters first; sandbox any later code backend.
- **No blind replay of external writes.** Durable effect ledger + idempotency + reconciliation.
- **No unsafe speculative execution.** Check guards _before_ effects; handle version/freshness changes at continuation boundaries.
- **No universal-correctness claim from one trace.** Require independently specified invariants and regression/fault tests.
- **No fake causal inference from chronology.** Use value provenance and explicit effect constraints.
- **No unapproved financial behavior.** Human review for new financial write patterns or expanded limits.
- **No unbounded skill/variant explosion.** Garbage-collect unprofitable unapproved candidates; retain immutable audited versions.
- **No conflation of local and distributed transactions.** Demo SQLite rollback is not a real-world refund reversal or email unsend.

---

## 14. What not to build yet

Avoid spending the first iteration on: universal browser-to-API translation; arbitrary Codex-session-to-TypeScript compilation; a large graph-mining model; a general-purpose optimizer across any MCP server; unreviewed self-modifying financial workflows; and a polished skill marketplace.

All are potentially interesting, but none proves the core claim as directly as **two real captured typed trajectories → one generated IR program → direct execution → guard miss → checkpoint → verified v2 specialization**.

---

## 15. Short pitch and scope of claims

### One sentence

**Agent JIT compiles recurring parts of agent tool-use trajectories into verified executable capabilities and falls back to agents only when the compiled capability's operating assumptions fail.**

### Thirty-second pitch

Agent frameworks help models use tools and reuse skills, but they don't automatically turn recurring tool-use computation into optimized software. Agent JIT records structured trajectories, discovers repeated subgraphs, generates typed programs, and verifies their behavior. Future requests that satisfy explicit guards run directly; unfamiliar states hand control back to an agent at a safe checkpoint. Agent recoveries become candidates for new program specializations. The outcome we're testing is whether agent systems can amortize reasoning across recurring workloads without losing correctness or control of side effects.

### What is demonstrable today vs proposed

- **Already present in the supplied prototype:** local shipment demo, fixed-plan branch pruning, capability approval/versioning, local policy checks and fixture execution, fault simulations, SQLite state, Codex re-prompting path.
- **Build first:** generic executable IR; structured tool event provenance; first real optimization; runtime dispatch with zero LLM calls for the compiled region.
- **Build second:** checkpoints, effect ledger for provider-backed writes, guarded fallback, incremental specialization and promotion.
- **Research extension:** cross-workflow subgraph mining and compile-worthiness prediction based on observed profiles.

**Definition of done for the JIT claim:** The same system must (i) learn a reusable parameterized plan from observations rather than load a hardcoded workflow, (ii) execute it directly for a compatible new input, (iii) recognize and safely delegate an incompatible input, and (iv) reuse a verified newly learned specialization on a later related task.
