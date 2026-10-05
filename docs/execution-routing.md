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
