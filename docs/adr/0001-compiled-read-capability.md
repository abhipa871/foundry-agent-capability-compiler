# ADR 0001 — Compile structured traces to a guarded IR instead of generating source

**Status:** Accepted. Implemented for the read-only `load_customer_context` capability.

## Context

The prototype stored a generated TypeScript `implementation` string on each capability, while
the runtime executed a separate hardcoded shipment plan. The string therefore proved nothing
about what ran, and re-prompting Codex with a summarized trajectory was labeled "deployment"
although it still spent inference on every task. Milestones P0–P4 of
[the design notes](../agent-jit-design-notes.md) close that gap.

## Decision

1. **Capture typed tool events, not descriptions.** Each argument records its provenance
   (`task_input`, `event_output`, `literal`) alongside its observed value, plus typed result
   projections, resource refs, effect class, adapter version, policy version and credential
   scope ids. A free-form description can never produce an executable node.
2. **Derive dependencies from value provenance and effect constraints only.** `parentSpanId` and
   wall-clock order are observability, not dataflow. The sample trace records misleading span
   lineage so a regression here fails a test.
3. **Require cross-trace agreement before compiling.** Two traces must produce the same
   normalized subgraph signature, and a literal becomes a parameter only when declared task-input
   lineage matched the task input in every supporting trace.
4. **Execute a whitelisted IR, never generated code.** `interpret` walks compiler-owned nodes
   through trusted adapters: no `eval`, no network, no credentials, no model calls. A TypeScript
   backend, if it ever exists, is a derived artifact for review — not the executor.
5. **Make the artifact the unit of trust.** IR, pinned adapter versions, scopes, guards,
   invariants and provenance are digested with SHA-256; approval binds to that exact digest, and
   dispatch recomputes it.
6. **Check guards before effects.** Artifact status and digest, compiler version, task kind,
   input schema, tenant, snapshot, policy version, adapter versions, scopes and data freshness
   are all deterministic. A guard miss never reaches an adapter.
7. **Deoptimize with a checkpoint.** Unsupported state produces completed nodes, live values and
   observed resource versions for an agent to continue from — never a partial result.
8. **Verify the candidate, not a fixture.** The suite differentially compares the compiled
   observable result against every supporting trace, then proves the unsafe paths fail closed.

## Consequences

- The compiler is now the thing that discovers the plan; changing the sample traces changes the
  IR, and mutating the IR changes the digest and fails approval.
- Optimizations are measurable and named in the artifact: one duplicate read eliminated, two
  independent reads parallelized, two exploratory branches pruned with their evidence retained.
- The capability is read-only on purpose. Write opcodes need the effect ledger (intents,
  idempotency keys, provider receipts, reconciliation) that this ADR does not deliver, and
  "exactly once" must not be claimed across external providers.
- Recorded trace costs (LLM calls, tokens) stay labeled as fixture evidence about the agent path.
  They are not a controlled benchmark against the compiled path.
