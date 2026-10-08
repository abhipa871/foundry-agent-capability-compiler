# Selective context prefetch

**Status: implemented as an opt-in, experimental SDK option. The harness is validated with a
labeled no-inference fixture provider. Live performance is unmeasured: no paid inference has been
run for this change.**

## A. Architecture

### How Foundry worked before this change

1. **Observation.** `TrajectoryObserver` wraps an agent's typed read tools and records each call,
   its argument lineage (`task_input`, `event_output` or literal), result projection and usage.
2. **Compilable reads.** `analyzePatterns` groups structurally identical successful traces;
   `compileIR` mines the shared read subgraph (`minePattern`), binds arguments only where lineage
   is proven (`bindNode`), prunes, deduplicates and schedules. Every read node keeps an explicit
   `deps` list that must equal its value references (`validateIR`).
3. **Representation.** A `CapabilityIR` has typed `adapter.read` nodes (operation, bound
   arguments, scopes, output schema) and exactly one pure `join` node whose output is the strict
   full `context.v1` (customer, orders and refunds). Name, output schema and wire format are pinned
   to `load_customer_context`.
4. **Validation and governance.** `verifyIR` (21 checks before this change: digest, evidence,
   fixture oracle, trace equivalence, fail-closed faults, scope and effect checks), approval bound
   to the exact digest, three trusted native-authoritative shadow matches, health/quarantine, a
   signed 60-second runtime ticket, and per-request `checkGuards` (status, digest, validation,
   principal, tenant, snapshot, policy, adapter versions, scopes, 30-second freshness).
5. **Placement.** `selectExecution` returned `compiled_prefetch` only when a code-registered
   contract required all three reads, `compiled_tool` when the agent decides, `normal` for partial
   or absent context and `denied` on authorization failure.
6. **Incomplete executions.** `interpret` raises `DeoptimizationError` with completed nodes and live
   values; `dispatch` turns it into a checkpoint and either a native context agent or, with
   `fallback: 'defer'`, an unresolved result. Authorization failures are terminal denials.
7. **Read reuse.** `RequestReadCache` wraps the adapters for one request and serves validated,
   identity-bound, fresh, copy-isolated successful reads to the original agent after a miss.

### Why partial context could not be prefetched

Four independent points enforced all-or-nothing execution:

- The selector hardcoded the compiled region as all three reads and returned `normal` otherwise.
- `interpret` always executed every node and ended with `contextProjection`, which accepts only the
  strict full `context.v1`.
- `dispatch` called `authorizeContext` (all three scopes) before choosing an artifact, and the
  `scopes` guard required every artifact scope. A principal holding only a subset's scopes was
  **denied**, not merely routed to normal execution.
- Verification, shadow comparison and observation compared full contexts only.

### Design: parameterized resource selection over the approved artifact

The application passes a validated resource subset to `FoundryClient.execute`. The interpreter
runs the dependency closure of the requested read nodes (each requested read plus every transitive
prerequisite read) through the same node executor, schedule, concurrency limit, timeout and
invariants, and returns a strict subset context containing exactly the requested resources.
Prerequisites execute but are never returned. No new artifact, IR schema, digest, wire format or
approval path is introduced, so signatures, verification, trusted shadows, health and quarantine
apply unchanged; a subset request can only run an artifact that already passed them. Each executed
node is byte-identical to a node in the approved IR with the same arguments and dependencies, and
reads are side-effect free under a pinned snapshot, so a requested resource's value equals the value
the full plan produces. A new verification check proves this for every selectable subset before
approval.

Alternatives rejected: _pruned IR artifacts or validated variants_ would need a new output schema,
wire format and per-subset verification, shadow and approval (seven subsets per family) for no added
safety; _model-chosen subsets_ would add inference and let a model influence what is read.

### Selector table (as implemented)

| Situation                            | Contract                            | `selectExecution` result                                   |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------------------- |
| Complete context known               | `known` or `subset` with all reads  | `compiled_prefetch`, all three `resources`                 |
| Validated subset known               | `subset` with one or two reads      | `compiled_prefetch`, exact `resources`, distinct `reason`  |
| Agent decides                        | `agent_decides`                     | `compiled_tool`                                            |
| Partial context, existing vocabulary | `known` with one or two reads       | `normal` (unchanged)                                       |
| No context                           | `known` with no reads               | `normal`                                                   |
| Requested resource not authorized    | any                                 | `denied` (terminal; only the requested scopes are checked) |
| Untrusted or unregistered metadata   | JSON copy, model output             | `normal`                                                   |
| Artifact unavailable or incompatible | decided at `execute` by the guards  | existing safe fallback (native or deferred)                |
| Approved plan cannot serve a subset  | decided at `execute` (non-security) | fallback; not counted as a capability fault                |

