# Travel-day task and full SDK lifecycle benchmark

This experiment runs on `abhi-dev` using live Gemini inference with synthetic personal trips.
It does not access actual calendar, flight, hotel, maps or weather accounts. The task is to prepare
a travel-day plan for one flight, one hotel and two ground journeys, including flight changes,
calendar conflicts, check-in timing, missing confirmations and weather readiness.

## Workflow

Thirteen registered operations form six dependency stages. Nine operations read fixture data;
four perform trusted pure calculations. The compiler/runtime have no travel-specific changes.

| Stage | Operations                                                       |
| ----- | ---------------------------------------------------------------- |
| 1     | Load trip and traveler profile                                   |
| 2     | Check flight; load hotel, calendar and origin weather            |
| 3     | Retrieve destination weather and both ground routes              |
| 4     | Calculate home departure and hotel arrival/check-in wait         |
| 5     | Find calendar events overlapping the travel window               |
| 6     | Check missing confirmations, packing needs and overall readiness |

The three trips cover a delayed flight with early hotel arrival and a missing hotel confirmation,
an on-time trip with no conflicts, and a rescheduled flight with two conflicts and a missing flight
confirmation. Expected answer fields, including UTC timestamps and wait minutes, are hand-stated
separately from the execution callbacks.

## Measured results

Live inference used `gemini-3.8-flash`. Every approach ran three trips twice, for six tasks per
approach and 24 measured tasks. All 24 answers passed. The regular agent used seven model
responses per task, the compiled tool two, and each prefetch approach one.

| Approach          | Input tokens | Output including reasoning | Cached input subset | Total tokens | Model responses |
| ----------------- | -----------: | -------------------------: | ------------------: | -----------: | --------------: |
| Regular agent     |      156,702 |                     14,522 |              46,343 |  **171,224** |              42 |
| Compiled tool     |       13,336 |                      4,295 |                   0 |   **17,631** |              12 |
| Compiled prefetch |        7,468 |                      3,875 |                   0 |   **11,343** |               6 |
| Regular prefetch  |        7,468 |                      3,210 |                   0 |   **10,678** |               6 |

Cached input is already included in the input/total columns; do not add it again. Reasoning is
already included in output and total. Provider-reported total consumption, rather than estimated
tokenization, is used throughout. Token reductions relative to this regular-agent baseline were
89.70% for compiled tool, 93.38% for compiled prefetch and 93.76% for regular prefetch. These are
not dollar savings: the regular agent received cache hits, which affect billing differently.

Regular prefetch used the fewest tokens. Its input was identical to compiled prefetch: both
consumed 7,468 input tokens. Their 665-token difference came entirely from generated output and
reasoning. This small sample does not establish an inherent token advantage for either prefetch
implementation. Compilation reduced repeated model-driven orchestration compared with the
13-tool agent contract; it did not eliminate business reads.

All approaches performed 78 tool operations across their six measured tasks: 54 reads and 24
pure calculations. The compiled region made zero model calls. The final response still used Gemini.

## Full consumption accounting

| Approach          | Measured total | One warmup | Total including warmup |
| ----------------- | -------------: | ---------: | ---------------------: |
| Regular agent     |        171,224 |     29,457 |            **200,681** |
| Compiled tool     |         17,631 |      2,801 |             **20,432** |
| Compiled prefetch |         11,343 |      1,816 |             **13,159** |
| Regular prefetch  |         10,678 |      1,880 |             **12,558** |

Shared Gemini exploration consumed **56,719 tokens**. Warmups consumed **35,954** and measured
tasks **210,876**. Overall consumption was **303,549 tokens**, across 91 provider responses:
14 exploration, 11 warmup and 66 measured. Exploration is counted once, rather than duplicated
between compiled approaches. Compilation, deterministic verification, native fixture shadowing
and concurrent SDK execution required no model inference.

The [raw report](experiments/travel-day-gemini-1793771698901.json) retains every response usage
record, answer, phase total and lifecycle receipt. It reports complete execution and all answers
correct. All source and packaged-SDK fingerprints matched the files used at completion. This
travel run had no failed provider calls or discarded measured tasks; the expected post-revocation
capability lookup returned 404 and produced an unresolved handoff.

