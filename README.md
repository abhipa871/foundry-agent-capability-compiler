# Foundry Agent Capability Compiler

Foundry is a local prototype for turning repeated, structured AI-agent tool workflows into
validated capabilities that can run without asking a model to plan the same reads again.

The first optimization is **`load_customer_context(customerId)`**: retrieve a customer record,
all orders, and refund history through three authorized, typed read tools. A support agent can
then use that context to make a recommendation and write a reply. Foundry optimizes the
retrieval region; the remaining reasoning and response generation still use the model.

**Branch: `nikil-dev`.** This branch includes the v2 compiler, optimization overlay, private
Node SDK, contract-based execution selection, optional direct agent fallback, and live-agent
evaluation harnesses. It is a local integration prototype, not a production SaaS service.
The latest routing evaluation is **incomplete**; its held-out run has not started.

## Quick start

### Requirements

- Node.js **24 or newer** and npm.
- An authenticated Codex CLI on `PATH` for real Agent chat and live-provider experiments.
  The compiler fixture demo and normal tests do not require live model inference.

```sh
git clone --branch nikil-dev https://github.com/abhipa871/foundry-agent-capability-compiler.git
cd foundry-agent-capability-compiler
npm ci
npm run dev
```

If you already have the repository, switch to `nikil-dev` before installing and starting it.

- **UI:** <http://127.0.0.1:5173>
- **API:** <http://127.0.0.1:3001>
- **Database:** `data/foundry.sqlite`

The server binds to loopback. `FOUNDRY_DB` overrides the database path.
`FOUNDRY_CODEX_DRY_RUN=true` enables explicitly labeled simulated coding runs; their model/token
measurements are fixtures. Live-provider benchmarks refuse dry-run mode.

## How Foundry works

1. **Observe:** capture typed tool events, declared argument provenance, read results and actual
   reported model usage. Missing measurements remain unknown.
2. **Find a repeated structure:** the existing matcher requires at least two compatible
   trajectories to agree on a normalized read subgraph.
3. **Compile:** bind declared inputs, remove exploratory branches, deduplicate compatible reads
   and schedule independent reads. Emit a digested intermediate representation (IR).
4. **Validate:** check the exact artifact against source evidence, independent full-context
   expectations, authorization, freshness, drift, malformed responses and failure cases.
5. **Review and promote:** verify, establish native-authoritative shadow evidence, approve and
   deploy. Signed SDK offers bind the executable artifact to the caller.
6. **Execute and monitor:** check guards, run the constrained interpreter, report health and
   hand off when compiled execution is unavailable or fails.

The compiled read interpreter executes allowed IR operations through supplied adapters. It does
not execute generated source or call a model. This does **not** make an entire support agent
model-free, remove business reads, or guarantee savings for arbitrary agent tasks.

The original local-demo approval flow is preserved. Authenticated v2 deployments use separate
approval/deployment and shadow gates; see [SDK integration](docs/customer-sdk.md).

## What is implemented

| Component                      | Behavior                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| v2 read compiler               | Reuses structured evidence to compile `load_customer_context` into guarded IR.                                                   |
| Observation and privacy        | Captures typed events and usage; SDK telemetry defaults to structure/status/timing without business values or private reasoning. |
| Offline pattern analysis       | Groups compatible tenant-scoped observations and proposes drafts through the existing matcher/compiler.                          |
| Validation and shadow          | Checks full context and failures; the native result remains authoritative during shadow execution.                               |
| Private Node SDK               | Keeps read adapters and their credentials customer-side; verifies signed runtime offers.                                         |
| Execution selection            | Uses application-owned task contracts to choose prefetch, agent tools, normal execution or denial.                               |
| Direct fallback and read reuse | Can defer a miss to the original support agent and reuse validated, authorized, fresh reads within one request.                  |
| Capability lifecycle           | Supports health monitoring, quarantine, guarded rollback, revalidation and retention operations.                                 |
| Agent chat and coding replay   | Records Codex sessions and replays approved coding tasks under sandbox rules and assertions.                                     |
| v1 shipping demo               | Retains the earlier fixture-based shipping workflow and regression checks.                                                       |

Coding replay invokes Codex again; it is separate from the model-free v2 read interpreter.
Coding tasks can change workspace files according to their sandbox policy.

## Choosing an execution mode

