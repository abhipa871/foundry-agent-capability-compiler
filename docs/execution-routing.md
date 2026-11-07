# Contract-based execution placement

The v2 compiler still mines matching typed read subgraphs, parameterizes declared inputs,
prunes exploratory work, deduplicates equivalent reads and schedules independent reads. A signed,
validated IR artifact executes through the existing interpreter, with guards before reads.

The original support benchmark hardcoded placement in its application driver. Foundry's SDK
selected a guarded capability inside `execute`, but did not select prefetch versus an agent tool.
Quarantine removed the capability; the SDK invoked its configured context agent. The enclosing
support agent then continued, producing four model responses in the retained compiled-tool test.

`defineContextContract` registers application-owned task metadata in memory. `selectExecution`
accepts these registered contracts, an input and runtime context. Untrusted JSON cannot register
itself merely by claiming a trusted source. The application must validate the semantic task contract;
schema validation alone cannot establish what a natural-language task needs.

- Known complete customer/order/refund reads: `compiled_prefetch`.
- Model must decide whether complete context is needed: `compiled_tool`.
- Partial or absent customer reads: `normal`; this compiled family is inapplicable.
- Required record/scope authorization fails: `denied`, with no fallback permission.

Selections carry a reason and monotonic selector duration. They contain no customer-specific rules,
benchmark identifiers, expected answers, model calls or network access. Placement does not approve
an artifact or override signature, rollout, compatibility, freshness or runtime authorization guards.
The existing `FoundryClient.execute` behavior and strict full-context observation remain the default.
Explicitly scoped observation allows partial tasks without demanding unrelated scopes.

First validation gate: 129 tests, TypeScript and SDK build. Live evidence will compare this selector
with the original-tool and manually placed paths, separately from fallback changes.

## Direct fallback handoff

`client.execute(request, { fallback: 'defer' })` attempts guarded compiled execution and returns an
`unresolved` outcome/checkpoint on an ordinary applicability or runtime miss. It reports zero model
work for the deferred callback and includes attempted compiled reads. A denied outcome remains
terminal. Observe/shadow mode does not execute compiled shadow work without an authoritative native
path. Omitting the option preserves existing native fallback. Reported failed-native measurements
are retained when supplied as `AgentExecutionError`; unknown stream usage remains unknown.

The application must handle unresolved execution with its original authorized agent/tools and
must never treat partial work as a complete context. `RequestReadCache` can wrap the same adapters
for this single request. It validates successful outputs, requires an explicit adapter freshness
contract (1–60 seconds), rechecks scope/record authorization and matches tenant, principal, policy,
snapshot and adapter versions before reuse. Expired, failed or incorrectly bound data is not reused.
It performs no writes, persists no data and does not resume a compiled IR plan. Completed safe reads
can be supplied to the support agent; failed reads remain missing evidence.

SDK-returned wall duration now includes its best-effort telemetry request. The telemetry payload's
own duration is captured before transmission, while the returned request measurement includes it.

Second validation gate: 137 tests, TypeScript and SDK build. The expanded harness will compare the
same selector with native fallback and direct handoff to isolate this change's effect.

## Selective prefetch (opt-in, experimental)

A `subset` contract names the exact reads a task needs before inference:
`defineContextContract({ requirement: 'subset', reads: ['orders.list'] })`. `selectExecution`
returns `compiled_prefetch` with `resources` set to those reads (reason
`trusted_contract_requires_resource_subset`), or the complete-context result when all three are
named. Pass them on: `client.execute(request, { resources: selection.resources, selection,
fallback: 'defer' })`. Only the requested reads and their approved prerequisites execute, from the
same signed, approved artifact; only requested resources are returned. Missing authorization for
a requested resource is a terminal denial. A plan that cannot serve the subset, or an unauthorized
prerequisite, falls back without reading. Subset requests never run compiled shadows. Existing
`known` partial contracts still select `normal`, and `execute` without `resources` is unchanged.
See [selective context](selective-context.md) for the design, tests and fixture validation; live
gains are unmeasured.

## Optional measured-cost veto

`selectExecution(contract, input, context, { prefetchCostComparison })` can conservatively
decline an otherwise eligible prefetch. The application supplies `pairedRequests` (a positive
integer), `baselineMeanCostUsd` and `prefetchMeanCostUsd` (finite, nonnegative means over the same
paired requests). If prefetch is equal or more expensive, the selection is `normal` with reason
`measured_prefetch_cost_not_lower` and no prefetch resources. Malformed or incomplete evidence
selects `normal` with `prefetch_cost_evidence_invalid`; unknown cost is never converted to zero.
Omitting the comparison preserves existing selection behavior, including experimental subsets.

Use complete-task measured costs including cached-token pricing, failed attempts, fallback and
request-time optimization overhead. The application must select a comparable, representative
development profile for the same task contract, resource set, model, authorization and runtime
configuration. Do not pool incompatible profiles or tune against held-out outcomes. Separate
one-time compilation/validation costs from these steady-state means. A positive mean saving is
not a confidence interval or a production profitability guarantee; no minimum statistical
confidence is inferred from `pairedRequests`.

This is an opt-in veto, not learned routing or an automatic profile collector. It cannot enable
prefetch for an ineligible task. Authorization is checked first and denial stays terminal.
Agent-decided tool placement is unchanged because a prefetch comparison does not establish the
cost of a tool-based execution. The application still branches on `selection.mode`: `normal`
uses original authorized tools, `denied` stops, and eligible compiled paths retain all existing
runtime guards. Passing a selection to `FoundryClient.execute` only records telemetry; it does
not enforce the selected orchestration mode. The benchmark UI and frozen studies do not opt into
this veto automatically. No new live inference measurements accompany this addition.

## Capability-aware readiness and application routing

The optional `candidate` selector option accepts an application-owned local `IRArtifact`:

- Omitted: availability is unknown; preserve existing placement and defer guards to execution.
- `null`: the application knows no capability is available (including quarantine); select
  `normal` with reason `no_available_capability` without attempting compiled work.
- Artifact: run the existing `checkGuards` before recommending prefetch or offering the tool.
  Non-security misses select `normal` with a `capability_guard_miss:<guard>` reason. Tenant,
  principal, scope or policy failure selects terminal `denied`, even if a cost veto would otherwise
  select normal execution.

The subset check covers approved prerequisites and does not demand unrelated resource scopes.
These checks perform no reads, model calls or network access. They add the cost of guard evaluation
(including digest computation), which is recorded in selector duration. A candidate is advisory
local metadata, not proof of a valid signature, rollout assignment or current registry health.
Remote consumers must continue obtaining authenticated signed offers through the SDK. Always
recheck at execution: approval, freshness or authorization can change after selection.

The benchmark runner now supplies its actual isolated artifact, branches on the selected mode,
and accepts an optional server-owned synchronous `prefetchCostComparison(request)` resolver.
The resolver must return a matching measured development profile, not fabricate values or infer
cost from fixture usage. Its duration is included in selector and complete-request time. It is
not configurable by prompt/request JSON, and no profile is enabled by default. The normal arm
does not run Foundry's selector or profile lookup. Fixture tests demonstrate that a losing profile
routes through original authorized tools without a failed compiled attempt; they establish no
live token, cost or latency improvement. Runtime read failures still use the existing safe direct
fallback and request-local cache; preflight cannot predict those failures.
