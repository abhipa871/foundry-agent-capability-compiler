# General task compiler console

Run `npm run dev`, then open **Developer console**. The main compiler uses `/api/v2/tasks`, the
same lifecycle as the general Node SDK. It discovers tasks and tools from the server registry;
task names, input fields, scopes and operation counts are not embedded in the UI.

1. **Evidence:** select a registered task. Import JSON trajectories captured with `TaskObserver`,
   or load synthetic fixture evidence in the default local demo. Select at least two trajectories
   with distinct inputs and compatible provenance, choose a capability name, and compile.
2. **Review:** inspect the artifact digest, pinned contracts and argument bindings. Verify the
   exact candidate, inspect every check, then compare distinct inputs with the trusted native
   callback. Three distinct matches are required by default, with no failed comparisons for the
   current verification stamp and access context. Local examples provide three inputs.
3. Check the review acknowledgment and **Approve version**. Approval and **Deploy version** are
   separate actions. Deployment stays blocked until the shadow gate passes. Deployment activates
   one version per capability name for the current tenant and principal.
4. **Run:** use schema-generated fields, an example input or the full JSON editor. Run the deployed
   tool and inspect the actual outcome, tool count, zero-model-call compiled execution and output
   or checkpoint. A denial never invokes an automatic agent fallback. **Revoke version** blocks
   future deployment execution. Reverification also removes an active deployment and requires
   fresh shadow evidence.
5. **Capabilities** opens the generic version registry. Inspect an existing version to return to
   its digest and verification state. Navigation preserves compiler inputs and benchmark drafts.

The SDK example is available inside the console and under **API & SDK**. The supported lifecycle
methods are `observe`, `compile`, `verify`, `shadow`, `approve`, `deploy`, `revoke`, `capabilities`,
`capability` and `execute`; see [the SDK guide](general-sdk.md).

## Registering your own task

Set `FOUNDRY_TASK_MODULE` to an operator-owned module exporting `createTaskOptions()`. Register
tool and task contracts, input/output schemas, access rules, trusted handlers, independent sandbox
cases and a native comparison callback. The console discovers the new catalog after restart.
`context(kind)` may return task-specific policy, scopes and snapshot settings. Request JSON and
model output cannot install handlers or supply native baseline results. The current runtime
supports bounded read/pure DAGs; external writes, arbitrary code, inferred loops/branches and
checkpoint resumption remain unsupported.

Local custom modules run as the local operator with scopes from their trusted registered tools.
Return a matching identity from `context(kind)` (or derive it from `currentIdentity()`). Hosted
mode always uses authenticated identities and their configured scopes instead.

Default local mode includes `travel_day` (13 operations) and `personal_departure`. These use
synthetic server-owned data. Fixture capture is labeled in the UI and trace summaries, calls no
model, and is not a token benchmark. It is unavailable when authentication is configured or a
custom module replaces the default demo. Hosted mode retains authenticated APIs and SDK access;
this browser UI does not provide a hosted login or key-entry flow. Credentials remain server-side.

The CRM compiler is retained under **Legacy CRM compiler**. The older shipping/coding registry
is under **More tools → Legacy capability registry**; it is separate from generic capability
versions and uses its original lifecycle.
