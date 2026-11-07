# Support-agent execution placement and fallback evaluation

**Status: plan v2.1 is complete.** Development (72 measured requests) and the held-out set (144
measured requests, run once on frozen code `2db497e`) both finished with reported usage for every
provider request. All 216 measured answers passed their hand-stated oracles, every authorization
denial stopped before inference and reads, and no request read an unpermitted resource. Figures
are API-equivalent estimates on a synthetic, fault-heavy workload, not provider billing. Nothing
was deployed and no SDK or routing default changed.

## Summary

- **Placement produces the gain.** When the application's contract says the task needs the
  complete customer/order/refund context and the compiled artifact is healthy, the selector
  prefetches it. On held-out complete-context and slow-read cases that took 4,528 tokens and one
  model call per request, against 9,086 tokens and two calls with normal tools. Handwritten
  prefetch did the same (4,518 tokens, one call).
- **Direct fallback beats native fallback.** Returning a compiled miss to the original agent,
  instead of running a separate context agent, saved 1,819 tokens per request (20.5%, 95% case-block
  bootstrap interval 342–3,364) and 0.45 model calls, removed every duplicate read and was 2.0
  seconds faster on average. Its estimated cost saving (6.7%) has an interval that includes zero.
- **Foundry selection with direct fallback versus normal tools:** 1,587 fewer tokens per request
  (18.4%, interval 350–2,837), 0.36 fewer model calls and 13.0% lower estimated cost on held-out,
  but development showed no cost saving (−1.4%). Latency differences were not distinguishable.
- **Handwritten prefetch is still better.** It used 42.5% fewer tokens and 45.7% lower estimated
  cost than Foundry selection with direct fallback. Foundry never beat it on tokens or model calls.
- **Case A (Foundry software as a tool):** the agent called the compiled loader every time it was
  offered (6 of 6 held-out requests) and answered correctly, with no saving: two model calls and
  about 9,120 tokens, the same as normal tools.
- **Case B (supplementing a partial software result):** the current capability cannot return a
  valid partial result, so this used a labeled fixture. The agent used it in 1 of 6 held-out offers;
  when it did, it fetched only the missing refund history and answered correctly. It saved no work.
- **Held-out supports development** on the direction and size of the token and model-call effects.
  Estimated cost effects moved between phases because provider cache hits vary.

## What changed in this round and why

Inspection found that contract-based selection (`c59546d`) and direct fallback (`1fe6b15`) were
already implemented and found no source defect, so **no `src/` file changed**. The compiler was
not rewritten. Work was confined to the evaluation harness, tests and documentation:

| Commit    | Change                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `1d36a09` | Plan v2: twelve cases including case types A and B, an evidence-grounding check, per-call ledgers, prior-evidence accounting.        |
| `51fb448` | Direct handoff now states each failed read's remaining retry budget; ledger response attribution fix.                                |
| `8297fab` | The "unavailable" instruction names every field that must be null; the oracle is unchanged.                                          |
| `8d145df` | Retained the first v2.1 development attempt, stopped by a provider timeout during warmup.                                            |
| `2db497e` | The single user-authorized retry writes a new evidence filename; no case, prompt, selection or fallback change. Frozen for held-out. |

The first complete v2 development run (source `1d36a09`) exposed the two defects fixed in `51fb448`
and `8297fab`. Direct handoff told the agent a refund read had failed once but not that one retry
remained, so the agent answered "unavailable" without its permitted retry; in the transient-failure
case every other arm recovered. Separately, three arms read the ambiguous unavailable instruction
as "keep verified fields". Both fixes apply to every arm. Between v2 and v2.1 development,
correctness rose from 90.9% to 100% for normal and handwritten and from 81.8% to 100% for
selector/direct. Selector/direct used about 840 more tokens per request (6,189 to 7,030) because
it now performs the retry instead of giving up; that is a correctness fix, not a cost gain.

## Design

**Arms.** Normal original tools; compiled loader offered as a tool (the original application
placement); compiled prefetch; handwritten prefetch; Foundry-selected placement with native
context-agent fallback; Foundry-selected placement with direct handoff to the original agent and
request-local read reuse. The handwritten arm uses the same authorized adapters, schemas, output
contract, snapshot and model settings. Its orchestration is an application-written parallel read of
the contract's resources with one bounded retry per read. It has no trace observation,
compilation, artifact verification, trusted shadow, approval, signed offer, registry health,
telemetry or revalidation. It also preloads partial context, which the compiled family cannot
represent, and it is unaffected by quarantine or artifact compatibility because it has no artifact.

**Selection policy (unchanged, `src/integration/selection.ts`).** Prefetch only when a
code-registered contract establishes complete required context; offer the compiled tool next to
original tools when the agent decides; use normal execution when the compiled family is
inapplicable (partial or no context); denial is terminal. Each request records mode, reason and
selector time. There are no customer IDs, case names, answers or text heuristics in the selector.

**Cases.** Each split has twelve categories: complete, partial, absent and agent-decided context;
denied access; quarantine; incompatible freshness; a 120 ms slow read; transient and permanent
refund-read failure; case A, `software_tool`; and case B, `software_supplement`. Development and
held-out use distinct customers and messages. Expected answers, required reads and permitted
reads are hand-stated in `scripts/experiments/routing-task.ts` and never shown to the agent. A
non-null evidence field fails unless that resource was read successfully in the same request, so
a guessed or partial answer cannot pass. Missing refund evidence must produce "unavailable" with
every evidence field null.

