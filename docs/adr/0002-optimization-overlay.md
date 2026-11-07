# ADR 0002 — Tenant-scoped optimization overlay with a customer read runtime

Status: implemented for the approved seven phases and the read-only fixture workflow.

Reuse the v2 compiler, matcher, registry and interpreter. Capture normalized observable evidence
through explicit tool/model wrappers; keep values local by default and require replay opt-in.
Analyze structural patterns offline inside tenant/principal/version/policy/snapshot partitions.
Create draft candidates through the existing compiler, then require exact-digest validation and
full context equivalence, including independent oracle and held-out fixture input.

Native execution remains authoritative during shadow. Trust server-recorded comparisons only;
customer reports may disable their own optimization conservatively but cannot promote it.
Separate hosted approval, deployment and controlled traffic routing. Customer SDKs receive only
minimal executable IR and signed control-plane attestations, with pinned Ed25519 verification,
caller identity binding and short leases. Matchers, compilers and validation suites remain private.

Keep durable identity isolation, quotas, health and tenant settings in existing SQLite rather than
introducing a graph database or streaming platform. Quarantine removes deployment and new offers;
rollback requires a healthy previously approved artifact with current shadow coverage. Revalidation
resets evidence and hosted promotion. Local-demo keeps the existing manual demonstration flow,
while signed customer offers always enforce the stronger gate.

Consequences: no arbitrary generated code, financial writes, new providers or semantic routing.
Read-only fallback can safely restart with a checkpoint. Snapshot contracts and validators remain
fixture-specific. A real production connector must establish coherent authorization/freshness and
independent correctness before widening the domain. Synchronous best-effort telemetry and the
single-process SQLite control plane are deliberate V1 limits, not production scalability claims.

See [integration](../customer-sdk.md), [phase gates](../optimization-implementation.md) and the
[implementation report](../implementation-report.md) for operational details and measured limits.
