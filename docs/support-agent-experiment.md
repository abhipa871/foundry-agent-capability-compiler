# Live support-agent experiment

On October 5, 2026, we tested a complete support task that still needs an LLM: investigate a
late-order complaint, inspect account eligibility and refund history, recommend the appropriate
next step, and draft a customer-facing reply. Every arm used live OpenAI inference. Business
records were synthetic, unchanged fixtures.

Across 18 matched trials, exposing Foundry's existing compiled context loader as an agent tool
saved **2.15% of total tokens**, with **no model-call reduction**. Loading that same context before
starting the agent saved **49.78% of total tokens** and **one of two model calls**. All 54 measured
outputs passed the factual, policy-decision and objective reply-grounding checks. This supports
prefetching known, reusable context; it does not establish large savings from a tool replacement
alone or savings for arbitrary agents.

The earlier [context-only experiment](real-agent-experiment.md) removed all inference because
retrieving context was the entire task. Here, the model remains responsible for the recommendation
and reply. The earlier 100% figure therefore does not apply to this complete agent task.

## Evidence and reproduction

- [Raw results](support-agent-benchmark.json) retain every measured request, warmup, normalized
  provider usage event, synthetic evidence, public reply, setup ledger and fallback result.
- Run `npm run benchmark:support-agent` using Node 24 and an authenticated Codex CLI on PATH.
  The retained run used Node v24.21.0, Codex CLI 0.160.0, darwin/arm64, ChatGPT authentication and
  model `gpt-5.5`. Support tasks used low reasoning effort in all three arms.
- The default is 18 trials. `FOUNDRY_SUPPORT_TRIALS` accepts multiples of nine from 9 through 90.
  This is an opt-in live benchmark; normal tests and CI do not spend provider inference.
- A correctness, usage, routing or provider failure stops the run and writes an incomplete report.
  The retained run completed without failed requests or model reroutes.

## Task and controlled comparison

The three authorized typed reads are customer lookup, all orders and complete refund history.
The application binds the customer ID; the model cannot substitute a different record or obtain
extra scopes. The baseline may choose the tools and issue independent reads together. We did not
force duplicates, serial reads, extra reasoning or extra model turns.

The sandbox support policy selects the most delayed order, then recommends delivery support for
an ineligible account, human review when a prior refund exists, refund review for an eligible
account with no prior refund and a delay of at least seven days, or delivery support otherwise.
These are recommendations only. Nothing issues refunds, updates orders or contacts customers.

| Arm               | What happens                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline          | The agent chooses among three existing read tools, then assesses the records and writes a reply.                                                                      |
| Compiled tool     | The same agent can choose one `load_customer_context` tool, which invokes the existing Foundry SDK; the agent then assesses the records and writes a reply.           |
| Compiled prefetch | The application knows account context is required and invokes the same SDK before starting the model; the model receives the context, assesses it and writes a reply. |

Only customer-context retrieval is compiled. There is no compiled support-policy evaluator,
decision capability or reply generator. Prefetch is an application integration choice, rather
than a demonstrated ability to predict every arbitrary agent's future tool requirements.

Nine cases combine three customer IDs with three complaints: a refund request, frustration about
a delay, and a claim that a refund was already processed. The records contain different
eligibility, order-count and refund-history outcomes. Each case ran twice in every arm, after
nine warmups. Customer IDs were interleaved and arm order rotated across cases; repeated cases
retained their original arm positions, so cache/order effects were not fully counterbalanced.

All arms used fresh ephemeral threads, identical policy and output schema, the same model,
authorization and `fixtures-v1` snapshot, and the same underlying adapters with a 2 ms simulated
read delay. C-101 and C-202 supplied compilation observations. C-303 was held out from compilation
evidence, but participated in trusted shadow validation before measurement. It is not a completely
unseen deployment case.

## Steady-state measurements

Values are means per complete support request, with 18 requests per arm. Cached input is already
included in input tokens; it must not be added to the total a second time.

| Metric                         |  Baseline | Compiled tool | Absolute saving | Saving |
| ------------------------------ | --------: | ------------: | --------------: | -----: |
| Input tokens                   |  8,585.17 |      8,452.50 |          132.67 |  1.55% |
| Output tokens                  |    225.50 |        168.50 |           57.00 | 25.28% |
| Total tokens                   |  8,810.67 |      8,621.00 |          189.67 |  2.15% |
| Model calls                    |      2.00 |          2.00 |            0.00 |     0% |
| Underlying business tool reads |      3.00 |          3.00 |            0.00 |     0% |
| Complete latency               |   8.726 s |       7.759 s |         0.967 s | 11.08% |
| API-equivalent inference cost  | $0.021915 |     $0.018646 |       $0.003269 | 14.92% |
| Success rate                   |      100% |          100% |            0 pp |     0% |
| Fallback rate                  |        0% |            0% |            0 pp |    n/a |