A known subset reuses the `compiled_prefetch` mode instead of adding a mode, because a new union
member would break consumers that switch exhaustively on `ExecutionSelection['mode']`; the
`reason` (`trusted_contract_requires_resource_subset`) and the new `resources` field distinguish
it. Selection is deterministic: no customer IDs, case names, expected answers, benchmark rules or
model calls. Optional resources are not represented by the existing contract semantics, so they
were not added; an unavailable resource is a failed read in the checkpoint and read status.

### Selective execution and direct fallback

- `execute(request, { resources, selection?, fallback? })` authorizes the requested reads only,
  scopes native observation to them, and passes them to `dispatch`. A request naming every resource
  uses the unchanged complete-prefetch path and result shape.
- `checkGuards` keeps every existing guard. With `resources`, the scope guard (a security guard,
  so failure is a terminal denial) covers the requested reads, and an added non-security
  `resource_selection` guard fails when the approved plan does not produce each requested read
  exactly once or when a prerequisite read is not authorized. That miss falls back without
  reading anything; it never denies a request the principal is entitled to, and never executes a
  prerequisite the principal may not read.
- `interpretSelected` runs only the closure nodes. A failure produces the existing
  `DeoptimizationError` checkpoint with completed reads and live values. With
  `fallback: 'defer'` and `RequestReadCache`, the application supplies the completed requested
  reads to its agent, which retries only the failed read within the shared per-request budget.
  Successful reads are not repeated; failed reads are never presented as data.
- Subset requests never run a compiled shadow (shadow evidence compares full contexts), so in
  shadow mode they run natively.
- Telemetry gains an optional `selection` object (mode, reason, selector duration, requested
  resources, prerequisites, fallback reason), sent only when `resources` or `selection` is passed,
  because the control plane's strict schema rejects unknown fields from older clients.

## B. Modified files

