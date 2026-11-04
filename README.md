# Foundry Agent Capability Compiler

Foundry is a local prototype for turning repeated, structured AI-agent tool workflows into
validated capabilities that can run without asking a model to plan the same reads again.

The primary SDK now accepts application-registered task and tool contracts across domains.
The general compiler turns two compatible, provenance-bearing trajectories into a guarded DAG
of typed reads and trusted pure computations. It does not require CRM fields or a fixed model.
The personal departure example combines calendar, profile, travel, weather and departure-time
calculation. Project inventory is covered by a separate cross-domain regression.

**Branch: `abhi-dev`, based on `nikil-dev`.** This branch adds the general compiler/SDK, signed
task offers, task/tool authorization, and OpenAI, Moonshot, Claude, Gemini, Grok/xAI and OpenRouter
transports with open-ended model IDs. The original CRM UI, compiler and SDK remain compatibility
examples. It is an integration prototype; generality does not remove permission or effect limits.
Completed routing and selective-context held-out evaluations are retained under `docs/`.

Start with [the general SDK guide](docs/general-sdk.md) and
[the architecture decision](docs/adr/0003-general-task-contracts.md). Supported compiled effects
are read and pure; arbitrary writes, generated code, inferred branches and checkpoint resumption
are not implemented. Deterministic execution refers to the approved plan and pinned contracts;
reproducible read values require a stable snapshot. Model exploration/final responses can vary.

```sh
npm run build:sdk
npm run benchmark:departure -- --live  # Requires GEMINI_API_KEY; consumes live inference
```

The four-arm personal-task experiment compares ordinary tools, compiled tool, compiled prefetch
and ordinary prefetch using the built SDK. It reports total tokens including reasoning, with
setup, warmups, failures and measured tasks retained. Provider adapters other than Gemini are
covered by protocol tests; this is not a live validation of every provider/model.

The [completed departure experiment](docs/departure-experiment.md) reports all four token totals,
setup/warmup consumption, SDK stress results and retained source fingerprints.

