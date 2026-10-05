# Frozen routing evaluation plan

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
