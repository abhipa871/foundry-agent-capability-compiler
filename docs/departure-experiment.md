# General task implementation and Gemini departure experiment

Implemented on local branch `abhi-dev`, created from `nikil-dev` (`d6bc601`). Changes have not been
pushed. The general compiler, runtime, SDK and model-provider adapters are described in
[General task SDK](general-sdk.md) and [ADR 0003](adr/0003-general-task-contracts.md).

## Final measured result

The task was: “When should I leave for my next appointment, how long is the trip, and do I need
an umbrella?” Live inference used `gemini-3.8-flash`; personal calendar, profile, route and weather
records were synthetic fixtures. This experiment did not access a real calendar, maps account
or weather service.

Three different users ran twice in every arm: six matched tasks per arm, 24 measured tasks.
Every structured answer passed an independently stated oracle. All four arms performed the same
four reads and one pure departure-time calculation. Only placement and model-visible tools changed.

| Arm               | Total input tokens | Total output tokens, including reasoning | Total tokens | Mean tokens/task | Model calls |
| ----------------- | -----------------: | ---------------------------------------: | -----------: | ---------------: | ----------: |
| Regular API tools |             14,182 |                                    3,463 |   **17,645** |         2,940.83 |          24 |
| Compiled tool     |              4,635 |                                    2,858 |    **7,493** |         1,248.83 |          12 |
| Compiled prefetch |              2,302 |                                    2,101 |    **4,403** |           733.83 |           6 |
| Regular prefetch  |              2,302 |                                    1,584 |    **3,886** |           647.67 |           6 |

Each compiled region made zero model calls. The complete tasks still used Gemini to turn the
returned context into the final answer. Cached input tokens were zero in this run. Output counts
include reasoning tokens; reasoning is already included in totals and must not be added again.

Relative to regular tools, measured total tokens were 57.53% lower for the compiled tool,
75.05% lower for compiled prefetch, and 77.98% lower for regular prefetch. These percentages apply
only to this matched synthetic workload and model configuration.

Regular prefetch used the fewest tokens. Both prefetch arms received identical input context
and had exactly the same total input tokens. The 517-token difference was in generated output,
including 503 reasoning tokens. It does not establish a compiler-driven token advantage for either
prefetch implementation. Model generation varies even when retrieval is deterministic.

## Total consumption, including setup and warmup

| Arm               | Measured tasks | One warmup | Arm total including warmup |
| ----------------- | -------------: | ---------: | -------------------------: |
| Regular API tools |         17,645 |      2,912 |                     20,557 |
| Compiled tool     |          7,493 |      1,145 |                      8,638 |
| Compiled prefetch |          4,403 |        704 |                      5,107 |
| Regular prefetch  |          3,886 |        845 |                      4,731 |

The shared Gemini exploration/setup consumed **6,482 tokens**. Warmups consumed **5,606** and
measured tasks **33,427**. The final experiment consumed **45,515 total tokens**, across 64
reported model responses: eight setup, eight warmup and 48 measured. Shared setup is counted
once, rather than charged independently to both compiled arms. Compiler verification, trusted
native shadow comparisons and SDK stress execution used zero model inference.

The [final raw report](experiments/departure-gemini-1793768476107.json) retains every task,
normalized per-response usage, phase totals, stress outcomes and SHA-256 fingerprints of the
source and packaged SDK. All retained fingerprints were checked against the final files and match.
The total is provider-reported token usage, not an estimated tokenizer count or billed-dollar claim.

Earlier departure runs are retained separately and are not pooled into the final comparison:

| Attempt                                                                    | State                               | Tokens |
| -------------------------------------------------------------------------- | ----------------------------------- | -----: |
| [Initial setup](experiments/departure-gemini-1793767425871.json)           | Failed on repeated model tool calls | 11,088 |
| [Calibration](experiments/departure-gemini-1793767797941.json)             | Complete                            | 44,465 |
| [Shadow-gated validation](experiments/departure-gemini-1793768140233.json) | Complete                            | 42,451 |
| [Final hardened version](experiments/departure-gemini-1793768476107.json)  | Complete                            | 45,515 |

All retained departure attempts consumed **143,519 tokens**. This is an accounting sum across
development versions, not a combined performance sample. It excludes earlier CRM prototype
experiments and the separate small API smoke call.

## Method and stress results

Gemini generated the two source trajectories through the original application-bound tools. The
compiler validated explicit input/result provenance, emitted the registered task IR, and verified
the exact candidate against both traces and three independent sandbox cases. Nineteen checks
passed, including scope, tenant, principal, policy, snapshot, stale data, tamper, unavailable service,
malformed result and deadline cases. Approval bound the same digest. Three trusted native shadow
comparisons passed before deployment, including the third user outside the source trajectories.

The ordinary-tool arm let Gemini choose among five original tools. The compiled-tool arm offered
one compiled context tool. The prefetch arms loaded context before Gemini. Both tool arms used
the same opt-in once-per-name policy and request-local result reuse. Arm order rotated by task.
Every request used a fresh conversation and the same instructions/final-answer schema. No extra
baseline turns were inserted by the harness.

The experiment imported the built `dist-sdk` package, rather than substituting a direct interpreter
call for SDK execution. All **24 concurrent packaged SDK requests passed**, with correct results
and zero model calls. Revocation prevented subsequent compiled execution. Separate regression
tests exercised **120 concurrent compiled executions**, cross-domain project inventory, malformed
outputs, timeouts, wrong-user results, narrow credentials, invalid credentials, scope denial,
signature forgery/expiry, evidence consent, secret-error suppression and revalidation/shadow gates.

## Implementation and validation boundaries

The new default SDK is domain-independent; the former CRM SDK remains at `./legacy`. Applications
register schemas, versions, permissions, authorization/result-isolation predicates and trusted
handlers. Provider transports accept open model IDs for OpenAI, Moonshot, Claude, Gemini, xAI and
OpenRouter. Gemini was tested live; the other transports have mocked protocol/usage tests.
Availability and tool capability remain provider/account-specific.

Compiled support currently covers bounded read/pure DAGs and object output projections. It does
not infer arbitrary branches or loops, execute generated code, resume checkpoints, or support real
external writes. Handler implementations are trusted application code, not an untrusted-code
sandbox. Deterministic control flow does not make changing external data or model generation
deterministic. The existing browser playground remains the CRM compatibility demo.

Validation performed:

- 239 tests passed in 35 files with the existing unrelated untracked
  `tests/unit/ollama-adapter.test.ts` excluded. That file expects an absent legacy Ollama adapter.
- Existing v1/CRM evals and the added general departure eval passed.
- SDK build and package dry-run passed; scoped strict TypeScript and production Vite build passed.
- Formatting checks passed for changed source/docs; source fingerprints match the final experiment.
- Full root lint/build remain blocked by the pre-existing Ollama test/type error; repository-wide
  formatting also reports inherited issues in unchanged files. The user’s test was preserved.

No schema migration is required: general traces, artifacts and shadow metadata use new record
kinds in the existing tenant-scoped store. Existing CRM/v1/coding records remain separate. Rollback
uses a previously approved compatible artifact or the original authorized agent. Credentials stayed
in server environment/callbacks and were not stored in reports or artifacts. Replay capture is
explicitly opted in per tool and rejects common secret-bearing field names; applications still
own data projection, retention and production connector policies.