All **48 concurrent built-SDK requests** passed, as did revocation. The HTTP ledger contains 74
requests: 73 successful lifecycle/offer requests and the expected revoked-offer 404. The SDK
performed capture upload, compilation, all 22 verification checks, approval, three native shadow
comparisons, deployment and revocation on the same artifact digest. The third trip was outside
the two Gemini compilation trajectories.

## SDK integration

The benchmark loads the built `dist-sdk` package for observation, model calls, lifecycle operations
and execution. The client never imports or invokes `TaskRegistry`. Its lifecycle calls are:

```ts
const uploaded = await Promise.all(traces.map((trace) => sdk.observe(trace)));
const draft = await sdk.compile(
  'load_travel_day_context',
  uploaded.map((trace) => trace.id),
);
const verified = await sdk.verify(draft.id);
// Check verified.status and every verification result before review.
await sdk.approve(draft.id);
for (const input of shadowInputs) await sdk.shadow(draft.id, input);
await sdk.deploy(draft.id);
const result = await sdk.execute({ name: 'load_travel_day_context', kind: 'travel_day', input });
// Later:
await sdk.revoke(draft.id);
```

These calls use authenticated HTTP endpoints. Server role permissions, verification on the exact
digest, trusted native shadow coverage and signed runtime offers remain enforced. SDK methods
cannot bypass approval or deploy a draft. Operator-owned task/tool contracts, sandbox cases and a
native callback must already be registered on the control plane; executable code and provider
credentials are not uploaded through the SDK.

The SDK integration regression also checks early approval/deployment rejection, compilation-role
denial, principal isolation, malformed and wrong-user flight outputs, revalidation invalidation,
revocation and 48 concurrent executions. It uses fake credentials and no model inference.

## Four approaches

- Regular agent: Gemini chooses among 13 original tools and supplies their full typed arguments.
- Compiled tool: Gemini calls one approved context capability, then produces the final answer.
- Compiled prefetch: the SDK runs the approved context capability before Gemini starts.
- Regular prefetch: application code runs the same registered operations before Gemini starts.

The regular-agent arguments are checked against application-owned input/result provenance; the
harness does not invent provenance from matching strings. Every approach must obtain all 13
operation results and return the same final evidence fields. Both tool approaches use the same
once-per-name policy and reuse successful results. Known independent operations can run in parallel.
This compares a fixed operation contract, not every possible way an unconstrained model could
solve the task. In particular, the regular agent uses the registered pure calculation tools too.

The two prefetch approaches send identical context and instructions to Gemini. Any token difference
between them can reflect generated response/reasoning variation; compilation cannot be credited
with reducing identical model input. All approaches still perform the same nine reads and four
calculations. Compiled execution itself makes zero model calls.

## Reproduce

```sh
npm run build:sdk
npm run benchmark:travel-day -- --live
```

Set `GEMINI_API_KEY` in the process environment. Optional settings are `FOUNDRY_GEMINI_MODEL`
and `FOUNDRY_TRAVEL_REPEATS` (1–4, default 2). The default schedule uses three trips twice in
every approach, rotates arm order, and includes one warmup per approach. Exploration uses the
first two trips; verification and trusted native shadow comparison also cover the third trip.

Every provider response contributes its reported usage, including reasoning. Cached input is
already included in input totals. Failures remain in the ledger; missing usage stays unknown.
Reports use unique files under `docs/experiments/` and retain source/packaged-SDK hashes, lifecycle
HTTP receipts, individual answers, per-response usage, exploration/warmup/measured totals and
concurrency/revocation results. No credential or private reasoning text is retained.

Validation: 240 tests passed across 36 files with the existing unrelated untracked Ollama test
excluded; the SDK build, scoped strict TypeScript check and production Vite build passed. Root
lint/build still encounter the previously documented Ollama test/type error. Source files for the
travel feature and SDK changes pass formatting checks.