The application registers a task contract with `defineContextContract` and asks `selectExecution`
for a mode and an explainable reason. The application applies that decision when running its
agent. Registration establishes application provenance; the application must validate the
meaning of its contract. Foundry does not infer trusted requirements from user/model prose.

| Task contract                                            | Selected mode                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Known requirement for customer, orders and refunds       | Compiled context prefetch before the agent starts.                       |
| The agent must decide whether complete context is needed | Offer the compiled context tool alongside appropriate original tools.    |
| Partial context or no customer context required          | Normal execution; the current compiled family reads all three resources. |
| Required tool/record authorization is denied             | Denial, without a fallback bypass.                                       |

Placement does not override artifact compatibility, signature, rollout, freshness or health
checks. The SDK's default miss behavior invokes its configured native context callback.
Applications can opt into `execute(request, { fallback: 'defer' })` and let their existing
support agent use its original authorized tools instead.

`RequestReadCache` is scoped to one request and requires an explicit freshness contract. It
validates typed results, rechecks authorization and binds reuse to customer, tenant, principal,
policy, snapshot and adapter versions. A partial result is never presented as complete context.
See [the routing integration guide](docs/execution-routing.md) for the contract and handoff rules.

## Try the compiler demo

Open **JIT compiler** in the UI:

1. **Load sample traces** for two customers, with different call ordering, exploration and a
   duplicated read.
2. **Compile candidate** to inspect the shared structure, parameter binding and optimized IR.
3. **Verify candidate** to run artifact, equivalence, policy and failure checks.
4. **Approve version** to approve the exact digest and activate it in the local demo.
5. Use **Dispatcher** to compare compiled execution and deoptimization. With the default fixture
   adapters, `C-101`/`C-202` succeed and unsupported `C-404` produces a handoff checkpoint.
6. **Record recovery** to retain how the handoff was resolved.

Sample trace costs are fixtures, not benchmark evidence. Recording recovery does not resume the
compiled plan. The expanded evaluation harness supplies its own synthetic adapters for additional
customers; those records do not extend the default demo adapter's domain.

For coding tasks, use **Agent chat → Prepare deployment → Registry → Coding task registry**.
Choose sandbox limits and assertions, run verification, approve, then **Deploy and measure**.
Only successful replay with passing assertions becomes active. Revocation prevents future
execution; restoring changed files requires version control or backups.

## Evidence and current limitations

Live experiments use real provider inference with synthetic, read-only business records.
The retained results measure different workloads and should not be pooled into one savings claim.

| Experiment                                                          | Retained finding                                                                                                                                                            | Scope                                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Context-only retrieval](docs/real-agent-experiment.md)             | Across 30 pairs, tokens fell from 8,533.67 to zero and model calls from two to zero.                                                                                        | Retrieval was the entire task; this is not 100% savings for a complete support agent.                               |
| [Complete support task](docs/support-agent-experiment.md)           | Compiled tool saved 2.15% of total tokens; application prefetch saved 49.78% and one of two model calls.                                                                    | 18 matched trials, 54 outputs passing the study's evidence/action/reply checks.                                     |
| [Routing and fallback evaluation](docs/routing-agent-experiment.md) | Held-out: selector with direct fallback used 18.4% fewer tokens than normal tools and 20.5% fewer than native fallback; handwritten prefetch used 42.5% fewer than Foundry. | 72 development + 144 held-out requests, all oracle checks passed; API-equivalent estimates on a synthetic workload. |

In the routing study's one completed quarantine pair, direct fallback saved **30.25% of tokens**
and one of three model calls versus the same selector using a native context agent. It cost
**4.09% more than normal execution** in that case, and handwritten prefetch used fewer tokens and
calls. This does not establish an overall improvement or superiority over handwritten orchestration.

Monetary figures in the reports are historical **API-equivalent pricing estimates**, not measured
ChatGPT subscription charges. Actual billing, audited transport retries and some infrastructure
costs are unknown. Cache usage, setup, shadow, revalidation, fallback, failures and outliers are
retained. Small samples do not establish production tail-latency gains.

Before production use, the project still needs real connector/snapshot validation, metered billing,
a completed held-out routing evaluation, broader reply-quality assessment and deployment-specific
security/operations integration. There is no automatic profitability-driven compilation, compiled
checkpoint resumption, real financial-write capability, arbitrary generated-code execution in the
compiled read runtime, or production external-write effect ledger. Operators must schedule maintenance/revalidation; there is no scheduler.

## Tests and development

