# Frozen routing evaluation plan

## Plan v2: twelve cases (current)

Plan v2 supersedes the ten-case plan below for new live work. The v1 text and all five v1
evidence files are retained unchanged and are listed as prior accounting in every v2 report.

**Why a fresh run.** The bounded v1 retry completed 18 of 60 requests: 17 with reported usage
and one direct-fallback request that failed on a provider transport/inference error with unknown
usage. Its source hashes still match the v1 source, but v2 changes the case file, schedule and
driver, so none of those requests match v2's case set, arm order or methodology. The driver has
no resume support. v2 therefore runs a complete new development set into new, versioned evidence
files (see the change log below for the current names).

**Arms (unchanged).** Normal original tools; compiled context loader offered as a tool; compiled
context prefetch; handwritten deterministic prefetch; Foundry-selected execution with native
context-agent fallback; Foundry-selected execution with direct handoff to the original support
agent and request-local read reuse. The handwritten arm uses the same authorized adapters,
schemas, output contract, snapshot and model settings. Its orchestration is a fixed
`Promise.allSettled` of the contract's reads with one bounded retry per read, written by the
application. It has no trace observation, compilation, artifact verification, trusted shadow,
approval, signed offer, SDK telemetry, registry health or revalidation; those setup and
verification costs are reported only for Foundry. It can also preload known partial context,
which the compiled family cannot represent.

**Cases.** Each split keeps the ten v1 categories (complete, partial, absent and model-decided
context; denied access; quarantine; incompatible freshness; 120 ms slow read; transient and
permanent read failure) and adds two:

- `software_tool` (case type A): the application contract says the agent decides what it needs.
  The selector offers the unchanged compiled `load_customer_context` alongside the original
  lookup tools. The request genuinely needs eligibility, every order and refund history. The
  tool input is application-bound to the authorized customer; the model chooses whether and when
  to call it but cannot supply or change a customer ID or scope. Development uses C-111 and
  held-out uses C-414.
- `software_supplement` (case type B): the request needs eligibility, orders **and** refund
  evidence. A valid software result covers eligibility and orders only, and the agent must add
  refund history with the existing typed `lookup_refund_history` tool. Development uses C-212 and
  held-out uses C-515. Both records contain a prior refund, so treating the partial result as
  complete changes the evidence and the recommended action.

**Limitation for case type B.** The existing compiled capability's only output contract is the
full `context.v1` (customer, orders and refunds). A missing or failed read deoptimizes; it never
returns a valid partial result, and every existing typed tool's resource is already in that
result. No partial-but-valid live result can arise without changing the capability, which this
plan forbids. Case B therefore offers a **labeled test fixture**, `load_order_summary`, in the
software placements (manual compiled-tool and both selector arms). It reads eligibility and
orders through the same authorized observer, adapters, schemas and snapshot, and fails closed on
stale runtime context with the compiled artifact's 30-second window. It is never compiled,
verified or deployed. Its rows use live agent inference but are excluded from Foundry-capability
aggregates and paired comparisons and are reported separately. Fixture tests cover its supplement
mechanics without inference.

**Independent oracles.** Every case's request, expected structured answer, required reads,
permitted reads and (for case B) necessary follow-up reads are hand-stated in
`scripts/experiments/routing-task.ts`, not derived from the optimizer or an agent. The agent never
sees the expected answer. The final response is scored against that oracle. v2 adds an
`evidenceGrounded` check: a non-null eligibility, order or refund field fails unless that resource
was read successfully in the same request, so guessed or partial evidence cannot pass. The normal
agent is scored the same way and can lose.

**Per-call accounting.** Each agent tool call is recorded separately (software call, follow-up
call or original tool), with its business reads, latency, duplicate successful reads, redundant
re-requests of already returned resources (including cache-served ones), unnecessary reads and
whether it was a necessary follow-up. Each completed model response is recorded with
input/cached/output tokens, API-equivalent cost and the tool calls it issued. Provider usage is
reported per response, not per tool call.

**Counts confirmed against the harness** (`balancedSchedule × experimentArms`, asserted in
`tests/integration/routing-software-cases.test.ts`):

| Live provider work                                   | Development |   Held-out |
| ---------------------------------------------------- | ----------: | ---------: |
| Cases × arms × repeats                               |  12 × 6 × 1 | 12 × 6 × 2 |
| Measured support requests                            |          72 |        144 |
| ... of which denied before inference (zero requests) |           6 |         12 |
| Source observation context requests                  |           2 |          2 |
| Initial trusted-shadow context requests              |           3 |          3 |
| Revalidation shadow context requests                 |           3 |          3 |
| Warmup support requests (development `all` case)     |           6 |          6 |
| Maximum nested native context-fallback requests      |          12 |         24 |
| **Maximum provider agent requests**                  |      **92** |    **170** |

