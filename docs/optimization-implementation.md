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