| File                                            | Purpose                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/runtime/selective.ts` (new)                | Resource-subset schema, dependency-closure planning, strict subset projection.                              |
| `src/runtime/interpret.ts`                      | Node loop extracted into `runNodes` (unchanged behaviour); new `interpretSelected`.                         |
| `src/runtime/dispatcher.ts`                     | Optional `resources`: subset authorization, requested-scope guard, `resource_selection` guard, `selection`. |
| `src/integration/selection.ts`                  | Opt-in `subset` requirement; `resources` on every selection.                                                |
| `src/integration/client.ts`                     | `execute` options `resources`/`selection`; scoped observation; no subset shadow; opt-in telemetry.          |
| `src/integration/protocol.ts`                   | Optional strict `selection` telemetry object.                                                               |
| `src/verification/verify-ir.ts`                 | Check 22: every selectable subset matches the full plan and executes exactly its closure.                   |
| `tests/integration/selective-context.test.ts`   | Runtime, guard, SDK, fallback and governance tests.                                                         |
| `scripts/experiments/selective-task.ts`         | Frozen cases, contracts, oracle, prompt, arms and schedule.                                                 |
| `scripts/experiments/fixture-provider.mjs`      | Labeled no-inference provider for harness validation.                                                       |
| `scripts/benchmark-selective-agent.ts`          | Four-arm driver; fixture or capped live mode; never overwrites evidence.                                    |
| `tests/integration/selective-benchmark.test.ts` | Plan, oracle and fixture-provider tests.                                                                    |
| `docs/selective-agent-fixture-*.json`           | Fixture validation output (synthetic usage).                                                                |
| `package.json`, `README.md`, docs               | `benchmark:selective-agent` script and documentation.                                                       |

### Compatibility

No breaking change. Every new parameter is optional and every new behaviour requires opt-in:
`known` and `agent_decides` contracts return the same modes and reasons; `execute` without
`resources` follows the previous code path, authorization, shadow behaviour, result shape and
telemetry payload; the native fallback default is unchanged. Additive changes consumers can
observe: `ExecutionSelection.resources`, `DispatchOutcome.selection`, the optional telemetry field
and one more verification check (re-verified artifacts report 22 checks; the check passes trivially
for subsets an artifact cannot serve).

## C. Tests (actual counts)

- `tests/integration/selective-context.test.ts`: 23 tests. Selector (registered, canonical,
  complete, unknown/empty/duplicate, untrusted, per-resource authorization, existing modes);
  runtime on a dependent and an independent plan (single, two-resource, complete, prerequisite not
  returned, parallel reads, unknown resources, unservable plans, identity/tenant/snapshot/malformed
  faults, missing and extra evidence, checkpoint on partial failure); SDK against a signed, approved
  artifact (verification of all subsets, compiled subset with telemetry, unchanged complete path,
  complete subset through the existing path, unauthorized subsets denied without fallback or
  reads, adapter denial terminal, unauthorized prerequisite falls back without penalty,
  quarantine, adapter incompatibility, stale context, no subset shadow, direct-fallback reuse with
  one retry, permanent failure stops at the retry budget, guard composition).
- `tests/integration/selective-benchmark.test.ts`: 7 tests (plan, oracle, fixture provider).
- Full suite: **189 tests in 32 files pass** (159 before this change), plus TypeScript, Prettier,
  SDK build and the existing `evaluate` regression checks.

## D. Benchmark

**Design (frozen in `selective-task.ts`).** 16 categories (customer only, orders only, refunds
only, customer+orders, customer+refunds, orders+refunds, complete, agent-decided, no resource,
partial compiled failure, quarantined subset, incompatible subset, denial, transient error,
permanent error, dependency) on disjoint development (C-101, C-202, C-303, C-111, C-212) and
held-out (C-404, C-505, C-606, C-414, C-515) records, with the support-agent experiment's adapters,
snapshot, model settings, prompt structure, freshness contract and oracle method. Arms: **A**
normal; **B** existing selector + direct fallback (subsets expressed as existing `known`
contracts); **C** selective prefetch + direct fallback; **D** handwritten exact-subset prefetch
with one retry. Development: 64 measured requests; held-out: 128 (two repeats). The dependency case
uses an artifact compiled from the repository demo traces through the same verify, trusted-shadow,
approve and deploy lifecycle, because the support agent's own traces bind every read to task input.

**Fixture validation (not performance evidence).** Both splits ran to completion with the
scripted provider. Its tokens, model calls, costs and latencies are synthetic. What the runs do
establish is harness and runtime behaviour on held-out records:

| Held-out group (fixture)    | Arm C behaviour                                                               | Arms A/B | Arm D     |
| --------------------------- | ----------------------------------------------------------------------------- | -------- | --------- |
| Healthy selective (14 rows) | Answered from prefetched reads alone; 0.14 prerequisite reads/row             | Tools    | Prefetch  |
| Fallback (10 rows)          | Every fault fell back; completed reads supplied; 0 duplicate successful reads | Tools    | Tools 20% |
| Denied (2 rows)             | Denied before reads or inference                                              | Same     | Same      |
| All 128 rows, every arm     | Oracle passed; 0 authorization violations; 0 duplicate successful reads       |          |           |

Stale context fell back at the freshness guard, quarantine at ticket selection (`no_candidate`),
and partial failures at the failed read with a checkpoint. Both artifacts passed "7 of 7 resource
subsets are selectable and match the full plan".

**Live results: not run.** Token, call, cost and latency gains are **unmeasured**. To run them,
with explicit authorization:

```sh
FOUNDRY_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  npm run benchmark:selective-agent -- development --provider live --cap-usd 4
# then, only if development completed:
FOUNDRY_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  npm run benchmark:selective-agent -- heldout --provider live --cap-usd 7
```

Planned provider requests: 75 (development) and 135 (held-out), including observation, nine trusted
shadows and four warmups. From the retained v2.1 live ledgers (support requests averaged $0.016 to
$0.021, 95th percentile $0.031 to $0.036 API-equivalent), the expected API-equivalent cost is about
$1.5 to $2.7 for development and $2.2 to $4.9 for held-out. The cap stops the run when the
estimate reaches it. These are API-equivalent estimates, not billed cost.

### Baseline (retained v2.1 held-out evidence, not re-run)

| Category              | Normal              | Foundry selector + direct | Handwritten prefetch |
| --------------------- | ------------------- | ------------------------- | -------------------- |
| Partial (eligibility) | 8,757 tok / 2 calls | 8,777 / 2                 | 4,399 / 1            |
| Complete context      | 9,086 / 2           | 4,543 / 1                 | 4,519 / 1            |
| Complete, slow read   | 9,087 / 2           | 4,523 / 1                 | 4,518 / 1            |
| Agent decides         | 9,028 / 2           | 9,166 / 2                 | 9,040 / 2            |
| No context            | 4,388 / 1           | 4,415 / 1                 | 4,422 / 1            |

On partial context, existing Foundry spent one extra model call and about 4,400 more tokens than
handwritten prefetch because it fell back to normal execution. That gap is what selective prefetch
targets. Whether it closes live is unmeasured, and these figures are not comparable with the new
case mix.

## E. Limitations

- No live measurement; the fixture provider shows plumbing and safety behaviour, not model
  behaviour, tokens or latency.
- One compiled family (customer, orders, refunds) with three resources; subsets are limited to
  reads the approved plan outputs exactly once.
- Subset requests have no compiled shadow; their trust rests on full-context shadows plus the
  subset-equivalence verification check.
- A dependency forces its prerequisite read (counted separately; never returned). In a deferred
  fallback, the checkpoint's live values can include that authorized prerequisite.
- The handwritten comparator (arm D) has no artifact guards, so it ignores quarantine and staleness
  that make arm C fall back; fallback-group comparisons are not like for like.
- Optional resources and model-proposed subsets are deliberately unsupported.
- Synthetic records and a sandboxed snapshot; no production connector, billing or tail-latency
  evidence.

## F. Recommendation

Keep selective prefetch **experimental and opt-in**. It preserves every existing default and
governance check, and its safety properties are covered by tests and fixture validation, but its
benefit is unmeasured. Run the capped live development benchmark next; only if correctness holds
and the healthy-selective gap to handwritten prefetch closes, run held-out once before considering
broader use.
