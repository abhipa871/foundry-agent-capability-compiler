# Customer SDK integration

The supported optimization is `customer_context` / `load_customer_context(customerId)`, using
three read contracts over `fixtures-v1`. This implementation is ready for local integration and
review. Production CRM/order/payment connectors and a live agent benchmark are still required.
The existing local UI keeps its sample compile/verify/approve flow. New pattern, routing, shadow,
health and maintenance operations are available through the v2 API; there is no new hosted UI.

Build the Node.js 24 SDK with `npm run build:sdk`. The private package in `dist-sdk` exports
`FoundryClient`, `TrajectoryObserver` and public integration types. It contains the constrained
interpreter, schemas and observation wrappers. It excludes matching, candidate compilation,
registry policy, validation intelligence and private signing keys. It is not published.

```ts
import { FoundryClient } from './dist-sdk/integration/client.js';

const client = new FoundryClient({
  tenantId: 'customer-a',
  principalId: 'support-agent',
  agentId: 'support-assistant',
  endpoint: 'https://optimization.example.com',
  apiKey: process.env.FOUNDRY_API_KEY!,
  trustedPublicKey: pinnedEd25519PublicKeyPem,
  context: authorizedRuntimeContext,
  adapters: customerOwnedReadAdapters,
  native: async (request, checkpoint, observer) => {
    // Attach observer.read to existing tools, and observer.modelCall to model calls.
    // The callback runs the existing agent and returns its actual result and reported usage.
    return runExistingAgent(request, checkpoint, observer);
  },
  shareReplayEvidence: false,
});
const run = await client.execute({
  kind: 'customer_context',
  input: { customerId: 'C-101' },
});
```

`authorizedRuntimeContext` must come from the application's authentication and record policy,
with current tool scopes, allowed customer IDs, trusted snapshot/freshness metadata and adapter
versions. Never derive it from a task prompt or capability payload. `customerOwnedReadAdapters`
is an allowlisted operation dispatcher that keeps provider credentials locally and honors
cancellation. A native callback may use the deoptimization checkpoint for context but must rerun
under the original authorization; checkpoints do not resume compiled execution automatically.

`observer.read` requires declared task-input or event-output expressions. For example, pass
`{ source: 'task_input', key: 'customerId' }` to the CRM read, then pass its `eventId` as the producer
of downstream reads. Equal strings do not establish dependencies. `observer.modelCall` accepts a
function returning `{ value, usage? }`; usage contains numeric input/output tokens and optionally
cached input tokens and cost USD. Missing usage remains unknown. Raw model messages, prompts,
credentials and private reasoning are never captured. Native results can report aggregate token
and model counts when not all model calls were wrapped. Failed unwrapped model usage stays null.
Tool calls do not prove underlying HTTP request counts; API counts remain unknown unless reported.

By default only normalized structure, timing, measurement origin and status reach the API.
Customer IDs, results, raw prompts and secrets stay local. Compilation requires explicit replay
opt-in for typed fixture read evidence. Full privacy mode exists on explicit trace import, but the
SDK always uses minimal mode. Disabling replay after candidate capture keeps subsequent business
values local. Telemetry failure does not fail customer work. Delivery is best effort and synchronous
with bounded waits; a durable queue is not implemented.

Authentication configuration is a strict JSON array of `{ sha256, identity }` records. Identity
contains tenant, principal, agent, permissions, tool scopes and authorized customer IDs. Hash a
random service credential outside the repository; do not put raw keys in config or source. The
SDK identity normally needs `read`, `invoke` and `observe`. Operators receive separate `compile`,
`verify`, `approve`, `deploy` and `admin` permissions. Tenant identity is taken only from the
credential configuration. Keys are rotated/revoked by replacing configuration and restarting.

Set `FOUNDRY_IDENTITY_CONFIG` to that private file and `FOUNDRY_SIGNING_KEY_FILE` to an Ed25519
PKCS#8 PEM file. Pin its SPKI public key in the customer SDK through a separate trusted channel.
Keep private keys outside version control with restricted file access. The server continues to
bind loopback; a production reverse proxy must terminate TLS, enforce body/connection limits and
isolate access. Signed offers expire within 60 seconds, bind tenant/principal and verify exact IR
integrity. The SDK fetches each offer rather than caching it. Already issued offers or in-flight
reads cannot be remotely erased; the lease bounds future reuse.

