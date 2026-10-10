# Selective context prefetch

**Status: implemented as an opt-in, experimental SDK option. The harness is validated with a
labeled no-inference fixture provider, a completed live development run and one completed live
held-out run (128 requests, all correct, 0 authorization violations). On held-out healthy
selective tasks, selective prefetch matched handwritten prefetch: one model call and 4,402 mean
tokens versus 4,394, and 49.8% fewer tokens than normal tools and existing Foundry. Synthetic
records; not production evidence.**

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

| File                                                   | Purpose                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/runtime/selective.ts` (new)                       | Resource-subset schema, dependency-closure planning, strict subset projection.                              |
| `src/runtime/interpret.ts`                             | Node loop extracted into `runNodes` (unchanged behaviour); new `interpretSelected`.                         |
| `src/runtime/dispatcher.ts`                            | Optional `resources`: subset authorization, requested-scope guard, `resource_selection` guard, `selection`. |
| `src/integration/selection.ts`                         | Opt-in `subset` requirement; `resources` on every selection.                                                |
| `src/integration/client.ts`                            | `execute` options `resources`/`selection`; scoped observation; no subset shadow; opt-in telemetry.          |
| `src/integration/protocol.ts`                          | Optional strict `selection` telemetry object.                                                               |
| `src/verification/verify-ir.ts`                        | Check 22: every selectable subset matches the full plan and executes exactly its closure.                   |
| `tests/integration/selective-context.test.ts`          | Runtime, guard, SDK, fallback and governance tests.                                                         |
| `scripts/experiments/selective-task.ts`                | Frozen cases, contracts, oracle, prompt, arms and schedule.                                                 |
| `scripts/experiments/fixture-provider.mjs`             | Labeled no-inference provider for harness validation.                                                       |
| `scripts/benchmark-selective-agent.ts`                 | Four-arm driver; fixture or capped live mode; never overwrites evidence.                                    |
| `tests/integration/selective-benchmark.test.ts`        | Plan, oracle, task-scope consistency and fixture-provider tests.                                            |
| `docs/selective-agent-fixture-*.json`                  | v1 fixture validation output (synthetic usage).                                                             |
| `docs/selective-agent-development.json`                | Failed v1 live development attempt, retained with its cost.                                                 |
| `docs/selective-agent-v1.1-fixture-*.json`             | v1.1 fixture validation output (synthetic usage).                                                           |
| `docs/selective-agent-v1.1-development.json`           | Stopped v1.1 live development attempt (partial evidence).                                                   |
| `docs/selective-agent-v1.1-development-attempt-2.json` | Completed v1.1 live development run.                                                                        |
| `docs/selective-agent-v1.1-heldout.json`               | Completed v1.1 live held-out run.                                                                           |
| `package.json`, `README.md`, docs                      | `benchmark:selective-agent` script and documentation.                                                       |

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
- `tests/integration/selective-benchmark.test.ts`: 11 tests. Plan, oracle and fixture provider,
  plus v1.1 task-scope checks: cases, answers and permissions equal the v1 cases recorded in the
  retained evidence; every case states its required and out-of-scope records from the registered
  contract, with the full-review policy only for full-review and agent-decided scopes; every arm
  and prefetch outcome receives the same scope line and only contract tools, with a lookup path
  for every required read after a miss; and the normal baseline is offered every required read
  and its expected answer passes the oracle.
- Full suite: **193 tests in 32 files pass** (159 before this change), plus TypeScript, Prettier,
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

**Live results.** One held-out run ($7 cap) after a completed development run (three
development attempts, $4 cap each). Runs are never pooled. All are synthetic records with gpt-5.5
via Codex; API-equivalent costs are estimates, not billed cost.

#### Held-out run (`selective-agent-v1.1-heldout.json`)

Frozen v1.1 plan, unchanged held-out cases (C-404, C-505, C-606, C-414, C-515), seed 81307, two
repeats. Setup passed (22 of 22 checks on both artifacts; 9 of 9 trusted shadows matched), all four
warmups passed, and **all 128 measured requests passed the oracle in every arm**. Across arms:
0 authorization violations, 0 unnecessary reads, 0 duplicate successful reads, 0 redundant tool
calls; denial was terminal with no reads or inference. 135 provider requests, 228 completed
responses, all usage reported; **$2.200564 API-equivalent**. An earlier launch of this run never
started (it stayed at the permission prompt, with no process, log or inference) and was cancelled
before this single run.

| Group (rows)           | A normal         | B existing Foundry | C selective prefetch | D handwritten prefetch |
| ---------------------- | ---------------- | ------------------ | -------------------- | ---------------------- |
| Healthy selective (14) | 8,772 tok / 2.00 | 8,772 / 2.00       | **4,402 / 1.00**     | 4,394 / 1.00           |
| Healthy complete (2)   | 9,265 / 2        | 4,617 / 1          | 4,618 / 1            | 4,648 / 1              |
| Agent decides (2)      | 9,077 / 2        | 9,193 / 2          | 9,186 / 2            | 9,092 / 2              |
| No context (2)         | 4,345 / 1        | 4,364 / 1          | 4,382 / 1            | 4,343 / 1              |
| Fallback (10)          | 11,522 / 2.60    | 11,514 / 2.60      | 9,004 / 2.00         | 4,477 / 1.00           |
| Denied (2)             | 0 / 0            | 0 / 0              | 0 / 0                | 0 / 0                  |

Mean total tokens / model calls per request. Paired comparisons use a case-block bootstrap 95%
interval of the per-row difference (descriptive, 16 cases).

| Arm C versus (rows)                 | Tokens                               | Model calls  | API-equivalent cost              | p50 latency       |
| ----------------------------------- | ------------------------------------ | ------------ | -------------------------------- | ----------------- |
| Normal, healthy selective (14)      | 49.8% fewer (4,326 to 4,421 per row) | 2.00 to 1.00 | 50.0% lower ($0.0063 to $0.0119) | 4.46 s to 3.55 s  |
| Existing Foundry, healthy sel. (14) | 49.8% fewer (4,335 to 4,413)         | 2.00 to 1.00 | 49.9% lower ($0.0061 to $0.0127) | 4.44 s to 3.55 s  |
| Handwritten, healthy sel. (14)      | 0.18% more (1 to 20 per row)         | 1.00 to 1.00 | 9.4% lower (interval spans zero) | 3.05 s to 3.55 s  |
| Normal, all rows (32)               | 33.6% fewer (1,872 to 3,862)         | 2.00 to 1.31 | 32.1% lower ($0.0023 to $0.0106) | 13.7% lower mean  |
| Existing Foundry, all rows (32)     | 31.5% fewer (1,600 to 3,771)         | 1.94 to 1.31 | 24.4% lower ($0.0016 to $0.0073) | 13.7% lower mean  |
| Handwritten, all rows (32)          | 32.0% more (572 to 2,551)            | 1.00 to 1.31 | 33.9% higher                     | 20.8% higher mean |

What the held-out run shows:

- **Healthy selective (the targeted gap): closed.** Arm C used one model call on all 14 rows, like
  handwritten prefetch, and about half the tokens and API-equivalent cost of normal tools and of
  existing Foundry, which falls back to normal tools for subsets. Token parity with handwritten
  prefetch is within 0.2%. Arm C was slower than handwritten prefetch (per-row interval 41 to
  1,017 ms); its latency gain over normal tools is not established (interval spans zero). The
  dependency case read its prerequisite once per row (0.14 prerequisite reads per healthy row),
  never returned to the agent.
- **Complete context.** Arms B, C and D all used one call; arm C matches existing Foundry.
- **Agent decides and no context.** No difference in calls; arms B and C carry about 100 extra
  tokens for the context-loader tool definition when the agent decides.
- **Fallback.** Arm C fell back on all 10 rows and used 2.00 calls versus 2.60 for normal tools and
  existing Foundry. On runtime read failures (partial, transient, permanent) it reused completed
  reads: about 9,100 tokens and 2 calls versus about 13,350 and 3. On stale and quarantined
  artifacts it matched normal tools (about 90 extra tokens). Arm D always used one call because it
  has no artifact guards and retries reads itself, so it is not a like-for-like comparator there,
  and it accounts for most of arm C's all-row gap to handwritten prefetch.
- **Consistent with development.** Healthy-selective arm C means were 4,404 tokens (development)
  and 4,402 (held-out), both with one call.

#### Completed development run (`selective-agent-v1.1-development-attempt-2.json`)

Setup passed (22 of 22 verification checks on both artifacts; 9 of 9 trusted shadows matched), all
four warmups passed, and all 64 measured requests passed the oracle in every arm. Across arms:
0 authorization violations, 0 unnecessary reads, 0 duplicate successful reads; denial was terminal
with no reads or inference. 75 provider requests, 131 completed responses, all usage reported;
$1.702862 API-equivalent (not billed cost).

| Group (rows)          | A normal         | B existing selector | C selective prefetch | D handwritten prefetch |
| --------------------- | ---------------- | ------------------- | -------------------- | ---------------------- |
| Healthy selective (7) | 8,767 tok / 2.00 | 8,770 / 2.00        | 4,404 / 1.00         | 4,416 / 1.00           |
| Healthy complete (1)  | 9,251 / 2        | 4,593 / 1           | 4,594 / 1            | 4,595 / 1              |
| Agent decides (1)     | 9,101 / 2        | 9,193 / 2           | 9,204 / 2            | 9,121 / 2              |
| No context (1)        | 8,722 / 2        | 8,696 / 2           | 4,328 / 1            | 8,703 / 2              |
| Fallback (5)          | 11,515 / 2.60    | 11,501 / 2.60       | 9,005 / 2.00         | 4,464 / 1.00           |
| Denied (1)            | 0 / 0            | 0 / 0               | 0 / 0                | 0 / 0                  |

Mean total tokens / model calls per request. What this run shows:

- **Healthy selective (the targeted gap).** Arm C used one model call on all 7 rows, like
  handwritten prefetch: 4,404 versus 4,416 mean tokens, and 49.8% fewer tokens than both normal
  tools and the existing selector, which falls back to normal execution for subsets (paired
  case-block bootstrap 95% interval of the per-row saving versus normal: 4,319 to 4,408 tokens).
  API-equivalent cost was 60% below normal but 17% above handwritten, because prompt-cache hits
  differed; latency (p50 4.05 s versus 3.84 s normal, 3.19 s handwritten) showed no gain.
- **Fallback.** Arm C fell back on all 5 rows (stale, quarantined, partial, transient, permanent)
  and used 2.00 calls versus 2.60 for normal tools, reusing completed reads. Arm D used 1.00 because
  it ignores artifact guards and retries reads itself; this group is not like for like.
- **No context is noise, not an effect.** All four arms ran the same configuration (normal mode,
  no tools). Arms A, B and D sent a short interim message before answering; arm C did not. This
  row inflates the all-row comparison (arm C 35.6% fewer tokens than normal across all 16 rows) and
  should not be attributed to Foundry.
- **One latency outlier.** On the stale incompatible-subset row, arm C's second model response took
  16.2 s (18.9 s total) with normal token counts; the previous attempt timed out on the same
  request. Single observations; the cause is unknown.

#### Stopped attempts (retained with their costs)

- **v1 (`selective-agent-development.json`): stopped at warmup.** Setup passed (22 of 22
  verification checks on both artifacts, 9 of 9 trusted shadows matched). The normal arm answered
  the eligibility-only warmup as `unavailable`: the prompt always appended the full-review support
  policy ("copy the actual eligibility, every order and every refund") without stating the task's
  scope, so a model could read missing orders and refunds as a failure. 12 provider requests, 25
  responses, $0.374838 API-equivalent.
- **v1.1 correction (`selective-v1.1-16-case`).** The prompt now states each task's scope,
  derived only from the registered contract: required records, records outside the scope (set to
  null; neither required nor unavailable), and the full-review policy only for full-review and
  agent-decided tasks. Cases, expected answers, permissions, messages and tools are unchanged
  (tested against the v1 evidence); development and held-out use the same rule. The driver now
  stops on the first incorrect measured answer as well.
- **v1.1 (`selective-agent-v1.1-development.json`): stopped by a provider timeout.** Setup
  passed again (22 of 22 checks, 9 of 9 shadows matched) and all four warmups passed. Five
  measured requests ran: the four eligibility-only rows were correct, then arm C on the
  incompatible-subset case behaved as designed in Foundry (stale-context guard miss, direct
  fallback, original lookup tools offered, no reads supplied, 0 authorization violations) but the
  provider produced no response or tool call before the 60-second turn timeout. The driver stopped
  as directed; it was not retried. 20 provider requests, 34 completed responses; known
  API-equivalent cost $0.430476 plus one request of unknown cost (its usage was not reported and
  is not counted as zero).

Across all live selective runs (three development attempts and the held-out run): $4.708740
API-equivalent known, plus one request of unknown cost; not billed cost.

The driver writes numbered attempt files instead of overwriting, records every prior live attempt
(known cost and unknown-cost request count) in each new report, refuses a live run when a
complete v1.1 result for that split exists, and refuses held-out without a complete v1.1
development run.

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
targets. The v1.1 development and held-out runs closed it on healthy selective rows (above); these
v2.1 figures use a different case mix and are not pooled with them.

## E. Limitations

- Live evidence is one development run (16 rows) and one held-out run (32 rows, two repeats) on
  five synthetic customers per split, one model and one provider. Most categories have one or
  two rows per run, so only the healthy-selective and pooled comparisons carry weight; intervals
  are descriptive. Model-call counts vary even between identical configurations (the development
  no-context row). One development attempt stopped on a provider timeout of unknown cause
  (provider warnings are counted, not retained).
- Latency: no established gain over normal tools; slower than handwritten prefetch.
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
governance check, and its safety properties are covered by tests, fixture validation, and live
development and held-out runs with no correctness or authorization failures. On held-out
synthetic tasks it closed the gap it targets: for registered subset contracts it matched
handwritten prefetch and halved tokens and model calls relative to normal tools and existing
Foundry. That supports offering it to SDK consumers as an opt-in for trusted subset contracts. It
does not justify changing defaults or claiming production savings: that needs real connectors,
more customers and models, metered billing and latency evidence.
