# Real-agent customer-context experiment

Foundry materially reduced measured inference work and complete request latency for the existing
read-only `load_customer_context(customerId)` task. Across 30 pairs, average reported tokens fell
from **8,533.67 to 0**, completed inference calls from **2 to 0**, and complete latency from
**6,768.86 ms to 5.99 ms**. Every full-context comparison passed, including ten held-out cases.
The three necessary business reads remained three reads.

The inference-equivalent estimate fell from **$0.01661207 to $0 per request**. Actual billed
monetary savings and total commercial ROI are **unknown**: the provider used the existing
authenticated ChatGPT/Codex account, not a metered API billing account. Hosting, connector,
engineering and human-approval costs have not been priced.

## Evidence and reproduction

- [Complete paired measurements](real-agent-benchmark.json): every pair, provider usage,
  context results, oracle comparisons, validation checks, setup, warmups, security and fallback.
- [Preflight and diagnostic measurements](real-agent-preflights.json): additional inference
  spending is retained separately rather than omitted from experiment totals.
- Run `npm run benchmark:real-agent` with Node 24 and an authenticated Codex CLI on PATH.
  `FOUNDRY_CODEX_BIN` can select the existing CLI launcher. The harness refuses dry-run mode.
  `FOUNDRY_EXPERIMENT_PAIRS` defaults to 30 and accepts 6–100; all runs still include three
  warmups. Provider failure stops the experiment and writes an incomplete report.
- Live benchmarks are opt-in, never part of normal tests/CI. No credentials, private reasoning,
  prompts or raw model event streams are written into the retained evidence.

Captured October 3, 2026 in America/New_York, October 4 UTC. Node 24.21.0, macOS arm64,
Codex CLI 0.160.0, OpenAI `gpt-5.5`, reasoning effort `none`, default service tier. The model alias
was checked at thread creation and reroutes would fail the experiment; an underlying model
snapshot identifier was not exposed.

## Controlled methodology

The baseline is a real model using the existing typed customer, order and refund-history adapters.
The agent receives a short task, three read-function definitions and a strict output schema. It
chooses its reads and can call independent reads together. There are no forced duplicate reads,
extra deliberation rounds or artificially slower baseline tools. The application already knows
the authorized customer ID, so each empty-argument function explicitly binds to `task_input`.
The model cannot substitute another customer ID through tool arguments.

Business data remains the deterministic existing `fixtures-v1` snapshot, with the adapters'
ordinary 2 ms delay. **Provider inference is live; business systems are controlled fixtures.**
This establishes a real inference comparison without touching customer systems or financial
writes. It is not a production connector benchmark.

Two live observations, C-101 and C-202, establish the structural pattern. The existing matcher and
compiler generate the draft. The existing independent fixture oracle, complete source-evidence
comparison, adapter and failure checks all pass: 21 validation checks. Three trusted shadow runs
use the real native agent, covering C-101, C-202 and C-303. Native output stays authoritative until
validation, shadow readiness, approval and deployment pass.

C-303 is held out from compilation evidence. After three warmup pairs, 30 measured pairs cover
each customer ten times. Pair order alternates baseline/compiled and compiled/baseline. Every
native request uses a fresh ephemeral provider thread. Both paths use identical identity, scopes,
record authorization, adapters and snapshot. Each path performs two real loopback control-plane
HTTP calls: obtain the offer and send telemetry. Complete elapsed time includes offer retrieval,
signature checks, dispatch, data reads, provider thread management and final telemetry.

The baseline also runs through the observation SDK. This comparison answers the effect of
switching an integrated application from observe to live routing. It does not claim that a bare
agent with no SDK has exactly the same latency.

## Steady-state results

Values are averages per request over the 30 retained pairs. Percentage savings use
`(baseline - optimized) / baseline`; zero denominators are undefined. Rate differences are
percentage points.

| Metric                                | Baseline agent | Optimized | Absolute saving | Percentage saving |
| ------------------------------------- | -------------: | --------: | --------------: | ----------------: |
| Input tokens, including cached subset |       8,356.33 |         0 |        8,356.33 |              100% |
| Output tokens                         |         177.33 |         0 |          177.33 |              100% |
| Cached input tokens, subset of input  |       6,775.47 |         0 |        6,775.47 |              100% |
| Total tokens                          |       8,533.67 |         0 |        8,533.67 |              100% |
| Completed model calls                 |              2 |         0 |               2 |              100% |
| Typed business tool calls             |              3 |         3 |               0 |                0% |
| Complete wall latency                 |    6,768.86 ms |   5.99 ms |     6,762.86 ms |          99.9114% |
| API-equivalent inference cost         |    $0.01661207 |        $0 |     $0.01661207 |              100% |
| Actual billed cost                    |        Unknown |   Unknown |         Unknown |           Unknown |
| Success rate                          |           100% |      100% |            0 pp |                0% |
| Unexpected fallback rate              |             0% |        0% |            0 pp |         Undefined |