```sh
npm run test:all         # All unit and integration tests
npm run eval             # Existing v1/v2 regression and artifact checks
npm run lint             # TypeScript and formatting checks
npm run build            # Production frontend build
npm run build:sdk        # Private SDK package in dist-sdk
npx playwright install chromium
npm run test:e2e         # Browser tests; run after build
```

`npm test` and `npm run test:integration` run the smaller suites separately. Equivalent root
`make` targets are available. Last recorded implementation validation passed **149 tests in
29 files**, all existing evals, builds/lint, SDK smoke checks and **two browser tests**.

The SDK package is private and unpublished. Its interpreter, schemas and observation wrappers
are customer-side; matching, compilation, registry policy and verification stay server-side.

### Opt-in experiments

```sh
npm run analyze -- --demo             # Offline analysis of fixture traces
npm run benchmark:optimization       # Controlled SDK fixture replay; no live inference
npm run benchmark:real-agent         # Live context-only agent experiment
npm run benchmark:support-agent      # Live complete support-task experiment
npm run benchmark:routing-agent -- development
npm run benchmark:routing-agent -- heldout
```

Live commands require authenticated Codex access and consume provider inference. Normal tests
are separate from these experiments. Read [the frozen routing plan](docs/routing-agent-plan.md)
before starting a routing run: existing retained evidence paths cause it to refuse overwrites.
Development must pass before the separate held-out run; do not tune against final-set results.

## Security and API integration

The local demo accepts loopback requests; local mutations require
`X-Foundry-Client: local-ui`. This header is a local-demo control, not tenant authentication.
Authenticated mode is configured with `FOUNDRY_IDENTITY_CONFIG` and
`FOUNDRY_SIGNING_KEY_FILE`, exposes the v2 API, and uses bearer credentials, tenant/principal
identity, role permissions, tool scopes and record authorization. Private signing keys and
customer tool credentials must stay outside version control.

Common v2 endpoints include:

| Operation                 | Endpoint                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| Capture evidence          | `POST /api/v2/traces`                                                             |
| Analyze / propose         | `POST /api/v2/patterns/analyze`, `POST /api/v2/patterns/:patternId/compile`       |
| Verify / approve / deploy | `POST /api/v2/capabilities/:id/{verify,approve,deploy}`                           |
| Trusted shadow            | `POST /api/v2/artifacts/:id/shadow`                                               |
| Signed runtime offer      | `GET /api/v2/runtime/capability`                                                  |
| Dispatch / recovery       | `POST /api/v2/tasks/dispatch`, `POST /api/v2/runs/:id/recover`                    |
| Health / revalidation     | `GET /api/v2/capabilities/:id/health`, `POST /api/v2/capabilities/:id/revalidate` |

The standalone server does not supply a real native agent callback for trusted shadow execution;
that requires an application runtime integration. See [SDK integration and operator APIs](docs/customer-sdk.md)
for setup, exact request bodies, promotion gates and deployment boundaries.

## Repository map

```text
src/compiler/       Pattern matching, parameter binding, compiler passes and IR
src/exploration/    Typed traces, provenance, observation and redaction
src/runtime/        Guarded dispatcher, constrained interpreter and read adapters
src/integration/    Private SDK, signed protocol, execution selection and read reuse
src/verification/   Artifact, equivalence, security and failure checks
src/registry/       SQLite-backed lifecycle, deployments and audit records
src/security/       Identity and artifact signing
src/telemetry/      Measurements and capability health
src/agent/          Codex CLI integration
src/web/            React UI
scripts/            Evaluations, SDK build and benchmark harnesses
tests/              Unit, failure, compiler, runtime, differential and integration tests
e2e/                Browser lifecycle tests
docs/               Architecture, integration guides, reports and retained evidence
```

## Further reading

- [Implementation report](docs/implementation-report.md) and [phase checkpoints](docs/optimization-implementation.md)
- [Routing evaluation report and raw evidence](docs/routing-agent-experiment.md)
- [SDK integration](docs/customer-sdk.md) and [execution selection/fallback](docs/execution-routing.md)
- [Compiled-read architecture](docs/adr/0001-compiled-read-capability.md) and [optimization overlay](docs/adr/0002-optimization-overlay.md)
- [Design notes](docs/agent-jit-design-notes.md), [coding-task security](docs/coding-task-security.md) and [branch-analysis provenance](docs/branch-analysis.md)