The SDK also exposes the complete compilation lifecycle (`observe`, `compile`, `verify`, `shadow`,
`approve`, `deploy`, `revoke`). Run `npm run benchmark:travel-day -- --live` after `npm run build:sdk`
to compare a 13-operation, six-stage travel workflow through the built SDK. This uses live Gemini
inference with synthetic trip data. See [the SDK lifecycle example](docs/general-sdk.md#compile-and-manage-capabilities-through-the-sdk).

[The travel-day results](docs/travel-day-experiment.md) include all four measured token totals,
full consumption accounting and the SDK lifecycle/concurrency checks.

## Quick start

### Requirements

- Node.js **24 or newer** and npm.
- An authenticated Codex CLI on `PATH` for real Agent chat and live-provider experiments.
  The compiler fixture demo and normal tests do not require live model inference.

```sh
git clone --branch abhi-dev https://github.com/abhipa871/foundry-agent-capability-compiler.git
cd foundry-agent-capability-compiler
npm ci
npm run dev
```

If you already have the repository, switch to `abhi-dev` before installing and starting it.

- **UI:** <http://127.0.0.1:5173>
- **API:** <http://127.0.0.1:3001>
- **Database:** `data/foundry.sqlite`

The server binds to loopback. `FOUNDRY_DB` overrides the database path.
`FOUNDRY_CODEX_DRY_RUN=true` enables explicitly labeled simulated coding runs; their model/token
measurements are fixtures. Live-provider benchmarks refuse dry-run mode.

### Interactive benchmark workspace

The UI opens to a prompt playground with paired normal-agent/Foundry execution, token and cache
breakdowns, latency, actual reads, correctness checks, traces, JSON exports and session history.
The **API & SDK** section explains integration with your existing agent and includes an
architecture diagram and a generic SDK lifecycle example. **Developer console** provides a guided
**Evidence → Review → Run → Registry** workflow for registered tasks. Import SDK trajectories,
compile, verify, compare native shadows, approve, deploy and revoke individual versions. Task
inputs come from their schemas. Local travel/departure fixtures require no model calls. See the
[console guide](docs/task-console.md). The sidebar has five main destinations; advanced and legacy
tools are grouped in a contextual menu. All views share one design, and switching views preserves
prompt drafts, benchmark history and compiler inputs.

Preview mode performs no inference and reports no token savings. For real usage measurements,
use an authenticated Codex CLI and explicitly enable a model available to your account:

```sh
FOUNDRY_BENCHMARK_LIVE=true FOUNDRY_BENCHMARK_MODEL=gpt-6.1-sol npm run dev
```

Select **Live** before comparing. Runs are bounded to 1–3 pairs; savings are not guaranteed.
Pricing for models without a matching rate card remains unknown. The initial dashboard shows
dated retained benchmark evidence, not a result for your prompt. See the
[workspace guide](docs/benchmark-workspace.md) for measurement details and limitations.

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

| Task contract                                            | Selected mode                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Known requirement for customer, orders and refunds       | Compiled context prefetch before the agent starts.                    |
| The agent must decide whether complete context is needed | Offer the compiled context tool alongside appropriate original tools. |
| Opt-in `subset` contract naming one or two resources     | Compiled prefetch of only those reads (experimental; see below).      |
| Partial context in a `known` contract, or no context     | Normal execution (unchanged).                                         |
| Required tool/record authorization is denied             | Denial, without a fallback bypass.                                    |

Placement does not override artifact compatibility, signature, rollout, freshness or health
checks. The SDK's default miss behavior invokes its configured native context callback.
Applications can opt into `execute(request, { fallback: 'defer' })` and let their existing
support agent use its original authorized tools instead.

`RequestReadCache` is scoped to one request and requires an explicit freshness contract. It
validates typed results, rechecks authorization and binds reuse to customer, tenant, principal,
policy, snapshot and adapter versions. A partial result is never presented as complete context.
See [the routing integration guide](docs/execution-routing.md) for the contract and handoff rules.

Selective prefetch is opt-in: pass `execute(request, { resources })` with the resources a `subset`
contract selected. The approved artifact runs only those reads plus genuine prerequisites and
returns only the requested resources. Live development and held-out results (synthetic records)
are in [selective context](docs/selective-context.md).

## Try the compiler demo

Open **Developer console → Legacy CRM compiler** in the UI for the compatibility demo:

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

| Experiment                                                          | Retained finding                                                                                                                                                                             | Scope                                                                                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Context-only retrieval](docs/real-agent-experiment.md)             | Across 30 pairs, tokens fell from 8,533.67 to zero and model calls from two to zero.                                                                                                         | Retrieval was the entire task; this is not 100% savings for a complete support agent.                                                            |
| [Complete support task](docs/support-agent-experiment.md)           | Compiled tool saved 2.15% of total tokens; application prefetch saved 49.78% and one of two model calls.                                                                                     | 18 matched trials, 54 outputs passing the study's evidence/action/reply checks.                                                                  |
| [Routing and fallback evaluation](docs/routing-agent-experiment.md) | Held-out: selector with direct fallback used 18.4% fewer tokens than normal tools and 20.5% fewer than native fallback; handwritten prefetch used 42.5% fewer than Foundry.                  | 72 development + 144 held-out requests, all oracle checks passed; API-equivalent estimates on a synthetic workload.                              |
| [Selective context prefetch](docs/selective-context.md)             | Held-out: on 14 healthy selective rows, selective prefetch used 1 model call and 4,402 mean tokens, matching handwritten prefetch (4,394) and 49.8% below normal tools and existing Foundry. | 128 held-out + 64 development live requests, all correct; held-out $2.20 API-equivalent ($4.71 known across all runs, one unknown-cost request). |

In the routing study's one completed quarantine pair, direct fallback saved **30.25% of tokens**
and one of three model calls versus the same selector using a native context agent. It cost
**4.09% more than normal execution** in that case, and handwritten prefetch used fewer tokens and
calls. This does not establish an overall improvement or superiority over handwritten orchestration.

Monetary figures in the reports are historical **API-equivalent pricing estimates**, not measured
ChatGPT subscription charges. Actual billing, audited transport retries and some infrastructure
costs are unknown. Cache usage, setup, shadow, revalidation, fallback, failures and outliers are
retained. Small samples do not establish production tail-latency gains.

Before production use, the project still needs real connector/snapshot validation, metered billing,
broader held-out workloads, broader reply-quality assessment and deployment-specific
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
29 files**, all existing evals, builds/lint, SDK smoke checks and **two browser tests**. After
selective prefetch and benchmark v1.1: **193 tests in 32 files**, evals, lint and SDK build (browser
tests not re-run).

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
npm run benchmark:selective-agent -- development --provider fixture   # No inference
npm run benchmark:selective-agent -- development --provider live --cap-usd 4
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