The operator lifecycle is:

| Operation                               | API                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Submit explicit replay evidence         | `POST /api/v2/traces`                                                                     |
| Observe without values                  | `POST /api/v2/telemetry`                                                                  |
| Analyze structural groups               | `POST /api/v2/patterns/analyze` with `{}`                                                 |
| Propose a draft                         | `POST /api/v2/patterns/:patternId/compile` with `{}`                                      |
| Validate exact candidate                | `POST /api/v2/capabilities/:id/verify` with `{}`                                          |
| Run native-authoritative shadow         | `POST /api/v2/artifacts/:id/shadow` with `{ "input": { "customerId": "C-101" } }`         |
| Inspect shadow coverage                 | `GET /api/v2/artifacts/:id/shadow`                                                        |
| Approve                                 | `POST /api/v2/capabilities/:id/approve` with `{ "note": "Reviewed read-only evidence." }` |
| Deploy separately outside local-demo    | `POST /api/v2/capabilities/:id/deploy` with `{}`                                          |
| Set tenant routing                      | `POST /api/v2/runtime/routing` with `{ "mode": "live", "rolloutPercent": 10 }`            |
| Download signed offer                   | `GET /api/v2/runtime/capability`                                                          |
| Inspect health                          | `GET /api/v2/capabilities/:id/health`                                                     |
| Quarantine / rollback / revalidate      | `POST /api/v2/capabilities/:id/{quarantine,rollback,revalidate}` with `{}`                |
| Enforce retention and validation expiry | `POST /api/v2/maintenance` with `{}`                                                      |
| Export / delete tenant data             | `GET /api/v2/export`, `DELETE /api/v2/data`                                               |

Routing defaults to observe with zero rollout. Shadow mode also needs explicit rollout. Live
routing requires current validation, server-recorded shadow coverage for C-101/C-202/C-303, approval,
deployment and healthy status. Reports sent by customer SDKs are untrusted: their matches cannot
promote a candidate. To establish trusted shadow evidence, inject the native agent and trusted
read adapters into `createApp`/`Foundry` runtime options. The standalone server does not invent a
native agent callback; without one, fallback is unresolved and shadow cannot pass. For this fixture
V1, validation uses the independent fixture oracle. Remote production shadow attestation and real
connector validation require a deployment-specific trusted integration.

For outages, malformed/expired signatures, zero rollout and unsafe optimization guards, the SDK
runs the native callback. Missing tool/record authorization denies both paths. Runtime read failure
emits a checkpoint then invokes the authorized native callback; its success, failure or unresolved
status is retained. There are no writes, retries of ambiguous writes, model-based routing or
automatic repair. Unknown task kinds pass through the native callback without customer-context
instrumentation.

Failures quarantine after three consecutive eligible errors; mismatch and adapter drift quarantine
immediately. Repeated latency over three times an established p95 (at least five samples and a 50 ms
floor) also quarantines. Only revalidation clears quarantine; hosted revalidation removes approval
and deployment, resets shadow coverage and requires fresh promotion. Operators must schedule
maintenance and revalidation: there is no scheduler daemon. Validation ages out after 24 hours;
trace, shadow, structural telemetry, run and checkpoint evidence has a seven-day expiry. SQLite
files use owner-only permissions. Encryption, backups and verified physical deletion are deployment
responsibilities; deleting rows does not erase copies or historical database pages.

`npm run analyze -- --demo` prints offline fixture pattern analysis. `npm run benchmark:optimization`
runs the complete SDK/API lifecycle and 30 alternating fixture replay pairs, with three warmup
pairs, producing `docs/optimization-benchmark.json`. It uses fake credentials, ephemeral signing
keys, a memory database and read fixtures. Its latency and call counts are measured; its model,
token and dollar savings are unknown. It makes no production or live-agent performance claim.