**Counts and order.** Development ran 12 cases × 6 arms × 1 repeat = 72 measured requests;
held-out ran 12 × 6 × 2 = 144. Each phase also ran 2 observation, 3 initial-shadow and 3
revalidation-shadow context requests and 6 warmups, plus nested native fallbacks. That made 92
provider agent requests in development and 170 in held-out, exactly the planned maxima. Arm order
used seeded rotations (development 41107, held-out 71109). Development was used for the two fixes;
the held-out set was run once afterwards and not used for any change.

**Pricing basis.** GPT-5.5 standard rates ($5 per million input tokens, $0.50 per million cached
input tokens, $30 per million output tokens; official model page checked 2026-10-07), applied to
provider-reported usage through ChatGPT-authenticated Codex `0.158.0-alpha.2.1`. These are
API-equivalent estimates, not what the ChatGPT account was billed.

## Held-out results

Steady state covers the eleven categories that exercise Foundry's live capability (22 requests per
arm, including the two zero-inference denials). Case B uses fixture software and is reported
separately. Latency is complete request time; p95 over 22 requests is descriptive only.

| Per request                |  Normal | Compiled tool | Compiled prefetch | Handwritten | Selector/native | Selector/direct |
| -------------------------- | ------: | ------------: | ----------------: | ----------: | --------------: | --------------: |
| Input tokens               |   8,443 |        11,015 |             8,643 |       4,784 |           8,654 |           6,869 |
| Cached input tokens        |   6,516 |         8,634 |             7,168 |       3,910 |           7,168 |           5,213 |
| Output tokens              |     189 |           217 |               215 |         159 |             210 |             176 |
| Total tokens               |   8,633 |        11,231 |             8,858 |       4,943 |           8,864 |           7,045 |
| Model calls                |    1.91 |          2.55 |              2.00 |        1.09 |            2.00 |            1.55 |
| Business reads             |    2.27 |          2.64 |              2.64 |        2.27 |            2.64 |            2.27 |
| Duplicate successful reads |    0.00 |          0.36 |              0.36 |        0.00 |            0.36 |            0.00 |
| Unnecessary reads          |       0 |             0 |                 0 |           0 |               0 |               0 |
| Mean latency (s)           |    4.93 |          7.09 |              6.18 |        4.30 |            6.54 |            4.53 |
| Median latency (s)         |    5.15 |          5.95 |              6.22 |        3.99 |            4.58 |            4.42 |
| p95 latency (s)            |    7.85 |         12.78 |             10.28 |        6.12 |           11.05 |            6.81 |
| API-equivalent cost        | $0.0186 |       $0.0227 |           $0.0174 |     $0.0111 |         $0.0173 |         $0.0162 |
| Correct (oracle)           |    100% |          100% |              100% |        100% |            100% |            100% |
| Fallback rate              |      0% |         36.4% |             36.4% |          0% |           36.4% |           36.4% |
| Selector time (ms)         |       — |             — |                 — |           — |          0.0076 |          0.0058 |

Paired differences use the same case and repeat; positive values mean less work. Intervals are
95% case-block bootstrap intervals over eleven case blocks.

| Comparison (baseline → candidate)            | Tokens saved                   | Model calls saved             | Cost saved                           | Latency saved                   |
| -------------------------------------------- | ------------------------------ | ----------------------------- | ------------------------------------ | ------------------------------- |
| Compiled tool → selector/native (placement)  | 2,367 (21.1%) [1,171, 3,578]   | 0.55 (21.4%) [0.27, 0.82]     | $0.0054 (23.8%) [0.0032, 0.0073]     | 0.55 s (7.8%) [−1.08, 1.99]     |
| Selector/native → selector/direct (fallback) | 1,819 (20.5%) [342, 3,364]     | 0.45 (22.7%) [0.09, 0.82]     | $0.0012 (6.7%) [−0.0008, 0.0041]     | 2.01 s (30.8%) [0.21, 4.29]     |
| Normal → selector/direct                     | 1,587 (18.4%) [350, 2,837]     | 0.36 (19.0%) [0.09, 0.64]     | $0.0024 (13.0%) [0.0001, 0.0048]     | 0.41 s (8.2%) [−0.28, 1.05]     |
| Handwritten → selector/direct                | −2,102 (−42.5%) [−3,377, −845] | −0.45 (−41.7%) [−0.73, −0.18] | −$0.0051 (−45.7%) [−0.0089, −0.0018] | −0.23 s (−5.3%) [−1.09, 0.85]   |
| Normal → compiled tool                       | −2,599 (−30.1%) [−4,889, −675] | −0.64 (−33.3%) [−1.18, −0.18] | −$0.0041 (−22.3%) [−0.0081, −0.0009] | −2.16 s (−43.8%) [−3.77, −0.86] |
| Normal → compiled prefetch                   | −225 (−2.6%) [−1,790, 1,374]   | −0.09 (−4.8%) [−0.45, 0.27]   | $0.0012 (6.3%) [−0.0016, 0.0039]     | −1.25 s (−25.4%) [−2.14, −0.41] |
| Normal → handwritten                         | 3,690 (42.7%) [2,015, 5,731]   | 0.82 (42.9%) [0.36, 1.27]     | $0.0075 (40.3%) [0.0038, 0.0114]     | 0.63 s (12.8%) [−0.46, 1.64]    |

Grouping by workload shows where each effect comes from (held-out means per request):

| Workload (requests per arm)                                  | Normal          | Compiled prefetch | Handwritten  | Selector/native | Selector/direct |
| ------------------------------------------------------------ | --------------- | ----------------- | ------------ | --------------- | --------------- |
| Healthy complete context: complete and slow cases (4)        | 9,086 tok / 2.0 | 4,536 / 1.0       | 4,518 / 1.0  | 4,528 / 1.0     | 4,533 / 1.0     |
| Compiled not applicable: partial, none, agent-decided (6)    | 7,391 / 1.67    | 7,400 / 1.67      | 5,953 / 1.33 | 7,413 / 1.67    | 7,452 / 1.67    |
| Fallback: quarantine, incompatible, transient, permanent (8) | 11,376 / 2.50   | 14,263 / 3.25     | 4,593 / 1.00 | 14,273 / 3.25   | 9,236 / 2.00    |
| Fallback mean latency                                        | 6.26 s          | 8.51 s            | 4.13 s       | 11.11 s         | 5.12 s          |
| Fallback estimated cost                                      | $0.0244         | $0.0269           | $0.0113      | $0.0273         | $0.0232         |

