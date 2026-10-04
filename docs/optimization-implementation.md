# Optimization overlay implementation checkpoints

Scope: the existing read-only `load_customer_context` workflow. Existing shipping and coding
replay remain local demonstrations. No generated source, external writes, extra providers, or
cross-tenant learning enter the optimization runtime.

## Baseline

Before changes: 74 tests across 13 files passed; type checking and formatting passed.
No performance result was inferred from the recorded sample token counts.

## Phase 1 — Foundations

- Explicit model/tool observation preserves value provenance, real call timing, measurement
  origin and unknown usage. Failed observations remain distinguishable from success.
- Structural telemetry omits raw model messages, inputs and results. Replay capture uses the
  three typed read contracts; unknown payloads are omitted by default. Redaction fails closed
  at depth/size limits.
- SQLite migration scopes records, deployments, settings, effects and durable request quotas
  by tenant. Existing data stays in `local-demo`; asynchronous request identity is isolated.
- Optional authenticated mode accepts hashed service credentials and trusted role/tool scopes;
  it exposes only the v2 API. Local loopback protections remain in local mode. Configured keys
  must be random, rotated, and supplied outside version control.
- Fallback now records resolved/unresolved/failed/denied outcomes and complete elapsed time.
  Permission denial does not call the agent. Partial read metrics survive deoptimization.
- Failed re-verification removes active deployment eligibility. Revision checks prevent stale
  verification from overriding revocation. Approval/deployment remain separate outside the
  backwards-compatible local fixture demonstration.

Production authentication, transport termination, record authorization and real adapter behavior
remain integration responsibilities. The fixture adapters still simulate business systems.

Validation gate: 80 tests across 15 files, lint/type checking and existing evaluation passed.

## Phase 2 — Offline structural analysis

`analyzePatterns` reuses canonical nodes/signatures and `minePattern`. It partitions by tenant,
principal, adapter/scopes, policy, snapshot and measurement origin, then reports support, task
success, dependencies, average calls/latency/tokens/cost, and eligibility reasons. Unknown usage
stays null and fixture evidence remains labeled. Successful unsupported work, writes, incomplete
workflows and insufficient distinct observations cannot become eligible. `npm run analyze --
--demo` is an offline fixture report; without `--demo` it reads the configured tenant database.
No routing or promotion occurs.

Phase 2 gate: 83 tests across 16 files and lint/type checking passed; offline demo exercised.

## Phase 3 — Observed patterns to existing compiler

The tenant-scoped registry persists offline reports and creates draft artifacts through the
existing compiler. Eligibility is recomputed from current traces, and repeated proposals for
the same evidence reuse the candidate. Pattern identity and measurement origin remain explicit.
The new analyze/compile endpoints never verify, approve or route candidates automatically.

Phase 3 gate: all 85 tests in 17 files and lint/type checking passed. Replay serialization selects only the raw trace wire schema; client storage metadata cannot enter ingestion. Existing v1 and coding replay tests remain passing.

## Phase 4 — validation and equivalence

Full context comparison includes CRM eligibility, tenant/customer/snapshot identity, every order ID and lateness, and every refund ID and amount. Only list order is normalized. Source evidence is checked for declared lineage, principal, scopes, versions and contracts; missing or duplicate evidence blocks verification. The candidate runs against an independent fixture oracle including held-out C-303. Unknown successful work cannot be pruned silently. Adapter outputs have size/value bounds and cancellation bounds waiting even for uncooperative adapters. Partial authorization failures retain call counts.

Gate: all 89 tests in 18 files and lint/type checking pass. Four new differential tests exercise aggregate false positives, missing evidence, forged lineage and ignored cancellation. The existing reduced-plan rejection retains its context.v1 error contract. Validation is fixture-specific; real SaaS oracle and snapshot semantics remain prerequisites for production.
