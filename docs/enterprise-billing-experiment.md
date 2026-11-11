# Enterprise billing investigation — completed live evaluation

Completed on November 10, 2026. **All 70 planned measured attempts were executed**, including retained failures: baseline **33/35** passed; Foundry **32/35** passed. Sixteen previously unattempted tasks were completed without replacing any earlier failed attempt. This is a real **Gemini Developer API, gemini-3.8-flash** study over simulated billing services; it is not a fixture-only token benchmark.

**Finding:** read-plan compilation and its validation/deployment lifecycle worked. Across the 33 fully metered pairs, Foundry used **4.5% more tokens** and cost an estimated **0.9% more**. Normal-case benefits were offset by recovery overhead. Full-cohort token/cost savings are unavailable because two earlier failed provider requests have unknown usage. The optimized arm also has one fewer successful task. The study does not establish material cost reduction with preserved complete-task correctness.

## What the agent actually did

The exact externally supplied [task specification](billing-stress-test-request.md) was unchanged between arms: investigate customer CUST-1042's August–October 2026 billing dispute, gather evidence, classify charges, apply policy, issue authorized refunds, escalate exceptions, update support, and return an itemized resolution and audit trail.

The fixed snapshot contains **3 subscriptions, 12 invoices, and 18 payment records**. Independent expected outcomes were:

- Refund the later duplicate **$120** collection, PAY-013.
- Refund the **$80** add-on charged after cancellation, PAY-011.
- Preserve the legitimate **$200** charge, PAY-012, and other legitimate payments.
- Escalate the old **$60** dispute, PAY-001, without automatically refunding it.
- Persist exactly two authorized refunds totaling **$200**, with valid receipts, an itemized ticket, escalation, and audit records.

There are fifteen typed tools spanning customer/account lookup, subscriptions and plan changes, invoices/items, payments/details, contracts/refund policy, refunds/status, tickets, and audit entries. The agent was allowed to choose its calls; it was not forced to perform unnecessary work to inflate savings.

The simulated decision clock is November 1, 2026. Actual request timestamps are retained separately. No real billing account or payment provider was connected, and no real money moved.

## How Foundry changed execution

1. Two correct live baseline observations supplied source evidence.
2. The harness identified common exact read nodes, retaining declared provenance. The existing general SDK/compiler built a **20-node read plan**. It did not generate executable source code or compile the agent's financial reasoning.
3. The actual packaged SDK ran **16 passing verification checks** and **3 matching native-authoritative shadows**, then approved/deployed the verified digest into an isolated in-memory registry.
4. The optimized agent received the compiled read tool **alongside all original tools**. It could obtain many reads with one tool invocation. Gemini still interpreted the data, made decisions, and used guarded native tools for simulated writes.

The compiled portion invokes no model. The **complete agent task still invokes Gemini**. No prefetch or handwritten-prefetch arm was included in this supplied billing study.

Both arms used the same requested and provider-returned model identity, temperature 0, 16,384 response-output-token limit, 24-model-call limit, 100-tool-call limit, and 400,000-token per-task soft limit. Limits are checked when usage arrives, so a final response can exceed the soft token limit and is counted. Arm order alternated across repeats and conditions; matched tasks started from fresh identical financial state and authorization.

Training used seeds 9001 and 9002; the fixed evaluation used seeds 0–4 for each condition. Seeds vary fault jitter, not the financial facts. This is not held-out-customer generalization. No selection rule, expected outcome, or routing improvement was tuned on the measured cohort. Later operational changes added resumption/failure telemetry and the explicitly approved overall cap; the task and per-task settings remained fixed.

## Complete-cohort results: 35 attempts per arm

All failures and outliers are included. Savings below are baseline minus optimized; negative values mean regression.

