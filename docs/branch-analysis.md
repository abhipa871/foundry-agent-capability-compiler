# Raw Agent Failures to branchAnalysis

Raw agent trajectories may include exploratory tool calls that failed, were skipped, or led away from the final working path. `captureRaw` keeps those events for provenance, but only turns the successful causal path into deterministic capability steps.

## Short Note

Raw failures become `branchAnalysis` when `captureRaw` passes the event log to `pruneAgenticBranches`. The pruner first identifies the successful causal path that produced the final answer, then emits every raw event that is not part of that path as a `branchAnalysis.discarded` record. That record preserves the event id, operation, status, description, optional error, and a discard reason so the compiler can prove the failed or abandoned branch was observed but excluded from the runtime plan.

The source of truth is `src/exploration/capture.ts`: `captureRaw` normalizes the raw log into capability steps, while `pruneAgenticBranches` builds the audit trail that later becomes capability provenance.

The conversion happens in `pruneAgenticBranches`:

1. Validate that every raw event has a unique `id` and that any `parentId` points to another event in the same log.
2. If `finalEventId` is present, trace parent links backward from that final event and analyze only that lineage. Without `finalEventId`, scan the raw events in order.
3. Keep successful events matching the supported capability sequence: `shipments.list`, `credits.issue`, `crm.update`, `notifications.send`.
4. Classify every non-kept event into `branchAnalysis.discarded` with its operation, status, description, optional error, and reason.

Discard reasons separate actual failures from other non-runtime paths:

- `failed_tool`: a failed event on the analyzed path.
- `skipped_tool`: a skipped event on the analyzed path.
- `abandoned_branch`: an event outside the final lineage.
- `unsupported_success`: a successful event whose operation is not part of the supported capability.
- `non_causal_success`: a successful supported event that was not selected for the final ordered path.

The resulting `branchAnalysis` records the raw event count, kept event ids, discarded branch records, and the strategy used (`lineage` or `ordered_success_scan`). `compile` carries the kept ids and discarded branches into capability provenance, while verification checks that failed and abandoned branches are excluded from the runtime plan.