## Sources of the gains

- **Removing a retrieval turn.** With complete required context known in advance, prefetch (by
  the selector, manual placement or handwritten code) replaces the model's tool-selection turn,
  halving tokens and model calls. Compilation itself does not reduce reads: the compiled loader
  performs the same three reads, in parallel, in 13–15 ms with in-process fixture adapters.
- **Not paying for a context agent on misses.** Native fallback runs a separate context agent
  (one or two extra model responses) and re-reads customer and orders that the compiled attempt
  already read, averaging one duplicate successful read per fallback request. Direct fallback
  passes the valid completed reads to the original agent, which retries only the failed read
  within the shared two-attempt budget.
- **Choosing placement per task.** The original placement offered the compiled tool whenever
  complete context was required, even when the application already knew it was needed; that was
  30.1% worse than normal tools, mostly through native fallback. Selector placement prefetches
  known complete context instead and chose normal execution for partial, absent and agent-decided
  context, adding no measurable work there.

## Losing cases and regressions

- **Against handwritten prefetch, Foundry loses or ties everywhere.** Ties on healthy complete
  context; loses on partial context (handwritten preloads partial context, Foundry cannot) and on
  every fallback case (handwritten has no quarantine or compatibility gate and retries reads in
  application code, finishing in one model call).
- **Compiled prefetch versus normal tools** shows no overall token saving on this mix (−2.6%,
  interval includes zero) and 25.4% worse mean latency. It saves a call when the artifact is
  healthy but adds one on each fallback request, and four of eleven categories are fallbacks.
- **Selector/direct versus normal tools on partial, absent and agent-decided context** is a
  slight loss (7,452 versus 7,391 tokens in that group), within run-to-run variation.
- **Native fallback latency regressed:** selector/native fallback requests averaged 11.11 seconds
  against 6.26 for normal tools; p95 for compiled tool and selector/native exceeds normal.
- **Case B offered-but-unused software:** in the five held-out requests where the agent ignored
  the fixture and used its original tools, the extra tool schema cost about 180 tokens (about 2%).
- **Development estimated cost:** selector/direct cost 1.4% more than normal in development, while
  saving 13.0% on held-out, so no stable cost saving against normal tools is established.

Denials ended with zero model calls and zero reads in every arm, so they add no work to any
comparison and are not counted as improvements. Permanent-failure requests are included with their
full cost; a correct "unavailable" answer is scored as correct, not as task success.

## Partial-result tasks

**Case A (`software_tool`).** The selector offered the unchanged compiled `load_customer_context`
alongside the original tools because the contract leaves retrieval to the agent. The agent called
it once in all six held-out offers (three in development), issued no follow-up calls, made no
redundant or duplicate reads, and answered correctly: two model responses and about 9,120 tokens,
the same as normal tools (9,111). Replacing three tool calls with one did not remove a model turn.

**Case B (`software_supplement`).** The task needs eligibility, orders and refund history. The
compiled family's only output is the full `context.v1`; a missing read deoptimizes rather than
returning a valid partial result. Changing the capability was out of scope, so these rows use a
labeled test fixture (`load_order_summary`, eligibility and orders only) that goes through the same
authorized observer, adapters, snapshot and a 30-second freshness check. **This is fixture
behavior with live agent inference, not live Foundry capability evidence.** It is excluded from
the steady-state tables above.

| Phase       | Offers | Used fixture | Responses when used                | Follow-up reads when used        | Correct |
| ----------- | -----: | -----------: | ---------------------------------- | -------------------------------- | ------: |
| Development |      3 |            2 | 3 (sequential) and 2 (in parallel) | One `lookup_refund_history` each |  3 of 3 |
| Held-out    |      6 |            1 | 2 (in parallel)                    | One `lookup_refund_history`      |  6 of 6 |

When the agent used the fixture, it recognized that refunds were missing, made exactly one
necessary follow-up call, did not re-read eligibility or orders, and did not present the partial
result as complete. In the other offers it went straight to its three original tools. Using the
partial result saved no work: the best case matched normal tools (two responses), and the
sequential case added a response (13,880 versus about 9,100 tokens).

## Setup, shadow and revalidation (reported separately)

| Held-out phase                                   |  Wall time | Model responses |    Tokens |      Estimate |
| ------------------------------------------------ | ---------: | --------------: | --------: | ------------: |
| Two source observations                          |      8.5 s |               4 |    17,274 |     $0.047011 |
| Analysis, compilation, validation                |      0.1 s |               0 |         0 |  $0 inference |
| Three trusted shadows                            |     17.4 s |               6 |    25,910 |     $0.046307 |
| Complete setup                                   |     26.2 s |              10 |    43,184 |     $0.093318 |
| Revalidation with three renewed shadows          |     15.7 s |               6 |    25,910 |     $0.046307 |
| Six warmups                                      |   separate |               8 |    36,070 |     $0.078776 |
| 144 measured requests (156 agent requests)       | in latency |             268 | 1,201,622 |     $2.538755 |
| **Held-out total (170 agent requests, 885.8 s)** |            |         **292** |           | **$2.757156** |