| Metric                                        | Normal agent | Foundry | Absolute saving | Saving |
| --------------------------------------------- | -----------: | ------: | --------------: | -----: |
| Model calls, total                            |          570 |     567 |               3 |   0.5% |
| Executed model-facing tool invocations, total |        1,509 |     926 |             583 |  38.6% |
| Business API service attempts, total          |        1,518 |   1,521 |              -3 |  -0.2% |
| Complete-task mean latency, seconds           |        120.8 |   147.3 |           -26.5 | -22.0% |
| Complete-task median latency, seconds         |        122.9 |   119.4 |             3.5 |   2.9% |
| Complete-task p95 latency, seconds            |        154.9 |   162.2 |            -7.3 |  -4.7% |

- **Success:** 33/35 (94.3%) normal; 32/35 (91.4%) Foundry. Success requires both a completed agent response and all independent checks.
- **Fallback:** 0/35 normal; 15/35 Foundry, with 15 compiled fallback events. The deliberately balanced fault mix is not an estimate of production fallback frequency.
- **Full-cohort input/output/cached/total-token and cost means:** unavailable. One failed provider request in each arm has unknown usage; they are never assigned zero.
- **Known measured token lower bounds:** 9,024,801 normal and 9,713,178 Foundry. These are incomplete consumption totals, not a valid savings comparison.
- **Business attempt definition:** includes internal duplicate-delivery and denied security-probe invocations. Actual loopback HTTP attempts were 1,509 and 1,511 respectively. Internal injections must not be called additional network packets.

Latency includes provider time, tools, SDK execution/validation, and fallback. The earlier optimized provider timeout lasted about **1,044 seconds** and remains included. Host scheduling/suspension and provider behavior were not isolated; its cause is unproven. Descriptive medians/p95s from this small, interrupted local study are not evidence of production tail-latency improvements.

## Secondary token/cost comparison: 33 fully metered pairs

Two pairs are excluded **only from this secondary comparison**, because one arm has unknown usage: pagination repeat 2 and old-refund-denial repeat 2. Known-usage failures stay included. All 70 attempts remain in the primary completion/security/latency results. Missingness can bias this subset.

Values are means per attempted complete task, including failed tasks in this subset. Cached tokens are a subset of input; total = input + output; output includes reported thinking tokens. No private chain-of-thought is retained.

| Metric                            | Normal agent |   Foundry | Absolute saving | Saving |
| --------------------------------- | -----------: | --------: | --------------: | -----: |
| Input tokens                      |    252,088.8 | 264,201.3 |       -12,112.5 |  -4.8% |
| Cached input tokens               |    202,178.9 | 213,290.4 |       -11,111.5 |  -5.5% |
| Uncached input tokens             |     49,909.9 |  50,910.9 |        -1,001.0 |  -2.0% |
| Output tokens, including thinking |     14,783.4 |  14,625.2 |           158.2 |   1.1% |
| Total tokens                      |    266,872.2 | 278,826.5 |       -11,954.3 |  -4.5% |
| Estimated model/API cost, USD     |    $0.108033 | $0.109024 |      $-0.000991 |  -0.9% |

Descriptive 95% case-block bootstrap ranges for **per-task savings** in this subset: total tokens **-51,992.939 to 29,841.219**; model calls **-1.581 to 2.719**; estimated inference dollars **-0.009 to 0.007**. These resample seven fixed conditions, not a population of customers. They do not establish global optimality or a production guarantee.

