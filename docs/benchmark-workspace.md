# Benchmark workspace

The local web app opens to a paired customer-support playground. It supports two experiences:
enter a prompt and compare complete-task execution, or inspect how to integrate the existing
private Node SDK with an application's agent. The existing compiler console, registry, coding
replay and v2 API remain available.

All views share one sidebar, header, workspace identity and visual design. Choose **Agent
playground**, **Benchmark results**, **Run history**, **Developer console**, or **API & SDK**:
the sidebar has five destinations. The console groups work into Workflow, Capabilities, and
Activity. A contextual **More tools** selector retains the audit log, dependency graph, shipping
trajectories, and coding-agent chat without occupying sidebar entries. These legacy demo views
are labeled separately from compiled read capabilities.

The compiler is a guided **Build → Validate → Run** workflow. Build gathers recorded evidence
and compiles a candidate. Successful compilation advances to Validate; successful explicit
approval advances to Run. Navigation advances only after the operation and state refresh succeed.
Verification and approval stay separate actions. Run is disabled until a deployed approved
version exists, and runtime guards still decide execution. No dispatch happens automatically.

Evidence tables, compiler diagnostics, validation details, artifact JSON, guard checks, and
performance/history are expandable within their relevant step. A version selector appears when
multiple artifacts exist. The console uses the benchmark design on desktop and mobile.

Switching views preserves prompt drafts, benchmark results/history, and the compiler's selected
tab and inputs. No separate portal or return-to-workspace action is necessary. Developer pages
also provide **Open playground** as a direct shortcut.

## Start

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Local preview requires no model account. It runs the actual
compiled fixture reads and produces a deterministic demonstration response; it does **not**
interpret arbitrary prompts. Input, output, cache, total-token and model-call comparisons stay
unknown. Preview is not evidence of inference savings.

For actual inference, authenticate the existing Codex CLI, choose a model available to that
account, and restart the server with live execution enabled. For example:

```sh
FOUNDRY_BENCHMARK_LIVE=true FOUNDRY_BENCHMARK_MODEL=gpt-6.1-sol npm run dev
```

Then choose **Live** in the playground. The model is pinned server-side for both arms; it is not
selected from an untrusted request. Omitting the model setting preserves the existing `gpt-5.5`
default. That original model was rejected by this account during implementation; the playground
does not silently substitute models. Dry-run mode disables live execution. The server reads these
environment variables directly; copying `.env.example` alone does not load it.

## Playground

- Enter a prompt and select one of three authorized synthetic customer records.
- Choose a contract: let the agent decide, full support review, orders, eligibility, refunds, or
  general policy. Explicit scopes are application task contracts, not prompt classification.
- Run one to three paired repeats. Each pair has a normal original-tool agent and Foundry.
  The first arm is randomized and order alternates across repeats.
- Inspect both replies, input/output/cached/total tokens, model calls, actual business reads,
  complete latency, estimated inference cost where known, checks, fallback and selector overhead.
- Inspect every pair's read trace or download the JSON, including full structured evidence,
  failures, order and structured-result equivalence. Reply wording is not an equivalence criterion.

Each live arm has a six-response abort threshold, a ten-tool-call cap and a 60-second turn
timeout. The response threshold is checked on provider usage updates; inference may already be
in progress before its usage arrives. Reads have a two-attempt request budget. Provider startup, cleanup, selectors, compiled
execution and fallback remain inside the arm's wall-clock measurement. RPC cleanup may extend
past the turn timeout. One batch executes at a time; concurrent batches receive HTTP 409. The UI
states the task count and configured response budget before execution. This is an abort threshold,
not a hard monetary spending cap.

The selector prefetches only for registered known scopes. Agent-decided tasks offer the existing
full-context loader plus original tools. Policy-only tasks read no customer records. Guard misses
defer to the same support agent, and valid request-local reads can be reused. Authorization denial
never authorizes fallback access. No compiler, interpreter, SDK routing semantics or production
capability is rewritten by this UI.

An isolated in-memory capability is compiled from two synthetic typed observations, verified
against the existing suite, and checked against independent full contexts for three customers.
It is not installed in the workspace registry and cannot promote a customer deployment. The
one-time fixture setup duration and check count are reported separately. Its zero inference cost
means no model ran during fixture setup; it does not assign zero cost to CPU or infrastructure.

## Reading results honestly

The initial dashboard and **Benchmark results** page read
`docs/selective-agent-v1.1-heldout.json`. They display retained historical evidence, labeled with
its date; they are never represented as results for a newly entered prompt. The four retained
arms include handwritten prefetch, which wins on tokens overall.

For new live runs, provider-reported usage is recorded through the existing observer. Failed or
incomplete usage remains null, and negative savings remain visible. Cached input is a subset of
input tokens, not an extra token category to add to the total. Pricing uses the existing dated
`gpt-5.5` API-equivalent rate card only for that model. Different models have unknown monetary
cost and savings; actual subscription billing is always unknown.

