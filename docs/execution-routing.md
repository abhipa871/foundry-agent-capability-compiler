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