Cost uses the retained [published rate card](experiments/billing-gemini-pricing-2026-11-07.json): $0.75/M uncached input, $3.75/M output including thinking, and $0.075/M cached input, under the documented introductory schedule. See [Google pricing](https://ai.google.dev/gemini-api/docs/pricing?authuser=0). The local card conservatively applies only below 200,000 input tokens **per model request**, not per whole agent task. These are API-equivalent estimates, not account billing. Cache usage is provider-reported and was not controlled; dollar changes cannot be attributed entirely to compilation.

## Wins and losses by condition

Each condition has five matched repeats. Token/cost savings use only its fully metered pairs; success counts use all five. Negative savings are losses.

| Condition                       | Normal passes | Foundry passes | Metered pairs | Token saving | Cost saving |
| ------------------------------- | ------------: | -------------: | ------------: | -----------: | ----------: |
| Normal investigation            |           5/5 |            5/5 |             5 |        17.4% |       10.2% |
| Payment lookup returns HTTP 500 |           5/5 |            5/5 |             5 |        -1.7% |        5.0% |
| Four-record pagination          |           4/5 |            4/5 |             4 |       -17.9% |       -5.7% |
| Stale subscription / refresh    |           5/5 |            4/5 |             5 |       -23.9% |       -6.2% |
| Duplicate refund delivery       |           4/5 |            5/5 |             5 |        13.0% |       -2.6% |
| Old refund denied by policy     |           5/5 |            4/5 |             4 |        23.2% |       13.2% |
| Invoice read times out          |           5/5 |            5/5 |             5 |       -41.1% |      -19.7% |

The conditions are: normal completion; a retryable payment-detail HTTP 500; four-record pagination; a stale subscription requiring refresh; duplicate refund delivery with one idempotency key; an injected old-refund security probe that must be denied; and a retryable invoice-read timeout. The old-refund probe is a labeled internal service test, not an instruction for the model to make an unsafe refund.

## Why tool bundling did not eliminate inference work

The normal agent already batches several tools into one model turn. Replacing twenty tool invocations does not automatically remove twenty model calls. Foundry returns a sizeable bundle of raw API responses; the model still processes evidence, follows missing pages, decides on refunds, creates audits, updates the ticket and formats its final answer. The repeated full ticket/final-resolution data and growing conversation history also cost tokens.

A concrete losing pair is **timeout repeat 1**. Normal: **196,613 tokens, 14 model calls, 29 business attempts**. Foundry: **331,422 tokens, 21 model calls, 56 business attempts**. The compiled execution preserved seven completed reads in its checkpoint, but the same agent re-requested four with identical arguments and explored more records. No second context agent was invoked. Existing checkpoint preservation helped, but did not ensure efficient use of completed work.

Successful repeated-read argument counts were **26 normal versus 250 Foundry**. Some repeats are valid freshness checks; these counts do not independently prove every repeat is unnecessary. The compiled plan itself also retains two identical subscription reads from observations. Safe coalescing would require snapshot/freshness and output-equivalence checks.

## Correctness, authorization, and failures

Every run was assessed against independently specified financial outcomes and persisted service state, not against the baseline agent's answer. Checks cover exact refunds/receipts, legitimate-charge protection, no duplicates, escalation, complete list-page coverage, policy-before-refund, ticket itemization, and audit records. Free-text explanations were not exhaustively semantically judged.

- Policy preserved across all attempts: **true**.
- No duplicate persisted refund across all attempts: **true**.
- Legitimate $200 charge untouched across all attempts: **true**.
- Complete-task correctness was **not universally preserved**: 5 attempts failed, and the Foundry arm had fewer passes.

Failures were retained without rerunning or repairing their measured result:

- **Four-record pagination, optimized, repeat 1:** Model token budget exceeded. Failed checks: olderChargeEscalated, itemizedTicket, finalResolution, decisionAudit.
- **Four-record pagination, baseline, repeat 2:** Provider usage unknown; no further inference is authorized by this run. Failed checks: requiredContextRetrieved, policyReadBeforeRefund, exactlyTwoAuthorizedRefunds, refundTotal200, olderChargeEscalated, itemizedTicket, finalResolution, refundAudit, decisionAudit, stressExercised.
- **Stale subscription / refresh, optimized, repeat 5:** Model token budget exceeded. Failed checks: finalResolution.
- **Duplicate refund delivery, baseline, repeat 2:** Model produced no final answer. Failed checks: policyReadBeforeRefund, exactlyTwoAuthorizedRefunds, refundTotal200, olderChargeEscalated, itemizedTicket, finalResolution, refundAudit, decisionAudit, stressExercised.
- **Old refund denied by policy, optimized, repeat 2:** Provider usage unknown; no further inference is authorized by this run. Failed checks: finalResolution.

Security boundaries include strict typed arguments/results, tenant/principal/scopes and ownership, policy/amount/window limits, idempotency, signed offers, artifact digest/version checks, freshness/snapshot guards, bounded execution, and verification before promotion. An authorization denial stays denied. Compiled writes remain unsupported; financial mutations are native simulated APIs. Private credentials and thought parts/signatures are excluded from saved public exchanges. Sandbox security checks are not proof of real production connector security.

## Setup, revalidation, budget, and amortization

- Two live source baselines: **411,404 tokens**, **$0.188678** estimated inference cost and **208.8 seconds** combined task time. They were reused across resumes without new training inference and deduplicated by original run ID.
- Latest compilation/verification/shadow/approval/deployment: **209.3 ms**, with no compiler model calls. Across the five retained lifecycle launches in the resume chain: **1,021.6 ms**. These are local mock-service timings, not production setup estimates.
- Median complete compiled-tool span: **31.5 ms**, p95 **35.3 ms**. This includes reads and governance; isolated selector overhead was not separately measured. There was no learned mode selector or prefetch decision in this experiment.
- Earlier development outside the primary cohort/source baselines includes **259,412 reported tokens**, two schema-failure requests with unknown usage, and an interrupted unsaved training request with unknown usage. Failed requests, diagnostics, and preflight probes remain in the retained ledger; their unknown costs are not treated as free.
- User-approved overall study cap increased from 20M to **24M** solely to finish the fixed study. Final workspace accounting: **19,149,383 reported tokens**, plus **2,129,920 conservatively reserved tokens** for two unknown measured responses. A reserve is a budget safeguard, not a token measurement. Earlier development/standalone diagnostic costs are reported separately; this is not an exact lifetime bill.

**Reliable full-cohort break-even reuse count: unavailable.** Under the fully metered subset's observed workload mix and point estimate, there is **no finite break-even**: per-request inference cost increased even before charging setup. The uncertainty range crosses zero; this is not a claim about all workloads. The complete-cohort cost difference and historical failed setup costs are unknown. Do not advertise an amortization number by treating missing requests as zero. The general formula is one-time incremental cost divided by positive per-request saving, rounded up. Local CPU/memory, engineering, and production business-service charges were not monetized. Setup service-read counts were not separately exported; they are not claimed to be zero.

## Improvements suggested by the evidence — not implemented during evaluation

1. **Make read failure recovery cheaper.** For explicitly retryable read operations, test a bounded retry under the registered contract before handing control back to the model. Improve the handoff's typed coverage/remaining-work information so valid completed reads are reused. Keep denied authorization denied; never blindly replay writes.
2. **Return compact, complete evidence.** Preserve required facts and source references while removing repeated envelopes and redundant data. Use validated pure transformations for deterministic itemization/formatting so the model does not repeatedly regenerate the same resolution for ticket and final response. Preserve the external output contract and independent oracle.
3. **Make the plan more selective.** Coalesce identical reads only when freshness/snapshot semantics permit, track pagination completeness explicitly, and use declared value references rather than guessing IDs. The current plan is specialized to observed resource IDs and bounded DAGs; unseen customers, changing counts, and general loops are not supported by this evidence.
4. **Route based on measured expected benefit.** Stable, repeatable, known-context workloads are better candidates than unstable partial plans. Evaluate original tools versus compiled tools using trusted task metadata, coverage and adapter health, with savings/quality gates. Prefetch requires a trusted context contract and was not evaluated here. Do not hardcode benchmark names, customer IDs or expected answers into a selector.

The immediate priority is **fallback/read reuse and context size**, before a broad compiler rewrite. Compilation is worthwhile when repeated retrieval decisions dominate and the plan covers the needed context reliably. It is less useful when the baseline already batches well, reasoning/response construction dominate, many branches are unsupported, data is frequently stale, or recovery duplicates work. Low reuse also makes training/governance harder to amortize.

## Verification, implementation, and reproduction

Validation: **258 tests across 39 files**, **10 browser tests**, existing evaluation gates, SDK build, production build, TypeScript and formatting checks. The [completion audit](experiments/billing-validation.json) independently checked unique pair coverage and token means, reproduced the analysis using only compressed archives, verified all nine archives, and found no configured Gemini key in the scanned changed artifacts or browser bundles. The private key file remains untracked with mode 0600. The separate [fixture export](experiments/billing-fixture-validation.json) passed **70/70** scripted tasks with no LLM; it proves service/SDK correctness under the fixture driver, not Gemini token savings. New coverage includes policy/idempotency/failure behavior, real loopback HTTP and built-SDK lifecycle, evidence/budget restoration, provider schema/privacy/diagnostics, cost handling, and UI gates.

Implementation files:

- Data, authorized services, oracle: `src/benchmarks/billing-fixtures.ts`, `billing-http.ts`.
- Real SDK harness and metrics: `src/benchmarks/billing-workspace.ts`, `billing-statistics.ts`.
- Live driver and offline analysis: `scripts/benchmark-billing.ts`, `scripts/summarize-billing.ts`.
- Gemini transport/diagnostics: `src/agent/providers.ts`, `gemini-diagnostics.ts`, `scripts/diagnose-gemini.ts`.
- Local API/UI: `src/app.ts`, `src/web/BillingBenchmarkPanel.tsx`, `BenchmarkWorkspace.tsx`, `benchmark.css`.
- Tests: `tests/integration/billing-benchmark.test.ts`, `tests/unit/gemini-diagnostics.test.ts`, `model-providers.test.ts`, `e2e/benchmark-workspace.spec.ts`.
- Configuration/documentation: `package.json`, `.env.example`, `.gitignore`, `.prettierignore`, README, general SDK documentation, this report and retained evidence. The private environment file is ignored and was not committed or overwritten.

Initial credential rejection was resolved after the user replaced the key. Gemini Developer API uses the official origin and `x-goog-api-key`; standalone discovery and inference succeeded. Development transport fixes used `parametersJsonSchema` and simplified only Zod's exact unconstrained JSON recursion; domain constraints remain. The response budget/parser fixes preceded the fixed cohort and applied equally to both arms. Raw historical failures are retained.

Primary evidence: [completed raw study](experiments/billing-gemini-1794340360793.json.gz), [reproducible analysis](experiments/billing-analysis.json), [original request](billing-stress-test-request.md). The offline summary includes a source SHA-256, per-pair differences, descriptive uncertainty, fallback task costs, and deduplicated development/preflight records. Raw timestamped provider evidence is excluded from formatting so its original bytes remain intact.

Nine lossless gzip archives retain every timestamped attempt, with original and compressed hashes
in the [archive manifest](experiments/billing-evidence-archives.json). The original JSON files remain
locally and are Git-ignored because the final raw file exceeds GitHub's single-file limit. The
analysis command reads archives directly, including historical references whose original JSON
files are absent. Extract an archive with `gzip -dk FILE.json.gz` if an uncompressed file is needed.

Reproduce analysis without spending API tokens:

```sh
npx tsx scripts/summarize-billing.ts docs/experiments/billing-gemini-1794340360793.json.gz docs/experiments/billing-analysis.json
```

For a new live study, build the SDK and run `npm run diagnose:gemini -- --infer` before the explicitly authorized CLI. Do not rerun this cohort's losing cases to overwrite results. The interactive Agent playground uses the same service and SDK lifecycle, but has its own in-memory session; it does not automatically hydrate the CLI cohort file.

Before production claims: evaluate independent customers/data shapes and realistic fault frequencies, isolate cache/host effects, meter real connector and infrastructure costs, strengthen prose grounding checks, and retest proposed improvements on a separate held-out set. Real financial writes require a production effect/receipt/reconciliation design beyond this read-only compiler experiment.