Baseline latency p50/p95: **6,870.28 / 8,811.91 ms**. Optimized p50/p95: **5.76 / 8.30 ms**.
No warmup results are mixed into these averages. Warmup inference spending is included in the
total experiment ledger. Both paths made exactly three typed reads on every measured request.

Full optimized latency, 5.99 ms, is the measured cost of the entire optimization path, including
its overhead; it is not an interpreter-only timer. The additional time outside the baseline
observer's window averaged 31.81 ms, including provider thread cleanup and telemetry. The
observer begins before offer retrieval, so that difference is **not** an isolated measurement of
all SDK overhead. Shared module imports and control-plane bootstrap preceded the setup clock;
their startup/hosting cost remains unmeasured and unpriced rather than assumed free.

The estimate uses published GPT-5.5 standard rates of $5 per million uncached input tokens,
$0.50 cached input and $30 output, checked October 3. Each request's cached tokens are discounted
before averaging; cached tokens are not counted twice. These requests are below the long-context
pricing threshold. The formula is `((input - cached) * 5 + cached * 0.5 + output * 30) / 1e6`.
[Official model pricing](https://developers.openai.com/api/docs/models/gpt-5.5).

## One-time cost and amortization

| Setup activity                      |        Wall time | Model work / inference-equivalent cost |
| ----------------------------------- | ---------------: | -------------------------------------- |
| Provider initialization             |         42.24 ms | No inference                           |
| Two live observations               |     13,632.29 ms | 4 completed calls; $0.078087           |
| Structural analysis and compilation |          6.83 ms | 0 model calls, 0 tokens                |
| Independent fixture validation      |         96.05 ms | 0 model calls, 0 tokens                |
| Three trusted real-agent shadows    |     21,604.30 ms | 6 completed calls; $0.060665           |
| Approval and deployment             |          0.79 ms | No inference                           |
| Complete measured setup             | **35,383.36 ms** | **10 completed calls; $0.138752**      |

The conservative calculation charges the ordinary observation requests in full, plus all real
shadow work. It includes deterministic compilation/validation and promotion wall time. These
local operations consume CPU and hosting resources; zero model calls does not mean zero total
economic cost. The measured process CPU is 1,860,951 user and 281,740 system microseconds across
the main experiment, excluding the separate Codex child process. Peak harness RSS is 236,384 KiB.
Wall time includes waiting for that provider process.

- **9 reuses** recover measured one-time inference-equivalent expense:
  `ceil($0.138752 / $0.01661207)`.
- **6 reuses** recover measured workflow setup wall time:
  `ceil(35,383.36 / 6,762.86)`.
- **4 reuses** recover incremental inference-equivalent expense if the two normal observations
  were useful application work that would have occurred anyway:
  `ceil($0.060665 / $0.01661207)`.
- **Actual total monetary break-even is unknown.** It requires real marginal provider billing,
  control-plane/connector costs, engineering and approval cost. Revalidation frequency also
  changes amortization. The counts above apply to reuse of this same validated artifact, not to
  broad production economics.

The main experiment took 268.868 seconds and used 39 native requests / 78 reported completed
inference responses: two observations, three shadows, three warmups, 30 measured baselines and
one real quarantine fallback check. Its inference-equivalent spending was **$0.712263**.
Three development/diagnostic requests add **$0.086252**, making **$0.798515** across all live work
in this session. Test fixtures and deterministic optimized requests incur no provider inference.
Actual subscription charges and unpriced system costs remain unknown throughout.

## Correctness, authorization and fallback

All 30 pairs match each other and the existing oracle on the complete normalized resource
identities and values: customer eligibility, every order and its lateness, every refund and its
amount, tenant and snapshot. Held-out C-303 contributes ten passing pairs. Aggregate counts alone
are not accepted as equivalence. Source evidence, independent validation and three real shadows
also pass before live execution.

Six denial checks pass without any adapter or model invocation: compiled missing scope,
record denial, tenant mismatch and principal mismatch, plus native missing scope and record
denial. Strict empty tool arguments reject injected customer IDs and unknown/write functions.
Existing Ed25519 signatures, identity-bound offers, guard checks, adapter schemas and snapshot
validation remain in use. No financial operation or generated code was executed by the experiment.

Quarantining the deployed capability removes its offer. A fresh live request falls back to the real
agent, returns the exact oracle context, and incurs the normal **2 calls / 8,513 tokens** and
8,621.54 ms request latency. That spending is included in experiment totals, not concealed inside
the compiled-path average. Deliberate observe-mode execution is not counted as unexpected fallback.

## Limits on provider accounting

Usage is parsed from additive provider-reported completed-response updates and reconciled with
cumulative input/output/cache totals. Initial and duplicate notifications do not create calls.
Missing usage never becomes a character-count estimate. An incomplete provider stream marks
aggregate inference work/cost unknown rather than reporting zero consumption.

The CLI exported no usable OTEL transport counters in this run. Therefore **2 calls/request means
two reported completed inference responses**, not an audited count of every HTTP/WebSocket
attempt or hidden retry. All observed turns completed, and no model reroutes occurred. Hidden
failed requests without usage are not measurable here. This is a limitation on a stronger claim
about total provider attempts and billing.

The main run emitted 78 warnings. A follow-up diagnostic identified two recurring warning types:
an ignored `features.apply_patch` flag and deliberate omission of unrelated skills from the model
catalog. Their exact distribution over the original run was not retained. The final harness removes
the ignored flag; the read-only sandbox was enforced during the measured run. The original
measurements are retained unchanged. Suppressing reasoning and using ephemeral threads avoids
retaining private chain-of-thought; only normalized usage and observable synthetic context persist.

Codex retains provider/runtime context even with short application instructions and a reduced
skill catalog. This baseline is an efficient two-response Codex-backed agent, not a measurement
of the smallest possible direct Responses API payload. Absolute token and cost figures must not
be generalized to such an API client. The experimental dynamic-tool protocol may change.

## Explicit answers to the commercial thesis

1. **Did Foundry reduce tokens?** Yes, in this controlled live-provider workflow.
2. **By how much?** 8,533.67 reported tokens/request on average, a 100% steady-state reduction.
3. **Did it reduce model calls?** Yes, completed inference responses.
4. **By how much?** 2 to 0 per request, 100%; hidden transport retries were not audited.
5. **Did it reduce latency?** Yes, with the complete SDK path timed.
6. **By how much?** 6,762.86 ms/request, 99.9114%; average 6,768.86 to 5.99 ms.
7. **Did it reduce monetary inference cost?** The API-equivalent estimate did. Actual billed
   monetary savings have not been demonstrated on this subscription account.
8. **By how much?** Estimated $0.01661207/request, 100%. Actual billed savings are unknown.
9. **Was correctness preserved?** Yes for the tested domain: 30/30 full matches, including ten
   held-out cases, plus 21 validation checks and three real native-authoritative shadows.
10. **Were authorization/security semantics preserved?** Yes for the tested read semantics:
    six zero-execution denials, typed read-only adapters, identity guards and signed routing.
11. **How many executions amortize overhead?** 9 for conservative measured inference-equivalent
    setup; 6 for measured setup wall time; 4 for incremental inference-equivalent setup. Total
    economic break-even is unknown until unpriced costs and real billing are available.
12. **When is optimization worthwhile?** Repeated deterministic tool orchestration with stable
    schemas, authorization and coherent snapshots, enough reuse before revalidation, a high
    eligible-hit rate, and substantial existing inference overhead. The result supports this
    narrow workload class. It does not establish profit for all agents.
13. **When is it not worthwhile?** Rare tasks, frequent data-contract/policy changes, low reuse,
    high fallback/revalidation expense, work requiring new semantic reasoning on each request,
    or workflows already implemented deterministically. Very small/cheap agents and workloads
    dominated by unavoidable connector latency can have little net economic benefit. A fixed
    subscription can reduce inference usage without reducing the user's bill.

## Implementation scope and validation

Only two existing production files changed, additively:

- `src/exploration/observe.ts`: accepts normalized completed streaming responses with monotonic
  timestamps, strict usage validation and existing measurement/privacy conventions.
- `src/integration/client.ts`: optional provider/model metadata passed to the observer. Existing
  callers retain the original defaults and behavior.

Isolated experiment files:

- `scripts/experiments/customer-agent.ts`: authenticated Codex app-server bridge, three typed
  read functions, fresh ephemeral threads, strict final JSON, provider usage ledger and failure
  handling. It reuses the existing launcher and leaves the coding-agent adapter intact.
- `scripts/experiments/metrics.ts`: temporary loopback receiver for allowlisted numeric transport
  counters; no logs/traces/content retained. Counter availability remains explicitly unknown.
- `scripts/experiments/statistics.ts`: averages, unknown propagation, savings and break-even math.
- `scripts/benchmark-real-agent.ts`: gated setup, repeated pairs, full oracle comparison,
  authorization checks, quarantine fallback and complete measurement report.
- `tests/integration/real-agent-experiment.test.ts`: nine tests covering usage reconciliation,
  duplicates, malformed/incomplete usage, identity/privacy, tool allowlists, denied reads,
  cache pricing, unknown propagation, break-even and cumulative counter deduplication.
- `package.json`: opt-in `benchmark:real-agent` command, no new dependency.
- This report, `docs/real-agent-benchmark.json`, `docs/real-agent-preflights.json`, and small
  documentation links in the existing implementation report/README.

Validation: the original 107-test suite passed before changes. The final suite has 116 passing
tests across 24 files. Type checking, lint/format, existing evaluation, web build, SDK build and
both Playwright workflows pass on Node 24. No compiler, matcher, registry, interpreter, capability
family or production provider architecture was expanded. No production service was deployed.

Before production claims: repeat on the actual customer agent with metered billing and real
read connectors; audit transport retries and incomplete usage; measure hosting/connector and
revalidation costs; harden the experimental provider bridge; expand held-out _customer-context_
coverage to realistic sizes and failure conditions; measure eligible-hit/fallback rates under
the real workload. These are follow-up validations, not architecture changes implemented here.