Both phases together plan at most 262 provider agent requests, each limited to six completed
model responses, ten tool calls and a 60-second turn. Nested fallbacks occur only when a
native-fallback arm (compiled tool, compiled prefetch or selector/native) meets quarantine,
incompatible freshness, transient failure or permanent failure: four categories × three arms per
repeat. Analysis, compilation and fixture validation make no model requests.

**Estimate and uncertainty.** The 11 non-denied v1 measured requests with known usage averaged
$0.0241 API-equivalent each (range $0.0100–$0.0412); an earlier interrupted attempt priced
near-identical token counts up to $0.0472 because cache hits varied. Using $0.007–$0.047 per
inference-bearing request plus v1's measured setup ($0.077), revalidation ($0.062) and warmups
($0.108): development ≈ $1.9 (≈ $0.8–$3.6) and held-out ≈ $3.8 (≈ $1.5–$6.9), about $5.7
(≈ $2.3–$10.5) combined. These are GPT-5.5 standard-rate estimates ($5 input, $0.50 cached input
and $30 output per million tokens; official model page checked 2026-10-07), not ChatGPT billing.
Prior v1 attempts add $1.398948 of known estimates plus three unpriced streams. No account
allowance percentage can be derived from request counts.

**Command.** The driver accepts exactly one argument, the split, and rejects anything else.
The Codex CLI is not on `PATH` in this environment; the existing `FOUNDRY_CODEX_BIN` override
selects the bundled CLI:

```sh
FOUNDRY_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  npm run benchmark:routing-agent -- development
FOUNDRY_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  npm run benchmark:routing-agent -- heldout
```

**Stopping and freeze rules.** Each phase stops before its next request when its own known
estimate becomes unknown or exceeds $9, when provider usage is incomplete, or when an
authorization gate fails. In-flight work can cross the threshold. There is one live attempt per
phase. On a provider failure, the partial evidence is retained and the phase is reported
incomplete rather than retried in a loop. Development results may justify one documented, tested
fix; any behaviour change requires a complete new 72-request development run under a new
evidence name, never mixed with older source versions. Code, prompts, selection rules, seeds
(development 41107, held-out 71109) and this plan are frozen before the held-out phase, which is
run once and never used for tuning.

**Development change log.** The first complete v2 development run
([`routing-agent-v2-development.json`](routing-agent-v2-development.json), source `1d36a09`)
completed 72/72 requests with known usage: 92 provider agent requests, 161 completed responses
and a $1.895439 API-equivalent estimate. It exposed two defects, each fixed in its own commit
without changing the selector, SDK, guards, oracle or cases:

1. **Direct handoff lost the retry budget (`51fb448`).** After one failed compiled refund read,
   the handoff said `{status:'unavailable', attempts:1}`. In both read-failure cases the original
   agent answered unavailable without its permitted retry; in the transient case every other arm
   recovered. The shared read status now states `failedAttempts` and `retriesRemaining` under the
   unchanged two-attempt budget for every arm. The same commit fixes per-response tool-call
   attribution in the ledger (reporting only).
2. **Ambiguous unavailable instruction.** "Use unavailable with all evidence fields and
   selectedOrderId null" was read by three arms as "keep verified fields". The hand-stated oracle
   (all evidence null) is unchanged; the instruction now names the null fields explicitly.

Because both change behaviour, development is rerun completely (72 requests) into
`docs/routing-agent-v2.1-development.json`. The held-out phase writes
`docs/routing-agent-v2.1-heldout.json`. Results from different source versions are never pooled;
the first v2 run stays in prior accounting.

**v2.1 development attempt (incomplete).** Setup passed (two observations, compilation, 21
artifact checks, three initial and three renewed shadow matches). The normal, compiled-tool and
compiled-prefetch warmups passed. The handwritten-prefetch warmup's single model turn then hit the
60-second provider turn timeout without reporting usage, and the warmup gate stopped the run
before any measured request. [Retained evidence](routing-agent-v2.1-development.json): 12 provider
agent requests, 21 completed responses, $0.198034 known API-equivalent estimate plus one request
of unknown cost. Under this plan's one-attempt rule, development v2.1 is incomplete and the
held-out phase has not started.

