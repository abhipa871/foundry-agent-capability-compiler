# 0003 — General task contracts and model-independent exploration

Status: implemented on `abhi-dev`, based on `nikil-dev`.

The CRM-shaped schemas cannot safely represent a different task by renaming a prompt. General
task compilation therefore has its own versioned IR format inside the v2 pipeline. Applications
register task kinds and tools in trusted TypeScript, using Zod schemas, versions, effect classes,
scope requirements, timeouts, task authorization, tool authorization and result isolation checks.
Neither a model nor an API caller can register executable handlers.

`compiler/contracts.ts`, `compiler/task-ir.ts`, `exploration/task-observer.ts`,
`runtime/task-runtime.ts`, `registry/tasks.ts`, and `integration/task-client.ts` form the general
path. It uses the existing tenant-scoped SQLite store, audit records, role permissions and
Ed25519 signer. The original CRM compiler and SDK remain compatibility surfaces; their artifacts
cannot be silently converted to general artifacts. General APIs live under `/api/v2/tasks`.

Bindings select whole JSON values or nested object/array paths from task input or earlier tool
results. Literals stay literals; matching strings do not establish provenance. Compilation requires
two distinct trace IDs and at least two distinct inputs with the same declared dataflow and access
context. It validates each argument binding against recorded values and each observable result.
The current general compiler accepts bounded DAGs and object output projections; it does not infer
branches or loops. No duplicate reads are coalesced without freshness evidence.

Verification uses both source traces and at least two independent, application-supplied sandbox
cases against the actual candidate. It checks identity, snapshot, policy, stale context and tamper
guard failures before tool invocation. Approval binds verification to the exact digest. Deployment
selects one artifact per tenant, principal and capability name; revocation removes it. The SDK
requests a signed offer for every invocation, with a maximum 30-second ticket lifetime. An already
issued offer cannot provide instantaneous revocation across disconnected clients.

Activation also requires native-authoritative shadow matches on three distinct inputs (trusted
application code can configure 2–32), against the current verification stamp and access context.
Any failed/mismatched comparison blocks deployment. Reverification invalidates coverage. This
preserves the existing native-shadow trust boundary for general capabilities.

The interpreter has no model client and cannot evaluate generated code. It schedules independent
nodes within the registered concurrency limit, validates every result, drains in-flight siblings
on failure and produces an unresolved checkpoint. Checkpoints are handoff records, not resumable
compiled continuations. Scope/identity denial never becomes an automatic model fallback.

General-purpose means domain-independent contracts, not permission to compile every operation.
Supported effects are `read` and trusted `pure` computation. Real external writes remain excluded
until intents, receipts, reconciliation, idempotency and compensation are implemented. Tool
handlers are trusted application code; the engine cannot prove their purity or sandbox an
arbitrary Node callback. Version changes must accompany changes to handler semantics or policy.
Determinism describes plan selection/control flow for validated inputs and pinned contracts.
External read values can change; reproducible outputs require a reproducible snapshot.

Provider exploration uses `agent/providers.ts`: OpenAI Responses (or explicit legacy Chat),
Moonshot Chat, Claude Messages, Gemini GenerateContent, xAI Responses (or explicit Chat), and
OpenRouter Chat. Model IDs are open-ended. Availability and tool support depend on the provider
and account; the engine does not pretend an embedding, image-only or non-tool model can execute
a tool loop. Provider continuation blocks remain in memory. Only normalized usage is exported.

Replay capture is opt-in per tool (`replaySafe: true`). Inputs and tool results in replay evidence
are sensitive application data. Credentials belong in handler closures and server environment,
never task arguments, traces or literals. Applications must use non-secret projections and
apply their retention policy; provider adapters do not introduce credential storage endpoints.

Rollback: redeploy a previously approved compatible general artifact, or use the original agent.
The CRM/v1/coding paths remain available and keep their existing trust and lifecycle rules.