Explicit scopes use the existing independently stated support oracle, permitted-read checks and
reply-grounding checks. The prompt must remain within the selected scope. Agent-decided arbitrary
prompts receive factual evidence/policy checks only: task intent and completeness are not
independently certified. Pairwise matching does not prove either answer is correct. The UI does
not promise that every interaction saves tokens.

One to three repeats are exploratory measurements, not production latency estimates. The full
benchmark scripts and their separate development/held-out methodology remain the appropriate
route for a formal study.

## SDK experience and security

**API & SDK** provides a copyable integration skeleton, a visual application → SDK → authorized
tools/native agent diagram, and the observe/verify/shadow/promote lifecycle. It uses the existing
private SDK build (`npm run build:sdk`), not a fictional public npm package. See
[customer SDK integration](customer-sdk.md) for authentication, signed offers, guards and rollout.

The new endpoints are local-only:

| Endpoint                       | Purpose                                       |
| ------------------------------ | --------------------------------------------- |
| `GET /api/benchmarks/config`   | Capabilities, pinned model and task examples  |
| `GET /api/benchmarks/evidence` | Validated retained aggregate evidence         |
| `POST /api/benchmarks/runs`    | Strictly validated, bounded paired comparison |

Existing loopback/origin checks and mutation-header requirements protect the routes. Hosted
mode excludes them. Requests cannot supply adapters, credentials, executable code, identity,
arbitrary customer IDs, model/provider configuration or custom read contracts. Provider tools are
read-only and bound to the authorized customer. Raw reasoning and provider errors are not logged.
Prompts and results are returned to the local caller but are not persisted by the benchmark API.
Live prompts are sent to the selected provider. The UI keeps the latest 20 runs in memory for
the current app session; switching to the developer console preserves that history, while reload clears it.
Exports contain the prompt and synthetic evidence, and should be handled accordingly.

## Implementation and verification

- `src/web/BenchmarkWorkspace.tsx`, `benchmark.css`: responsive workspace, comparisons, history,
  downloads and SDK guide.
- `src/web/WorkspaceShell.tsx`, `workspace.css`: one persistent sidebar/header and matching
  developer-panel styles. `App.tsx` owns navigation and keeps benchmark/compiler state mounted.
- `src/web/DeveloperNavigation.tsx`, `developer-console.css`, `JitPanel.tsx`: compact console
  sections, contextual advanced tools, guided compilation, approval gates and progressive details.
- `src/benchmarks/contracts.ts`, `workspace.ts`: typed API, isolated compiler/runtime harness,
  provider accounting, independent checks and retained evidence loader.
- `src/app.ts`: local routes behind existing protections.
- `scripts/experiments/customer-agent.ts`: optional caller-pinned model; existing experiment
  defaults stay unchanged, and unmatched model pricing is not estimated.
- Integration tests cover read boundaries, unknown metrics, isolation, ordering, concurrent
  batches, malformed input, disabled live execution, hosted exclusion and provider failure.
- Browser tests cover prompt → compare → inspect → export → history → SDK, retained evidence,
  shared sidebar identity/active states, draft/result/compiler-input preservation, mobile overflow,
  failed-compilation stage preservation, approval gating, contextual advanced tools, and both
  existing compiler/coding workflows.

Final validation: 203 tests across 33 files, all seven browser tests, compiler evaluation, TypeScript,
Prettier, production UI build and private SDK build passed. Desktop/mobile screenshots were
inspected. No existing retained development or held-out benchmark artifact was modified.

Implementation smoke tests (November 3, 2026) are separate from the frozen studies. The original
model returned no usable usage in either arm; those failures remain in
[the unavailable-model record](benchmark-workspace-unavailable-model-smoke.json). One additional
single-response diagnostic classified the provider failure as model unavailability/unsupported
model, without retaining raw error messages or reasoning.

A final order-status pair used the account-catalog default `gpt-6.1-sol`:

| Metric              | Normal agent | Foundry |
| ------------------- | -----------: | ------: |
| Input tokens        |       14,723 |   7,323 |
| Output tokens       |          137 |     119 |
| Cached input tokens |        7,168 |       0 |
| Total tokens        |       14,860 |   7,442 |
| Model calls         |            2 |       1 |
| Business reads      |            1 |       1 |
| Complete wall clock |      8.060 s | 5.973 s |
| Monetary cost       |      Unknown | Unknown |

Both arms passed all seven evidence/decision/read/grounding checks, with matching structured
results. Fixture setup took approximately 150 ms and passed 25 checks without model calls.
Cache usage differed between arms. This single pair establishes that the interactive measurement
path works; it does not estimate general savings, uncertainty or production latency. The complete
raw result is in [the live smoke record](benchmark-workspace-live-smoke.json). Total live work
attempted during implementation was two failed `gpt-5.5` arms, one bounded diagnostic task, and
two successful `gpt-6.1-sol` arms. Costs of the failed attempts remain unknown.
