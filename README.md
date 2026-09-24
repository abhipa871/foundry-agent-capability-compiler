# Foundry Agent Capability Compiler

Local MVP for recording agent trajectories, reviewing capabilities, and measuring repeated task execution.

## Local launch

Requires Node.js 24+, npm, and an authenticated Codex CLI for real chat runs.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The API listens on loopback port 3001. SQLite records persist in `data/foundry.sqlite`; `FOUNDRY_DB` overrides that path. `FOUNDRY_CODEX_DRY_RUN=true` enables explicitly labeled simulated runs; their token counts are fixtures.

## Compiled read capability (Agent JIT)

Open the **JIT compiler** page to run the compiler end to end:

1. **Load sample traces** ingests two structured trajectories for the same task kind. They differ in customer, in call order, and in exploratory noise, and one repeats a read.
2. **Compile candidate** mines a shared subgraph signature across both traces, infers which argument is a caller parameter and which is a value reference, prunes the exploratory branches, coalesces the duplicate read, schedules the independent reads, and emits a digested IR artifact.
3. **Verify candidate** runs the suite against that artifact: differential comparison with both source traces, plus schema, scope, adapter-drift, freshness, timeout, malformed-output, cross-customer and deoptimization checks.
4. **Approve version** binds approval to the exact digest and deploys it as the active version.
5. **Dispatcher** runs a task. `C-101` and `C-202` take the compiled path with **zero model invocations**; `C-404` is outside the compiled input class, so execution deoptimizes to a checkpoint and no partial result is returned. **Record recovery** closes the handoff as exception evidence.

The same flow over the API:

```sh
POST /api/v2/traces                     # ingest a structured trace
POST /api/v2/compile                    # traces -> candidate artifact
GET  /api/v2/capabilities/:id/ir        # the plan that actually executes
POST /api/v2/capabilities/:id/verify
POST /api/v2/capabilities/:id/approve
POST /api/v2/tasks/dispatch             # guards -> compiled or agent fallback
GET  /api/v2/runs/:id
POST /api/v2/runs/:id/recover
GET  /api/v2/profiles/:name
```

Mutations require the `X-Foundry-Client: local-ui` header, as elsewhere in the local API. The recorded LLM and token counts on the sample traces are fixtures describing the agent path; they are not a controlled benchmark against the compiled path. Checkpoint recovery is recorded, not replayed: the runtime does not yet resume a compiled plan after a handoff, and no capability writes to an external system.

## Coding task deployment

1. Run a task in **Agent chat**, then choose **Prepare deployment**.
2. In **Registry → Coding task registry**, select sandbox permissions, timeout, output limits, and at least one result assertion. Saving changes creates a new draft version.
3. Run security checks. Assertions check the recorded output and current workspace files.
4. Review the results and approve the version. **Deploy and measure** launches the approved replay and repeats the assertions on its result. Only a successful replay with passing assertions becomes active in the registry.
5. Revoke a version to disable future execution. File changes require manual restoration from version control or backups.

Existing chat deployments are imported as draft registry entries on startup. They retain their history but need verification before another execution. Registry records prevent deletion of their source chat history.

## Checks and development

```sh
npm test                 # Unit, failure, compiler, runtime and differential tests
npm run test:integration # API lifecycle, policy and deployment tests
npm run eval             # Demo regression suite plus compiled-capability verification and dispatch
npm run lint             # Type checking and formatting
npm run build            # Type checking and production frontend
npx playwright install chromium
npm run test:e2e          # Run after build; isolated in-memory DB and simulated CLI
```

Equivalent root `make` targets are available. Backend services are in `src/service.ts` and `src/registry/`; verification is in `src/verification/`; the provider adapter is in `src/agent/`; React UI is in `src/web/`.

The compiler lives in `src/compiler/`, the IR interpreter and guarded dispatcher in `src/runtime/`, and structured trace capture in `src/exploration/`.

See [ADR 0001](docs/adr/0001-compiled-read-capability.md) for why traces compile to a guarded IR rather than to generated source, and [the design notes](docs/agent-jit-design-notes.md) for the wider plan and what remains unbuilt. See [coding task security](docs/coding-task-security.md) for enforcement boundaries and extension points. See [raw agent failures to branchAnalysis](docs/branch-analysis.md) for the short note on how failed and abandoned raw events are pruned into provenance.