| Metric                         |  Baseline | Compiled prefetch | Absolute saving | Saving |
| ------------------------------ | --------: | ----------------: | --------------: | -----: |
| Input tokens                   |  8,585.17 |          4,231.33 |        4,353.83 | 50.71% |
| Output tokens                  |    225.50 |            193.78 |           31.72 | 14.07% |
| Total tokens                   |  8,810.67 |          4,425.11 |        4,385.56 | 49.78% |
| Model calls                    |      2.00 |              1.00 |            1.00 |    50% |
| Underlying business tool reads |      3.00 |              3.00 |            0.00 |     0% |
| Complete latency               |   8.726 s |           6.742 s |         1.984 s | 22.73% |
| API-equivalent inference cost  | $0.021915 |         $0.013530 |       $0.008385 | 38.26% |
| Success rate                   |      100% |              100% |            0 pp |     0% |
| Fallback rate                  |        0% |                0% |            0 pp |    n/a |

The baseline made three model-visible tool calls, the compiled-tool arm one, and prefetch zero.
Every arm still performed three actual business reads. Reducing model-visible tools does not
mean fewer database or external API reads. All 36 measured compiled context invocations reported
zero model calls and zero tokens; their enclosing support agents still used inference.

The compiled-tool arm's smaller tool-call response and tool descriptions saved some input/output
tokens, but it still needed a model response to select the tool and a second to answer. Prefetch
removed the selection response and its model context entirely. This explains the much larger
token saving. Both optimized arms used fewer total tokens in all 18 paired trials.

## Latency, cache and optimization overhead

Complete request latency includes the SDK offer request, signature and authorization guards,
compiled reads, model work and provider-thread cleanup. No outliers were removed. The SDK context
load averaged 9.61 ms in the compiled-tool arm and 6.86 ms in prefetch, including two loopback
optimization API requests. Baseline made no optimization API requests.

| Latency statistic | Baseline | Compiled tool | Compiled prefetch |
| ----------------- | -------: | ------------: | ----------------: |
| Median            |  8.367 s |       7.382 s |           6.300 s |
| p95               | 11.452 s |      19.989 s |          11.445 s |

Compiled-tool latency was lower in 15/18 pairs, but its worst request was substantially slower
and its p95 regressed. Its mean latency advantage is weak evidence in this small sample. Prefetch
was faster in 16/18 pairs; it was slower in two despite using fewer tokens and calls. The means
describe this run, rather than a production latency guarantee.

Mean cached input tokens were 6,172.44 baseline, 6,371.56 compiled tool and 2,986.67 prefetch.
Cache hits materially affected estimated cost. Compiled-tool cost was lower in 15/18 pairs and
prefetch cost in 16/18; some optimized requests cost more despite using fewer tokens. With
counterbalancing incomplete and only two repeats per case, the observed cost percentages need
confirmation under the application's actual cache and traffic conditions.

