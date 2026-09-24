# Repository Guidelines

## What this repository is

A JIT compiler and trusted runtime for enterprise agent capabilities. The pipeline is:
task → exploration → trajectory capture → capability extraction → schema validation →
sandbox/failure testing → policy/approval → registry/deployment → monitored execution.

Two capability families share that pipeline, the store, the audit log and the review gates:

| Family                                       | Source of evidence                                | What executes                                                               | Where                                                                      |
| -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Compiled read capability (Agent JIT, v2)** | Structured typed tool events from ≥2 trajectories | A compiler-owned IR plan run by a constrained interpreter, zero model calls | `src/compiler/`, `src/runtime/`, `/api/v2/*`                               |
| **Shipping demo capability (v1)**            | A four-step normalized trajectory                 | A fixed shipment plan over local fixtures                                   | `src/compiler/compile.ts`, `src/runtime/execute.ts`, `/api/capabilities/*` |
| **Coding task replay**                       | A recorded Codex CLI session                      | The Codex CLI again, under a sandbox policy and assertions                  | `src/registry/coding.ts`, `/api/coding-capabilities/*`                     |

The v1 shipping path and the coding replay path predate the compiler and are kept working; new
compiler and runtime work belongs in the v2 path. Never mix exploratory browser automation with
approved production execution.

## Project structure

```text
src/
  exploration/
    tool-events.ts        # Typed tool-event + trace schemas, redaction, capture (v2)
    sample-traces.ts      # Two fixture trajectories used as compilation evidence
    provenance.ts         # Data / control / effect DAG built from captured events
    capture.ts            # v1 trajectory capture and raw branch pruning
  compiler/
    ir.ts                 # IR schema, digest, structural validation, artifact types
    patterns.ts           # Canonical node keys, subgraph signatures, cross-trace mining
    parameterize.ts       # Constant vs parameter vs reference inference with evidence
    passes/               # prune, dedupe-reads, schedule
    compile-ir.ts         # Pipeline orchestrator: traces -> validated IR + compile report
    emit.ts               # Artifact packaging, digest, tamper check
    compile.ts            # v1 shipping capability compiler
  runtime/
    interpret.ts          # The IR interpreter (the only executor of compiled capabilities)
    dispatcher.ts         # Typed candidate selection, guard evaluation, agent fallback
    checkpoint.ts         # Deoptimization checkpoints and effect-receipt shape
    observable.ts         # Normalized observable projection of a run
    adapters/registry.ts  # Adapter contracts, scopes, versions, mock adapters, faults
    execute.ts            # v1 shipping interpreter
  verification/
    verify-ir.ts          # Verification suite run against the candidate artifact
    equivalence.ts        # Observable-result comparison
    verify.ts, coding.ts  # v1 and coding-replay verification
  policy/, registry/, telemetry/, graph/, agent/
  registry/jit.ts         # Control plane: ingest, compile, verify, approve, dispatch, profile
  service.ts, app.ts, server.ts, web/
tests/
  unit/ failure/ compiler/ runtime/ differential/ integration/
```

Configuration belongs in `config/`, architecture decisions in `docs/adr/`.

## Implemented today

**Compiled read capability — `load_customer_context`**

- Typed tool events carry arguments **with their provenance** (`task_input`, `event_output`,
  `literal`), typed result projections, resource refs, effect class, adapter version, policy
  version and credential scope ids. Secrets are redacted at capture.
- `buildProvenance` derives data edges from value references and effect edges from shared
  resource keys. `parentSpanId` and wall-clock order are never treated as dependencies; the
  sample trace has deliberately misleading span lineage to keep that honest.
- `minePattern` requires **two traces to agree on a normalized subgraph signature** before
  anything compiles. `bindNode` generalizes a literal to a parameter only on declared task-input
  lineage that matched the task input in every supporting trace.
- Passes: prune (exploratory branches leave the plan but stay in provenance as exception
  evidence), dedupe-reads (same operation, args, principal, adapter version and freshness window;
  writes are never coalesced), schedule (dependency-aware levels and a concurrency bound).
- `emitArtifact` packages IR + pinned adapter versions + scopes + guards + invariants +
  provenance under a SHA-256 digest. `interpret` is the only executor: no `eval`, no generated
  source, no network, no credentials, `llmInvocations: 0` by construction.
- `checkGuards` evaluates artifact status, digest, compiler version, task kind, input schema,
  tenant, snapshot, policy version, adapter versions, scopes and data freshness before anything
  runs; a guard miss never reaches an adapter.
- A failed or unsupported run raises `DeoptimizationError` and the dispatcher turns it into an
  `ExecutionCheckpoint` (completed nodes, live values, observed resource versions, empty effect
  ledger) instead of a partial result. `POST /api/v2/runs/:id/recover` records how a handoff was
  resolved as exception evidence.
- `verifyIR` runs ~19 checks against the candidate artifact: differential comparison with both
  source traces, distinct-output, dedupe and parallel-preservation regressions, schema, scope,
  drift, freshness, timeout, malformed-output, cross-customer, wrong-snapshot,
  unsupported-input deoptimization, privilege-expansion and effect-declaration checks.