Development retry: setup $0.125574 (22.5 s), revalidation $0.046307 (13.1 s), warmups
$0.155386, measured $1.572024; 92 agent requests, 159 responses, 463.9 s, **$1.899291**. All six
shadows matched and all six warmups passed in both phases.

**All retained attempts.** Plan v1 (five files): 75 agent requests, $1.398948 known plus three
unpriced streams. This round: v2 development 92 requests ($1.895439), interrupted v2.1 development
12 requests ($0.198034 plus one unpriced request), v2.1 development retry 92 ($1.899291) and
held-out 170 ($2.757156). In total **441 provider agent requests and $8.148868 of known
API-equivalent estimates, plus four requests of unknown cost**. That is not a billing figure and no
account-allowance percentage can be inferred from it.

**Break-even.** Setup plus one revalidation costs about $0.14 of inference per phase, before
compilation CPU, hosting and engineering. Against handwritten prefetch there is no positive saving
to amortize. Against normal tools the held-out cost saving ($0.0024 per request, interval
$0.0001–$0.0048) would repay that after roughly 30 to 1,000 requests on this mix, but development
showed no saving, so a break-even point is not established.

## Development versus held-out

| Paired comparison (tokens / calls / estimated cost saved) | Development (11 pairs)   | Held-out (22 pairs)      |
| --------------------------------------------------------- | ------------------------ | ------------------------ |
| Placement: compiled tool → selector/native                | 21.0% / 21.4% / 23.4%    | 21.1% / 21.4% / 23.8%    |
| Fallback: selector/native → selector/direct               | 20.7% / 22.7% / 19.7%    | 20.5% / 22.7% / 6.7%     |
| Normal → selector/direct                                  | 18.5% / 19.0% / −1.4%    | 18.4% / 19.0% / 13.0%    |
| Handwritten → selector/direct                             | −42.5% / −41.7% / −52.5% | −42.5% / −41.7% / −45.7% |
| Normal → compiled prefetch                                | −2.7% / −4.8% / −26.3%   | −2.6% / −4.8% / 6.3%     |

Token and model-call effects reproduce closely. Estimated cost effects do not: near-identical
token counts priced differently when provider cache hits changed (for example, compiled tool cost
$0.0305 per request in development and $0.0227 on held-out with similar tokens). Tokens and model
calls are therefore the primary measures here.

## Which mode suits which workload

- **Application knows complete required context and a validated artifact is healthy:** prefetch.
  The selector does this automatically and matches handwritten prefetch.
- **The agent must decide what it needs:** offer the compiled tool with the original tools. It is
  safe and correct but saved nothing in these cases.
- **Partial or no context:** normal execution under the current capability family. If an
  application owns those reads, handwritten partial prefetch saves a model call.
- **Fallback:** use direct handoff (`fallback: 'defer'`) rather than the native context agent where
  the application can supply freshness and identity contracts. It remains opt-in; native fallback
  is still the SDK default.
- **When governance is not needed:** handwritten prefetch is cheaper in every measured workload.
  Foundry's case rests on trace-derived compilation, signed artifacts, shadow evidence, guards and
  registry health, not on an inference advantage over handwritten code.

## Limitations and unknown costs

- The workload is twelve synthetic categories with one customer each per split and an artificial
  36% fallback rate; it is not a production traffic mix. Real fallback frequency is unknown.
- p95 values come from 22 requests per arm and are descriptive; no production tail-latency claim
  is made. Adapters are in-process fixtures, so real read latency and freshness are not measured.
- Case B depends on a fixture; the live capability cannot produce a partial result.
- `gpt-5.5` is a model alias, not an immutable checkpoint; Codex runtime context dominates
  absolute token counts. Transport retries inside the provider are not visible.
- Costs are API-equivalent estimates. Actual ChatGPT billing, four unpriced earlier requests,
  compilation CPU, hosting and engineering effort are unknown.
- Reply checks are an objective rubric (evidence, action, permitted reads, grounding and
  forbidden claims), not a human quality review.
- Nothing here establishes global optimality or production readiness.

## Evidence

- [v2.1 held-out results](routing-agent-v2.1-heldout.json) (complete, 144/144).
- [v2.1 development retry](routing-agent-v2.1-development-retry.json) (complete, 72/72).
- [Interrupted v2.1 development attempt](routing-agent-v2.1-development.json) (provider timeout).
- [v2 development results](routing-agent-v2-development.json) (complete, pre-fix source).
- [Frozen plan and change log](routing-agent-plan.md); [routing integration contract](execution-routing.md).

Verification for this round: 159 tests in 30 files, TypeScript and Prettier lint. The plan v1
history below is retained unchanged.

# Appendix: plan v1 attempt (superseded, retained)

**Status at the time: implementation and fixture validation complete; live evaluation incomplete.**
The last bounded development attempt stopped after 18 of 60 measured requests on a provider
transport/inference error with unknown usage. The 120-request held-out evaluation was not run.

This evaluates two small changes to Foundry using real OpenAI inference and synthetic,
read-only business data: selecting when context should be loaded, and returning ordinary
compiled misses to the existing support agent. The compiler, IR interpreter, matching algorithm,
registry, capability family and model provider remain in place.

### How the system works

The support agent reads authorized account records, recommends a support action and writes a
reply. Foundry observes typed tool events from at least two context-loading trajectories. Its
existing matcher finds the shared read structure; the compiler binds declared inputs, prunes
exploratory work, deduplicates compatible reads and schedules independent reads. The signed IR
artifact executes through the existing constrained interpreter, without model inference.
This replaces retrieval inside an agent workflow, not the recommendation or reply.

The earlier application hardcoded compiled-tool versus prefetch placement. Foundry's SDK chose
a guarded capability inside a context request but did not decide where that request belonged in
the support workflow. Quarantine invoked the configured native context agent, then the enclosing
support agent continued. That explains the retained four-model-response fallback: two responses
for context retrieval and two for the support task.