**User-authorized single retry.** The user authorized exactly one more v2.1 development attempt
with no code, prompt, case or selection change, writing
`docs/routing-agent-v2.1-development-retry.json`. If it passes its provider, accounting,
correctness-reporting and authorization gates, the held-out set runs once into
`docs/routing-agent-v2.1-heldout.json`. A provider failure in either phase ends live work and is
reported as incomplete; there is no further retry.

## Plan v1 (superseded, retained)

Approved scope: execution placement and read-only fallback for `load_customer_context`; no
compiler rewrite, new capability family/provider, financial write or arbitrary generated code.
The baseline is [the retained support experiment](support-agent-experiment.md): compiled tool
saved 2.15% of total tokens; application prefetch saved 49.78%; quarantine used four model calls.

Two independently checkpointed changes are evaluated: application-owned validated contracts select
placement (`c59546d`), then opt-in direct fallback/read reuse (`1fe6b15`). Defaults remain compatible.
The selector has no customer IDs, task wording, benchmark names or expected-answer rules. It does
not predict requirements from model prose. Registration establishes provenance in application code;
the application remains responsible for validating task semantics.

## Cases and arms

Each split contains ten categories: all context, eligibility-only context, public/no context,
retrieval needs determined by the model, denied account access, quarantined artifact, stale runtime
context, a 120 ms slow read, a transient read failure and a persistent read failure. Development uses
C-101/202/303; final uses C-404/505/606 and distinct messages. Compilation sees C-101/202; trusted
shadow sees C-101/202/303. Final records are never sent to the provider before final evaluation.
Unit contract/schema checks may examine synthetic final fixtures without tuning routing rules.

Four fixed arms remain: normal tools, compiled context tool, compiled prefetch and handwritten
deterministic prefetch. Two additional arms isolate improvements: selector with native context
fallback, and the same selector with direct support-agent handoff and request-local read reuse.
Fixed compiled prefetch applies only to known complete-context contracts; partial/absent/undecided
needs use original tools. The handwritten arm can preload known partial context. Unknown tasks offer
individual tools so complete context is never artificially forced to favor Foundry.

All arms use the same snapshot, authorization, typed adapters, output contract and model settings.
Task labels and permitted/required reads are hand-stated independently of the optimizer. Incorrect
normal-agent answers are retained and scored against those labels. Persistent service failure must
produce an explicit unavailable answer without guessed evidence. Business failure and authorized
denial are reported separately from oracle correctness.

Each request forks the same actually observed, verified, shadowed and approved SQLite snapshot.
Quarantine is real in that fork. This isolates health state and faults across arms without disabling
guards or silently restoring an unhealthy production deployment. Sandbox initialization/teardown is
excluded from steady-state latency and included in total experiment time.

## Bounded inference and frozen final set

Run `npm run benchmark:routing-agent -- development`, then `-- heldout`:

| Planned work                        | Development | Final held-out |
| ----------------------------------- | ----------: | -------------: |
| Measured task requests              |          60 |            120 |
| Repeats per case per arm            |           1 |              2 |
| Warmup task requests (source case)  |           6 |              6 |
| Source observation context requests |           2 |              2 |
| Initial shadow context requests     |           3 |              3 |
| Revalidation shadow requests        |           3 |              3 |
| Maximum nested context fallbacks    |          12 |             24 |

Denied task requests incur no model inference. A six-completed-response budget, ten tool requests,
60-second turn timeout and two underlying read attempts per operation bound each agent request.
The provider response that crosses a budget can already have consumed work; audited transport
retries and actual billing remain unavailable. No unknown work or charge is treated as zero.

Each run stops before the next request if cumulative completed-inference estimates become unknown
or exceed $9 (up to $18 across both planned runs). An in-flight request can cross this estimate
threshold; it is a stopping rule, not a guaranteed billing ceiling. Pricing uses GPT-5.5 standard
input/cached/output rates, checked October 5 against the official model page. ChatGPT subscription
charges, hosting, adapters and engineering costs are unknown.

The case file, routing source and driver are committed before live development. The driver retains
source hashes and refuses to overwrite evidence. Final evaluation is run once after development;
its results do not tune selection rules or prompts. A development failure may require a documented
fix, but its spending/results must remain retained. No unbounded prompt/selection search is allowed.

Seeded randomized Latin rotations balance aggregate arm positions within one count and move arms
to different positions across repeats. Seeds are fixed in code and logged. Cache tokens, wrong
answers, failed reads, fallback, outliers and complete provider ledgers are retained. Paired effects
include descriptive case-block bootstrap intervals when at least five case blocks support them;
repeats stay together. This small synthetic sample cannot establish production p95 improvements.