- `JitRegistry` versions artifacts, gates approval on a passing suite **against the same
  digest**, deploys one active version per name, supports revoke/redeploy rollback, and keeps a
  profile that separates compiled runs from agent fallbacks.
- UI: **JIT compiler** page (`src/web/JitPanel.tsx`) with trace, compiler, artifact, dispatcher
  and profile views.

**Not implemented — do not describe these as working**

- Resuming a compiled plan _after_ a checkpoint (the checkpoint is recorded, not replayed).
- An effect ledger for real external writes: intents, provider receipts, reconciliation states.
  `completedEffects` is empty because the compiled capability is read-only, which is a fact about
  this capability, not a general guarantee.
- Incremental specialization (an agent-resolved exception compiled into a tested v2 branch).
- Profitability-driven compilation; the profile counts runs but decides nothing.
- Frequent-subgraph mining, anti-unification, a TypeScript emission backend, write opcodes,
  multi-tenant or non-fixture adapters.

## Design notes that constrain changes

Full rationale in [docs/agent-jit-design-notes.md](docs/agent-jit-design-notes.md); the ADRs in
`docs/adr/` record the decisions actually taken.

- **Evidence, not chronology.** A dependency needs value provenance or an effect constraint.
- **Evidence, not similarity.** Matching strings never justify a parameter; a single trace
  establishes a candidate, never permission.
- **The artifact is the unit of trust.** What executes is the digested IR. A generated source
  string that nothing runs is not a capability, and a model prompted a second time is not a
  deployment.
- **Guards before effects.** Deterministic guards decide the last mile; semantic matching may
  only propose a candidate.
- **Fail closed, hand off precisely.** An unsupported state produces a checkpoint, not a partial
  result and not an improvisation.
- **No privilege expansion.** Compiled artifacts inherit at most the caller's scopes; having
  done something once never grants permission.
- **No arbitrary generated code in the trusted runtime.** Whitelisted IR and trusted adapters.
- **Honest measurement.** Recorded trace costs include exploration and are fixtures; never
  present them as a controlled benchmark, and never compute a token-reduction percentage across
  two different tasks. Label simulated runs explicitly.

## Repository skills

Load the relevant repository-local skill before making domain changes:

- `.agents/skills/supabase-postgres-best-practices/` for PostgreSQL schemas, migrations, RLS,
  indexes, queries, and performance.
- `.agents/skills/react-best-practices/` for React components, rendering, data fetching, bundles.
- `.agents/skills/backend-patterns/` for Node APIs, service/repository boundaries, caching, jobs.
- `.agents/skills/agent-evaluation/` for agent test design, rubrics, regression comparisons.

Skills guide implementation but do not override repository policy, security boundaries, or
explicit task requirements.

## Build, test, and development commands

Node.js 24+ and npm. Root `make` targets wrap the same npm scripts CI uses.

```sh
make setup             # npm ci
npm run dev            # API on 127.0.0.1:3001, Vite UI on 127.0.0.1:5173
npm test               # unit, failure, compiler, runtime, differential
npm run test:integration
npm run eval           # v1 regression suite + compiled-capability verification and dispatch
npm run lint           # tsc --noEmit + prettier --check
npm run build          # tsc --noEmit + vite build
npm run test:e2e       # after build; needs npx playwright install chromium
```

`FOUNDRY_DB` overrides the SQLite path; `FOUNDRY_CODEX_DRY_RUN=true` enables labeled simulated
coding runs.

## Coding style and naming

Prettier (`singleQuote`, `printWidth: 100`, `trailingComma: all`) and `tsc --strict` are the
contract; run `npm run format` before committing. Prefer small typed modules and explicit
side-effect declarations. Capabilities are verbs in `snake_case` (`load_customer_context`), IR
node ids and join keys are `snake_case`, types are `PascalCase`. Keep adapters provider-specific
and compiler logic model-agnostic. Validate every external input with Zod at the boundary and
throw `DomainError` with an accurate HTTP status. Comments explain why a rule exists, not what
the line does.

## Testing and trust requirements

Every capability declares schemas, permissions, side effects, invariants, retries and rollback.
Cover happy paths plus malformed input, denied permissions, timeouts, partial failure, stale
data, retries and upstream change. Every compiler pass needs a test proving it preserves the
observable behaviour it claims to preserve. Verification must test the artifact that will run —
never a hardcoded fixture standing in for it. Use fake credentials and sandbox systems only.
Promotion requires passing schema, sandbox, policy, failure and regression checks on the exact
digest being approved; fixes require a reproducing test.

## Commits and pull requests

Conventional Commits, e.g. `feat(compiler): infer parameters from trace lineage`. Pull requests
identify affected layers, risk and policy impact, tests and evals run, migration and rollback
plans, and linked issues. State plainly which milestone a change delivers and which claims it
does **not** support yet. Never commit secrets, customer trajectories, tokens or production data.