The [previous complete-task experiment](support-agent-experiment.md) measured 8,810.67 tokens,
two model calls, three business reads, 8.726 seconds and $0.021915 estimated API cost per normal
request. A compiled tool saved 2.15% of tokens with no call reduction; manually placed prefetch
saved 49.78% of tokens and one model call. Those figures used different tasks and must not be
treated as paired measurements of this change. The current experiment broadens the workload
and includes a handwritten comparator and failure cases.

### Independently reviewable changes

1. **Execution selection (`c59546d`).** An application registers a validated task contract in
   code. Known required customer/order/refund context selects compiled prefetch. If the agent
   must decide whether retrieval is needed, Foundry offers the compiled tool alongside original
   tools. Partial or absent context requirements use normal execution because the current
   compiled family always reads all three resources. Required authorization failure is terminal.
   Each selection records a mode, reason and elapsed time. There are no customer-ID, case-name,
   expected-answer or natural-language heuristics in the selector. Object registration establishes
   application provenance; the application must validate what its task actually requires.
2. **Direct fallback (`1fe6b15`).** `execute(request, { fallback: 'defer' })` returns an unresolved
   result and checkpoint on an ordinary applicability or execution miss. The original support
   agent can then use its original authorized tools. Successful typed reads can be reused within
   one request under an explicit freshness contract. Denial remains denial, failed reads remain
   missing evidence, and partial values never become a complete context result. The old native
   fallback remains the default.

The driver supplies valid completed reads to the support agent after a failed prefetch. It counts
attempted reads and nested inference, including work that failed. The request cache rechecks
authorization and binds customer, tenant, principal, policy, snapshot and adapter versions.
It validates schema/resource identity, rejects stale values, honors cancellation, returns copies
and persists nothing. This is read reuse, not resumption of a compiled plan or support for writes.

### Controlled experiment

The [frozen plan](routing-agent-plan.md) specifies ten development cases and ten held-out cases:
complete context, partial context, no context, needs discovered after reasoning, denied access,
quarantine, incompatible freshness, slow reads, transient failure and permanent failure.
Expected structured outputs, actions and permitted reads are hand-stated independently of the
optimizer and agent. Missing refund evidence must produce an unavailable answer, not an invented
empty history. The normal agent is scored against the oracle too.

Six arms isolate the effects:

| Arm                  | Placement and fallback                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Normal               | Support agent chooses among original typed tools.                                                     |
| Compiled tool        | Original application placement, with SDK native context-agent fallback.                               |
| Compiled prefetch    | Application preloads known complete context; native fallback.                                         |
| Handwritten prefetch | Deterministic parallel reads of known required context, including partial context; one bounded retry. |
| Selector/native      | Foundry selects placement; SDK native context-agent fallback.                                         |
| Selector/direct      | Same selection, with original support-agent handoff and valid request-local read reuse.               |

The handwritten path uses the same authorization, adapters, schemas and snapshot. It does not
pay for structural compilation, artifact verification, signed offers, registry health or SDK
telemetry. These are differences in governance overhead, not differences in the business result.
It can preload a partial context that the existing compiled family cannot represent.

Development contains 60 measured tasks, one repeat per case per arm. Final evaluation contains
120 measured tasks, two repeats. Each phase also plans six warmups and eight context requests
for observation, initial shadow and revalidation. The final records/messages are distinct and
not sent to the provider before final evaluation. Seeded arm rotations balance aggregate
positions and change positions across repeats. No failures or outliers are removed.

Every request forks the same observed, verified, shadowed and approved registry snapshot;
quarantine is applied to its own fork. This prevents prior fault cases from contaminating other
arms while preserving actual guards. Full-context loads are compared with the independent
snapshot, including proof that native context retrieval actually completed all required reads.
Reply checks cover exact evidence/action, permitted reads, order/delay grounding and forbidden
financial-action claims. They do not establish universal writing quality.

