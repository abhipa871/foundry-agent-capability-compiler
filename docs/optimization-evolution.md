# Incremental optimization roadmap

The four improvements build on the current read-only customer-context capability. They do not
require a compiler rewrite, new providers, generated code, vector databases or online learning.
Each stage adds its own measurements and correctness checks; the final stage consolidates them.

| Order | Improvement                           | Smallest useful implementation                                                                                                                                                                  | Validation gate                                                                                                                                    |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Execution selection                   | Keep trusted contracts, selective prefetch and direct fallback; add an opt-in measured-cost veto.                                                                                               | Existing routing and authorization tests pass; omitted evidence preserves defaults; losing or invalid evidence cannot trigger prefetch.            |
| 2     | Reasoning-dependent partial workflows | Reuse existing approved resource-subset execution after the agent determines which context it needs. Bound the tool schema to supported reads; do not trust model claims of authorization.      | Independently stated outputs and permitted reads; all subset/dependency, freshness and failure cases pass; useful reasoning remains authoritative. |
| 3     | Optimization recommendations          | Run the existing structural matcher offline and attach observed reuse and comparable cost evidence to reviewable candidate recommendations. Allow “insufficient evidence” and “not worthwhile.” | No automatic approval; identical patterns retain provenance; unknown costs remain unknown; fixtures establish no live inference savings.           |
| 4     | Unified evidence view                 | Extend the existing benchmark interface with decision reasons, paired differences, full fallback cost and setup/revalidation break-even.                                                        | Reconcile against raw records, distinguish fixtures from provider usage, retain losing cases, and report uncertainty honestly.                     |

## Stage 1 delivered: bounded deterministic selection

The SDK selector accepts optional application-owned paired cost evidence. It only vetoes otherwise
eligible prefetch when the complete-task mean cost is not lower; invalid evidence conservatively
selects normal execution. No new execution mode, compiler pass, model call, background job, data
store or network request was added. Existing authorization and artifact guards remain authoritative.
See [execution routing](execution-routing.md#optional-measured-cost-veto) for the exact API and limits.

The selector also accepts a known local candidate (or explicit absence) and uses the existing
runtime guards to avoid recommending known-ineligible prefetch or tools. Artifact-level security
denials stay terminal. Subset prerequisites are checked before reads. Execution repeats all guards
because preflight is not approval and state may change.

The benchmark runner now uses candidate-aware selection and can resolve optional measured cost
comparisons from server-owned configuration. The normal arm performs no Foundry selection or cost
profile lookup; Foundry's full selector/resolver overhead is included in its request measurement.
No profile is enabled by default, and fixture costs are not converted into monetary evidence.

Stage 1 is complete within this roadmap's rule-based scope: trusted complete/subset prefetch,
agent-decided tool placement, no-read/inapplicable normal execution, terminal authorization,
known capability readiness, optional measured-cost veto, explainable reasons, measured overhead,
and an application path that honors the selection. Existing SDK defaults remain compatible.
Automatic profile collection/matching and learned routing are not implemented; recommendations
belong to stage 3. No new live savings claim is supported by these local tests. Stage 2 remains
next: agent-selected partial retrieval after reasoning, using the approved subset interpreter.

### Reusable policy, bounded execution scope

The customer selector now delegates to a shared read-workflow selection policy. Other applications
can register operation names, trusted contracts and synchronous authorization/readiness checks,
without customer-specific identifiers or new selection algorithms. This is a routing extension
point, not automatic compilation of other domains. The v2 compiled executor still supports only
the existing customer-context family. See [read-workflow selection](read-workflow-selection.md)
for requirements, fixture examples and limitations. Reasoning-dependent partial tools (stage 2)
are still pending.

## Keep development and evaluation bounded

- Develop with deterministic fixtures and targeted tests. Use real provider requests only for
  changes that pass the correctness gate and need inference evidence.
- Reuse existing raw reports as historical evidence; never relabel them as results of changed code.
- For each future live evaluation, freeze rules first, state the request count and cap, and run a
  small development set followed by a separate held-out set. No paid live run is needed for this
  first increment.
- Keep changes independently reviewable. Preserve the normal path and preserve denied access as
  denial. Never use a recommendation or a cost estimate to grant permission.
- Measure token usage, model calls, business reads, complete request time and inference cost
  separately. A cost-based veto does not establish latency or token savings.

This plan minimizes application computation, but it cannot guarantee a particular amount of
remaining Codex account usage. No additional agents or broad architecture expansion are required.