Costs apply [published GPT-5.5 standard rates](https://developers.openai.com/api/docs/models/gpt-5.5),
rechecked October 5: $5/million uncached input tokens, $0.50/million cached input and $30/million
output. Each request discounts its actual reported cached tokens before averaging. These are
**API-equivalent estimates, not measured ChatGPT charges**. Actual subscription billing,
transport retries and connector/hosting/engineering monetary costs are unknown. Local system
work is included in wall latency; no total business ROI claim is made.

## One-time setup, amortization and total spending

A fresh in-memory registry went through observation, the existing structural matcher/compiler,
21 artifact validation checks, three real-agent shadow matches, approval and signed live routing
before any optimized support request. A failed gate would have prevented measurement.

| Setup phase                         | Wall time | Completed model calls | API-equivalent cost |
| ----------------------------------- | --------: | --------------------: | ------------------: |
| Provider initialization             |   0.166 s |                     0 |                  $0 |
| Two real context observations       |  20.309 s |                     4 |           $0.061959 |
| Structural analysis and compilation |   0.007 s |                     0 |                  $0 |
| Artifact validation                 |   0.092 s |                     0 |                  $0 |
| Three trusted real-agent shadows    |  27.361 s |                     6 |           $0.076793 |
| Approval and routing                |   0.001 s |                     0 |                  $0 |
| Complete setup                      |  47.956 s |                    10 |           $0.138752 |

Setup consumed 42,669 reported tokens. Compilation itself used deterministic compiler code and
no model; observation and shadow validation incurred the inference work. Complete setup includes
application startup and key generation beyond the individually timed phases.

Using `ceil(one-time cost / positive per-request saving)` and charging the full setup to reuse:

| Amortization basis                |  Compiled tool | Compiled prefetch |
| --------------------------------- | -------------: | ----------------: |
| API-equivalent inference estimate |  43 executions |     17 executions |
| Complete setup wall time          |  50 executions |     25 executions |
| Reported token work               | 225 executions |     10 executions |
| Actual total economic break-even  |        Unknown |           Unknown |

These figures conservatively charge source observations that might also serve useful requests.
They exclude neither shadow inference nor fixture validation time, but do not price unknown
hosting, adapter, engineering or future revalidation work. They are conditional on the measured
steady-state savings remaining representative.

The complete experiment took **545.846 seconds**, with **70 native agent requests and 119
provider-reported completed inference responses**. API-equivalent spending was **$1.399035**:
$0.138752 setup, $0.257154 warmups, $0.973626 measured requests and $0.029503 fallback validation.
Warmups and fallback validation are retained in total spending, separate from per-request means
and reusable capability setup. No preflight run or failed request was discarded in this experiment.

## Correctness, authorization and fallback

All 18 matched trials agreed on complete structured evidence and the recommended action. The
oracle is hand-stated independently of the agent, compiler and adapter policy logic. Complete
customer/order/refund context was separately compared with the existing context oracle on every
request. The six C-303 trials, comprising 18 outputs, passed alongside the source-customer cases.

All 54 public replies passed objective checks for the selected order, observed delay, a next
step and prohibited completed/guaranteed financial-action claims. They contained 58–80 words.
Reply wording was allowed to differ. These checks establish the tested factual/policy behavior,
not universal writing quality, every possible hallucination, or human-rated service quality.

Missing refund-read scope and disallowed-customer tests both denied access before any model call
or adapter read. Existing tenant isolation, signed-artifact, drift and runtime guard regression
tests remain passing. This live experiment did not exercise every possible production security
failure.

After quarantine, the compiled-tool path correctly fell back to the real context agent and
completed the support task. The fallback request used **4 model calls, 17,118 tokens, 10.515 s
and $0.029503 API-equivalent cost**. It includes both context-agent and support-agent inference.
Fallback preserves the tested behavior but can cost more than the direct baseline; it is not
treated as a zero-cost or successful optimized request.

No private chain-of-thought, credentials or real customer data are retained. Tools have strict
empty argument schemas and application-bound authorized IDs. Shell, web, app/plugin/MCP and
arbitrary code tools are disabled; unexpected built-in activity fails the harness. Read-only
sandboxing, ephemeral threads, normalized usage events and temporary-file cleanup remain in use.

## Implementation and validation

Changes are isolated to the experiment and documentation; production compiler/runtime/SDK source
is unchanged:

- `scripts/experiments/customer-agent.ts`: reusable task runner over the existing provider bridge;
  the original context-agent interface remains intact. Adds bounded declared-tool execution,
  normalized tool timings and rejection of unexpected provider built-ins.
- `scripts/experiments/support-task.ts`: task cases, typed output, shared policy, independent
  evidence/decision oracle and reply-grounding rubric.
- `scripts/experiments/statistics.ts`: combines model and SDK/fallback measurements without
  hiding unknown usage or adding overlapping latency timers.
- `scripts/benchmark-support-agent.ts`: gated three-arm live experiment, complete accounting,
  authorization tests, quarantine fallback and retained results.
- `tests/integration/support-agent-experiment.test.ts`: seven tests for case coverage, evidence,
  policy actions, missing reads, grounding, financial-action claims and fallback accounting.
- `package.json`: opt-in command; no dependency was added.
- `README.md`, `docs/implementation-report.md`, this report and the raw JSON: discoverability
  and measured evidence.

Validation passed: **123 tests in 25 files**, TypeScript/format lint, SDK build, production build,
existing v1/v2 evals and **2 browser end-to-end tests**. An independent read-only audit of the JSON
reconciled all 54 requests with normalized provider events and pricing, checked paired full-context
equality, and reconciled the 119-response total ledger, artifact gates and fallback counts.

## What this establishes and what remains

Foundry reduced real provider-reported token usage on this complete task. A compiled tool alone
produced a small 2.15% saving and no reduction in model calls. When the application already knew
which context was required, prefetch removed a complete inference round, saving 49.78% of tokens
and 50% of model calls while preserving the tested evidence and policy decisions. Observed mean
latency and API-equivalent inference cost also fell, subject to the limits above.

Optimization is promising for frequent, authorized tasks with a stable deterministic read region,
known input and sufficient reuse to amortize validation. It is less attractive for one-off tasks,
rapidly changing guards/data/contracts, high fallback rates, context that cannot be chosen before
reasoning, or tasks whose remaining model work dominates retrieval. The small compiled-tool
saving makes these constraints especially important.

This experiment does not show that Foundry beats a hand-written deterministic context loader;
that comparator was not run. It demonstrates the inference savings from moving a known read
region outside an agent turn, using Foundry's existing compiler and safety gates. Absolute token
counts include Codex CLI/runtime context and should not be projected onto a minimal direct API
client. Cached tokens are provider token accounting, rather than an exact measure of GPU work.
The model alias is not an immutable model checkpoint, and audited transport retries are unavailable.

Before commercial or production conclusions, repeat with metered billing, fully counterbalanced
order, more diverse held-out customer-context records, actual read-only connectors, production
latency and error conditions, and broader reply-quality review. Include periodic revalidation and
fallback frequency in the amortization model. No new capability family or optimization architecture
is needed to make those measurements.