## Accounting and decision rule

Report input/output/cached/total tokens, completed model calls, actual underlying reads, unnecessary
and duplicate successful reads, mean/median/p95 complete request latency, pricing-based inference
estimates, exact evidence/action and reply-grounding checks, denial/failure/success rates, full
fallback cost/frequency, selector duration, and setup/revalidation costs separately.

Compare selector-native versus compiled-tool placement, direct versus native fallback, direct versus
normal tools, and direct versus handwritten prefetch. Also report every case category so losing
partial/unknown/failure cases are visible. Do not charge compiler setup to handwritten prefetch or
claim compiler superiority when savings come from execution placement. Existing normal/native
defaults stay available; recommend new paths only where correctness and the measured objective
support them.

## Retained setup preflight

The first development attempt stopped before warmups or measured tasks at the trusted-shadow
gate. The driver reused a runtime observation timestamp from process startup across successive
provider requests; by the second shadow it exceeded the unchanged 30-second freshness guard.
The failure is reproducible with a fixture test: a stale request gets `guard_miss`, while a new
request with a fresh trusted observation gets `match`.

The fix creates a fresh runtime observation before each distinct observation/shadow request;
it does not widen guards or refresh an in-flight request. Selection rules, cases and prompts are
unchanged. The corrected driver also retains each shadow status and observation age.
[Preflight evidence](routing-agent-development-preflight.json) retains four native requests,
eight completed responses, 30.840 seconds and $0.107790 API-equivalent spending. This spending
counts toward development's stopping threshold and is added to the corrected run's total.
The corrected development run still has 60 measured tasks; no measured case was rerun or tuned.

The second setup attempt passed all six initial/renewed shadows, then stopped because the driver
attempted duplicate approval after revalidation. The existing local-demo compatibility path retains
approval on successful revalidation; other tenants return to verified. The driver now respects that
status and explicitly requires renewed shadow readiness before redeployment. Registry rules are
unchanged, and a fixture regression exercises quarantine, verification, retained approval and
redeployment. [Second preflight evidence](routing-agent-development-revalidation-preflight.json)
retains eight context requests, sixteen responses, 53.157 seconds and $0.151033 estimated cost.
Both attempts together used twelve requests, twenty-four responses and $0.258823; these count
toward the same development budget. Neither attempt reached measured tasks. Selection rules,
messages and the final set remain unchanged.

The third attempt reached fourteen measured requests, then correctly stopped on unknown provider
usage after the original agent harness aborted a transient tool failure. The harness previously
treated every tool error as fatal. This experiment now opts into returning authorized 5xx read
failures to the model, allowing its bounded retry/unavailable behavior. Defaults and authorization
denials stay terminal. A fixture provider-protocol test verifies recovery, denials, default behavior
and accurate usage for a completed response rejected by the final schema.
The context fallback's experiment-only output contract also allows explicit unavailability after
bounded failed reads, instead of forcing a complete-context schema with missing evidence. That
unresolved result retains measured inference. Other experiments keep their existing default schema.
[Interrupted evidence](routing-agent-development-interrupted.json) retains all fourteen tasks,
warmups and setup work, including the failure's unknown total cost. No prompt or selection rule
was tuned. The corrected development run is bounded to sixty measured requests and its own
$9 estimate stopping rule (including the two fully priced setup preflights). Because the interrupted
stream is unpriced, no finite cumulative spending ceiling or fully known experiment total is
claimed. The final evaluation remains one separate 120-request run; it has not started.

The next attempt passed initial validation and three shadows but stopped at renewed shadow when
the provider failed before reporting any response or making a read. Its cost remains unknown in
[provider preflight evidence](routing-agent-development-provider-preflight.json). One bounded
retry of the unchanged task/selection experiment is permitted; another provider/accounting block
will end this evaluation as incomplete, with no final-set tuning or unbounded retry loop. Sanitized
agent failure stages are now retained for diagnosis. Each corrected attempt retains its own
request/estimate bounds, and all prior attempts remain separately accounted.

That bounded retry stopped after eighteen of sixty measured task requests on a provider
transport/inference error before the direct-fallback support agent reported usage. Its report is
`complete: false`; the failed request and unknown cost are retained. Live inference ended at this
gate. The final 120-request evaluation was not run, and its cases were not used to tune anything.
The implementation remains opt-in with existing defaults. Resumption requires a separately bounded
provider-stable development run with new retained evidence paths, followed by the frozen final set.