Complete request latency includes selection, authorization, SDK network/guards, attempted reads,
model work, thread cleanup and telemetry. Test database/server creation and teardown are outside
request latency and inside total experiment time. Provider cache usage is retained. Costs use
[published GPT-5.5 rates](https://developers.openai.com/api/docs/models/gpt-5.5): $5/million uncached
input, $0.50/million cached input and $30/million output, checked October 5, 2026. These are
API-equivalent estimates for ChatGPT-authenticated Codex inference; actual billed charges,
transport retries, hosting, adapter and engineering costs are unknown. Cached tokens are already
included in input/total tokens and are not added again.

The bounded development setup stopped twice before measured tasks. One request timestamp was
incorrectly reused across multiple provider requests; the unchanged freshness guard rejected it.
The corrected driver creates a new trusted observation for each new setup request. The second
attempt tried duplicate approval after local-demo revalidation, which preserves existing approval.
The driver now respects that lifecycle and explicitly checks renewed shadow coverage. Neither fix
widened guards or changed selection rules/prompts. The retained preflights used twelve native
requests, twenty-four completed responses, 83.996 seconds and $0.258823 estimated API cost.
Both are included in development accounting, rather than discarded as warmup noise.

A subsequent development attempt stopped after fourteen measured requests because the existing
provider harness aborted on a transient tool error. Its stream was interrupted, so its total usage
and inference estimate remain unknown. The corrected experiment opts into bounded recovery for
authorized 5xx read failures; default behavior and denials remain terminal. Its native context agent
can explicitly report unavailable context. Completed but schema-invalid responses retain known
usage, while unfinished streams stay unknown. These changes have fixture protocol coverage and
do not alter the selection rules or tune answers. The interrupted ledger remains part of total
experiment accounting; a fully known cumulative price cannot be claimed.

Another setup attempt passed initial shadows but the provider failed during renewed shadow before
any reported response/read. Its unknown stream is retained too. The driver allows one bounded
retry of the frozen run, rather than an open-ended prompt or routing search.

| Retained attempt           | Native requests | Reported completed responses | Measured task attempts | Elapsed seconds |              Fully priced request subtotal |
| -------------------------- | --------------: | ---------------------------: | ---------------------: | --------------: | -----------------------------------------: |
| Freshness preflight        |               4 |                            8 |                      0 |          30.840 |                                  $0.107790 |
| Revalidation preflight     |               8 |                           16 |                      0 |          53.157 |                                  $0.151033 |
| Interrupted read-error run |              25 |                           41 |                     14 |         161.124 | $0.493665, plus unknown failed-stream cost |
| Provider preflight         |               6 |                           10 |                      0 |          28.326 | $0.125574, plus unknown failed-stream cost |

These subtotals exclude the interrupted requests rather than assign them a zero cost. Their raw
reported partial events remain available. The interrupted read-error request reported at least
4,399 tokens and one completed response before abort; that completed event alone prices at
$0.007593. Its total work can be higher. No fully known cumulative cost or guaranteed billing
ceiling is claimed.

### v1 evidence

- [Development results](routing-agent-development.json).
- Final held-out results: **not run**, because development did not pass its provider/accounting gate.
- [Freshness preflight](routing-agent-development-preflight.json).
- [Revalidation preflight](routing-agent-development-revalidation-preflight.json).
- [Interrupted development run](routing-agent-development-interrupted.json).
- [Provider preflight](routing-agent-development-provider-preflight.json).
- [Routing integration contract](execution-routing.md).

Live benchmarks are opt-in commands, separate from normal fixture/unit tests. The driver refuses
to overwrite evidence, records source hashes and bounds model/tool/read attempts and API-equivalent
spending. The final set is evaluated once; its results do not tune selection or prompts.

### Implementation and security

Production changes are confined to `src/integration/selection.ts`, `request-reads.ts`, `client.ts`,
`src/runtime/adapters/registry.ts` and `src/exploration/observe.ts`. Selection and read reuse are
exported by the existing private SDK. Existing all-context authorization and native fallback are
defaults; explicit partial contracts/observation and deferred fallback are opt-in. The SDK's returned
duration now includes best-effort telemetry, and measured failed-native work is preserved.

The experiment adds `scripts/benchmark-routing-agent.ts`, `scripts/experiments/routing-task.ts`
and `routing-statistics.ts`, extends the reusable provider runner, and adds one opt-in npm command.
No dependency, capability family or provider is added. Documentation includes the frozen plan,
routing integration guide, this report and raw evidence, with links from the README and original
implementation report.

Twenty-six tests are added in four files:

- `tests/integration/execution-selection.test.ts`: provenance/spoofing, all/partial/none/unknown
  placement, per-read scopes, terminal denials and partial observation.
- `tests/integration/direct-fallback.test.ts`: default/native compatibility, deferred misses,
  validated partial-work reuse, identity/version/freshness binding, denials, shadow authority and
  failed-native measurement retention.
- `tests/integration/routing-agent-experiment.test.ts`: development/final separation, balanced
  order, independent labels/permitted reads, unavailability, full-context equivalence, negative
  paired differences/unknown cost, fresh request boundaries and local-demo revalidation lifecycle.
- `tests/integration/agent-read-recovery.test.ts`: fixture protocol recovery, terminal denials and
  defaults, known usage after final-schema failure and explicit unavailable native context.

Tool arguments remain strict and application-bound; models cannot change customer IDs or widen
scopes. Authorization is checked before inference and reads, including cache hits and handoff.
Artifact signatures, compatibility, rollout, freshness, quarantine and shadow gates remain intact.
The experiment has no financial writes, customer-message transmission, arbitrary generated code,
private chain-of-thought logging or real customer records. Business faults and unauthorized access
are separately scored; a correct denial/unavailable response is not a completed business task.

### Retained development measurements

These are the last attempt's **three cases per arm**, with one request each for quarantine,
authorization denial and transient read failure. They are an incomplete, fault-heavy development
sample, not a representative steady-state or held-out result. The provider-failed direct request
remains included. Its unknown usage propagates through token/cost means. Its shorter failure
latency cannot be counted as a successful-task performance gain.

| Metric per request                            |    Normal | Compiled tool | Compiled prefetch | Handwritten | Selector/native | Selector/direct |
| --------------------------------------------- | --------: | ------------: | ----------------: | ----------: | --------------: | --------------: |
| Input tokens                                  |  7,419.33 |     11,437.00 |          8,537.67 |    2,907.00 |        8,537.67 |         Unknown |
| Output tokens                                 |    163.00 |        226.67 |            211.00 |      102.00 |          223.33 |         Unknown |
| Cached input tokens                           |  5,973.33 |      9,557.33 |          5,973.33 |    2,389.33 |        7,168.00 |         Unknown |
| Total tokens                                  |  7,582.33 |     11,663.67 |          8,748.67 |    3,009.00 |        8,761.00 |         Unknown |
| Completed model calls                         |      1.67 |          2.67 |              2.00 |        0.67 |            2.00 |         Unknown |
| Actual business-read attempts                 |      2.33 |          3.00 |              3.00 |        2.33 |            3.00 |            2.00 |
| Unnecessary resource reads                    |      0.00 |          0.00 |              0.00 |        0.00 |            0.00 |            0.00 |
| Duplicate successful reads                    |      0.00 |          0.67 |              0.67 |        0.00 |            0.67 |            0.00 |
| Mean complete latency (s)                     |     6.527 |         8.737 |             5.975 |       3.003 |           7.596 |           2.451 |
| Median latency (s)                            |     9.698 |        10.640 |             7.192 |       3.362 |          11.380 |           1.743 |
| Observed p95 latency (s)                      |     9.884 |        15.570 |            10.731 |       5.647 |          11.407 |           5.609 |
| API-equivalent cost                           | $0.015107 |     $0.020977 |         $0.022138 |   $0.006843 |       $0.017132 |         Unknown |
| Oracle checks passed                          |    100.0% |        100.0% |            100.0% |      100.0% |          100.0% |           66.7% |
| Business-task success                         |     66.7% |         66.7% |             66.7% |       66.7% |           66.7% |           33.3% |
| Denied                                        |     33.3% |         33.3% |             33.3% |       33.3% |           33.3% |           33.3% |
| Failed                                        |      0.0% |          0.0% |              0.0% |        0.0% |            0.0% |           33.3% |
| SDK fallback per task                         |      0.0% |         66.7% |             66.7% |        0.0% |           66.7% |           66.7% |
| Selector time (ms, including zero for denial) |  0.000000 |      0.000000 |          0.000000 |    0.000000 |        0.008667 |        0.007542 |

Seventeen of eighteen task attempts passed the oracle/security checks. Six were correct denials
with zero model calls and zero reads. Eleven non-denied tasks completed correctly; one stopped on
a provider error before returning an answer. No measured read accessed an unpermitted resource.
The native fallback paths repeated two already successful reads in the transient case.

Only three case blocks completed; the harness correctly reports **no bootstrap confidence
interval** below the five-block threshold. There are no meaningful held-out uncertainty estimates.
The p95 values above are descriptive order statistics of three requests, including denial/failure.
They establish no production tail-latency improvement.

### One completed paired fallback comparison

The quarantined case is the only non-denied case in which both selector arms completed. Each
used identical authorization and data and passed full evidence/action and reply-grounding checks.
It isolates direct handoff from the same selector with native context fallback. Positive savings
mean less work/cost; fewer cached tokens alone are not a performance benefit.

| Metric                     | Selector/native | Selector/direct |     Absolute saving | Saving |
| -------------------------- | --------------: | --------------: | ------------------: | -----: |
| Input tokens               |          12,794 |           8,927 |               3,867 | 30.23% |
| Output tokens              |             319 |             219 |                 100 | 31.35% |
| Cached input tokens        |          10,752 |           7,168 |               3,584 | 33.33% |
| Total tokens               |          13,113 |           9,146 |               3,967 | 30.25% |
| Model calls                |               3 |               2 |                   1 | 33.33% |
| Business reads             |               3 |               3 |                   0 |  0.00% |
| Complete latency (s)       |          11.380 |           5.609 |               5.771 | 50.71% |
| API-equivalent cost        |       $0.025156 |       $0.018949 |           $0.006207 | 24.67% |
| Task success / correctness |     100% / pass |     100% / pass | 0 percentage points |     0% |
| Fallback occurrence        |             Yes |             Yes |                None |     0% |

In this single pair, direct handoff eliminated one of three model responses and 3,967 tokens
(30.25%). The saving comes from avoiding a separate context agent. Both still performed three
business reads; compilation did not reduce reads while the capability was quarantined. The observed
5.771-second latency saving and $0.006207 inference estimate are one-pair observations, not reliable
workload estimates. Both paths made two optimization API calls, and their full cost is included.

Placement alone, compiled tool versus selector/native, removed one of four model responses in
this case: 17,496 to 13,113 tokens (25.05%) and $0.031518 to $0.025156 (20.19%). Latency **regressed**
from 10.640 to 11.380 seconds (6.96%). It moved retrieval before the outer model; the compiler did
not change. Manually placed compiled prefetch had the same 12,794 input tokens and three calls as
selector/native. Their different estimated costs mostly came from 3,584 more cached tokens in
selector/native, not a demonstrated improvement over the same manually chosen execution mode.

### Losing cases and handwritten comparison

- **Versus normal execution in quarantine:** direct handoff used 9,146 versus 9,052 tokens
  (**1.04% more**), the same two model calls/three reads, and $0.018949 versus $0.018204
  (**4.09% higher** estimated cost). Cached input was identical at 7,168 tokens. Additional handoff
  input and variable reply tokens explain the cost increase; faster observed latency alone does
  not establish a better cost/work tradeoff. Keep normal execution available.
- **Versus handwritten prefetch in quarantine:** handwritten used 4,511 tokens, one model call,
  three reads and $0.010502. Selector/direct used **102.75% more tokens**, one additional call and
  **80.43% higher** estimated cost. Their observed latencies were 5.647 and 5.609 seconds; that
  38 ms difference is noise at this sample size. Foundry does not beat handwritten prefetch here.
- **Transient failure:** normal used 13,695 tokens, three calls and four business reads.
  Selector/native used 13,170 tokens, three calls and **six** reads, including two duplicate
  successful reads; latency regressed from 9.884 to 11.407 seconds. Compiled tool used 17,495
  tokens/four calls/six reads. Handwritten prefetch used 4,516 tokens/one call/four reads.
  Selector/direct preserved two valid completed reads and a failed-refund checkpoint, then the
  provider failed before the support agent reported a response. Its total tokens/cost are unknown;
  no successful transient-recovery saving can be claimed for direct handoff.
- **Unmeasured categories:** all-context measured trials, partial, public/no-context,
  model-decided retrieval, incompatibility, slow reads and permanent failure were not reached.
  Their contract/oracle/failure paths have fixture tests; those are not live-model evidence.

All six source-case warmups passed, including healthy compiled execution. Tokens/model calls
were normal 9,052/2; compiled tool 8,883/2; compiled prefetch 4,497/1; handwritten 4,541/1;
selector/native 4,491/1; selector/direct 4,485/1. These demonstrate harness compatibility and
successful healthy execution, not a final evaluation. They are excluded from measured means and
included in spending. The apparent healthy prefetch gain is consistent with the previous study,
but must be measured across the frozen final set before a new claim.

### Setup, revalidation and complete accounting

The last attempt completed 21 artifact checks, three initial real-agent shadow matches, quarantine,
21 revalidation checks and three renewed matches before measurement. Shadow authority and freshness
were retained; no gate was skipped.

| Phase                            |                Wall seconds | Completed model responses |  Reported tokens |                            API-equivalent cost |
| -------------------------------- | --------------------------: | ------------------------: | ---------------: | ---------------------------------------------: |
| Two source observations          |                      12.455 |                         4 |           17,274 |                                      $0.030883 |
| Analysis and compilation         |                       0.007 |                         0 |                0 |                $0 inference; CPU cost unpriced |
| Initial artifact validation      |                       0.090 |                         0 |                0 |                $0 inference; CPU cost unpriced |
| Three trusted initial shadows    |                      16.414 |                         6 |           25,910 |                                      $0.046307 |
| Complete initial setup           |                      29.163 |                        10 |           43,184 |                                      $0.077190 |
| Revalidation plus renewed shadow |                      21.507 |                         6 |           25,910 |                                      $0.062435 |
| Six warmups                      | Separate from request means |                         8 |           35,949 |                                      $0.108127 |
| Measured task requests           | Included in request latency |               At least 29 | At least 128,440 | $0.265541 priced subtotal, plus unknown stream |

The last attempt took 188.546 seconds and used 32 native agent requests; nested context requests
are included. Its fully priced requests subtotal $0.513293. Its total remains unknown. Across all
five retained attempts, there were **75 native requests, at least 128 completed inference responses,
32 measured task attempts and 461.993 seconds**. Three interrupted streams remain unpriced.
Fully priced requests subtotal **$1.391355**; including the known partial response from the earlier
interrupted task gives at least **$1.398948 in reported-work API-equivalent estimates**, plus unknown
inference. This is not actual ChatGPT billing. Setup/preflight/warmup/failure work is not excluded.

A workload-wide break-even reuse count is **not established**. It requires representative positive
per-request savings, actual fallback frequency and revalidation frequency. Inference amortization
would use `(setup cost + recurring revalidation cost) / positive expected per-request saving`;
unknown billing/hosting/engineering costs prevent a total economic break-even claim. Charging
handwritten prefetch for compiler setup would be inappropriate.

### Appropriate modes and remaining work

Known complete context with a healthy validated artifact is the intended prefetch workload: remove
a retrieval-selection model turn while retaining governed execution. When reasoning must determine
which resources are needed, offer original tools and the compiled tool; do not prefetch a maximum
possible context. Partial/no-context tasks use normal execution under this capability family.
Handwritten prefetch is a strong option for application-owned deterministic reads, especially
partial context; Foundry adds evidence, signature, registry and health governance rather than a
proved inference advantage over handwritten orchestration.

Direct fallback is opt-in. The one completed paired case supports eliminating the extra context
agent, but does not establish lower inference cost than normal tools or successful recovery across
all faults. Existing normal/native behavior stays available and SDK defaults are unchanged. No
production routing rollout is authorized by this incomplete evaluation.

The next necessary work is a provider-stable bounded development run, then the separate frozen
120-request held-out run without tuning against its answers. Evidence files must be archived under
new retained names rather than overwritten, and prior unknown costs must remain in accounting.
Use metered billing and real read-only connectors before monetary or production conclusions.
The current workload is ten synthetic categories, not a production traffic mix; only three were
measured. Codex runtime context contributes substantially to absolute token counts, the model alias
is not an immutable checkpoint, audited transport retries are unavailable, and reply grounding
is an objective rubric rather than a comprehensive human quality review. Request reuse requires
a real adapter freshness/snapshot contract; the immutable fixture contract does not establish
correctness for mutable production data. No global optimality or production p95 claim is made.

### Final verification and checkpoints

Final checks passed: **149 tests in 29 files**, TypeScript/Prettier lint, production build,
private SDK build and emitted SDK placement/provenance/read-reuse smoke checks, all existing
v1/v2 evals and **two browser end-to-end tests**. A read-only evidence audit reconciled all
44 retained warmup/task attempts with normalized provider events, model counts, pricing, actual
reads, denial and unknown-cost propagation. It also verified the exact artifact gates, six final
setup shadows and untouched held-out evaluation. Fixture tests are separate from live evidence.

Implementation checkpoints on `nikil-dev`:

| Checkpoint | Change                                                                     | Validation gate             |
| ---------- | -------------------------------------------------------------------------- | --------------------------- |
| `c59546d`  | Contract-based selector and scoped observation                             | 129 tests, types, SDK build |
| `1fe6b15`  | Deferred fallback, request-local read reuse and failed-native accounting   | 137 tests, types, SDK build |
| `c909854`  | Frozen six-arm development/final harness and independent oracles           | 143 tests, types, lint      |
| `1efd0bf`  | Fresh observations at setup request boundaries; retained preflight         | 144 tests, types            |
| `d5f841e`  | Respect existing local-demo revalidation approval; retain second preflight | 145 tests, types            |
| `bcb69f3`  | Opt-in read recovery, unavailable context and retained interrupted work    | 149 tests, types            |
| `100951c`  | Sanitized provider failure evidence and bounded final development retry    | 149 tests, types            |

No compiler rewrite or production deployment was performed. The live gate stopped execution
as specified; the held-out commercial-thesis evaluation remains outstanding.
