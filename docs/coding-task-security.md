# Coding task security

The coding registry stores immutable task/policy snapshots with SHA-256 digests. This detects accidental or API-level drift; it is not a signature protecting against someone who can rewrite the database or server. Policy changes create draft versions. Verification and approval bind to the artifact digest; verification expires after one hour. Approval never executes a task.

## Enforced layers

- Strict request schemas reject unknown fields, arbitrary command assertions, full-access sandbox modes, network enablement, and unbounded runtime/output settings.
- Read-only is the default. Operators can opt into workspace writes. The CLI receives the approved sandbox, network-disabled shell configuration, no extra writable roots, and disabled web search. User CLI configuration and exec rules are ignored for replay; approval prompts remain `never`.
- Execution uses separate process arguments and stdin, never shell interpolation. Output and runtime limits terminate the invocation. Windows uses process-tree termination. Concurrent chat/replay executions are blocked within this server process.
- Failed/skipped events are excluded from replay context. JSON event classification checks actual tool exit codes. A successful CLI exit alone does not establish task correctness.
- At least one task assertion is required. File assertions reject traversal, absolute paths, symbolic links, sensitive paths and files over 1 MB. Output assertions use literal text, not executable expressions. They run before approval/deployment and after replay.
- Failed invocations or postconditions are recorded, never promoted, and require re-verification and approval. A failed new version leaves a previous active version unchanged. No automatic retries are performed because coding operations can leave partial writes.
- Local mutation endpoints require the existing loopback host/origin checks and client header. Registry lifecycle actions, verification, and executions are audited.

## Limits

Codex replay is model-driven and continues consuming tokens. It is not a deterministic compiled program. The separate shipment demo uses the constrained deterministic interpreter. Assertions provide explicit result evidence but do not replace project unit/integration tests, code review, or proof of correctness.

Sandbox checks in the registry verify invocation configuration; they do not perform adversarial OS isolation testing. Codex still needs provider connectivity. CLI sandbox behavior follows the installed CLI and operating system; this MVP is a trusted single-user local application, not a multi-tenant execution service. Workspace-write replay can alter application code. Do not expose the server publicly or use an untrusted shared workspace. There is no automatic compensation for filesystem changes or hard token-budget enforcement.

The network/sandbox settings follow the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Runtime flags were checked against the installed `codex exec --help`.

## Adding layers

Extend `codingPolicySchema` in `src/domain.ts`, enforce the setting in the adapter or verification layer, and add failure tests before exposing it in `CodingRegistryPanel.tsx`. Add assertion variants to `codingAssertionSchema` and `assertionChecks`; never evaluate user-provided code as a test. Future CI/test-runner integrations should use server-owned command allowlists and isolated workspaces. Future hosted deployment needs authenticated identities, separate approval roles, durable workspace locks, isolated workers and protected audit storage.
