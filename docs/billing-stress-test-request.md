# CODEX IMPLEMENTATION PROMPT 1

## Foundry SDK Stress Test — Enterprise Billing Investigation

You are working inside the existing Foundry repository.

Implement the following benchmark exactly as specified. The test scenario has already been designed externally using regular ChatGPT. **Do not use Codex to generate, redesign, simplify, or substitute stress-test scenarios.** Your responsibility is to implement, execute, and evaluate the supplied scenario.

### 1. Objective

Prove whether Foundry can automatically compile, validate, and deploy reusable API workflows so that the same Gemini Flash agent completes a complex enterprise billing investigation with lower total inference usage while preserving correctness, authorization, and data freshness.

Implement this in the existing SDK, test harness, and dashboard. Do not create a parallel benchmark architecture if an existing one can be extended.

### 2. Model and execution configuration

- Load the Gemini API key from `GEMINI_API_KEY`.
- Verify the actual Gemini Flash model ID available to the project. Do not assume that `gemini-3.8-flash` exists without confirmation.
- Configure baseline and optimized executions to use the identical model ID, temperature, tool behavior, token limits, and applicable inference settings.
- Use a deterministic seeded mock API environment.
- No real Salesforce, Stripe, billing, payment, or CRM credentials should be required.
- Do not use Codex itself as the benchmark's agent model.
- Do not expose API keys in frontend code, logs, or benchmark reports.

### 3. Exact agent task

Provide this exact instruction to the benchmark agent in both baseline and optimized runs:

> Investigate the billing dispute for customer CUST-1042 covering August 1 through October 31, 2026. Retrieve the customer's account, subscriptions, invoices, payments, contracts, and support records. Identify duplicate payments, unauthorized subscription charges, and legitimate charges. Apply the refund policy, issue only authorized refunds, escalate exceptions requiring approval, update the support ticket, and prepare an itemized resolution with an audit trail. Never refund a legitimate charge or issue duplicate refunds.

The agent must complete the entire task. Do not shorten the task in the optimized run.

### 4. Implement simulated API services

Provide stateful API-backed tool contracts using the project's existing API tool registration conventions.

CRM:

- `get_customer(customer_id)`
- `get_account_history(customer_id)`

Subscriptions:

- `list_subscriptions(customer_id)`
- `get_plan_changes(subscription_id)`

Billing:

- `list_invoices(customer_id, cursor, limit)`
- `get_invoice_items(invoice_id)`

Payments:

- `list_payments(customer_id, cursor, limit)`
- `get_payment_details(payment_id)`

Contracts:

- `get_contract(customer_id)`
- `get_refund_policy(contract_id)`

Refunds:

- `create_refund(payment_id, amount, reason, idempotency_key, authorization_context)`
- `get_refund_status(refund_id)`

Support:

- `get_tickets(customer_id)`
- `update_ticket(ticket_id, resolution, status)`

Audit:

- `create_audit_entry(entity_id, action, evidence, timestamp)`

Use realistic API request and response schemas. Include stable record IDs, currency, timestamps, authorization fields, pagination metadata, and explicit error responses.

### 5. Fixed benchmark dataset

Seed the following synthetic state:

- Customer ID: CUST-1042.
- Three subscriptions.
- Twelve invoices dated across August–October 2026.
- Eighteen payment records.
- One duplicated $120 payment, represented by separate payment IDs linked to the same underlying invoice obligation.
- One unauthorized $80 add-on charge occurring after a recorded cancellation.
- One separate legitimate $200 charge that must remain unchanged.
- One older disputed charge outside the automatic refund window, requiring escalation.
- One open billing dispute support ticket.
- Contract and policy records supporting refund of the duplicate $120 and unauthorized $80, but not permitting automatic refund of the older charge.

Create coherent remaining records so all seeded totals, invoice/payment associations, and policy results are internally consistent.

The required authorized refund total is exactly $200, consisting of $120 plus $80.

### 6. Stress conditions

Implement deterministic variants covering:

- Normal completion.
- A transient payment lookup HTTP 500.
- A paginated invoice or payment response.
- A stale subscription status that requires refresh.
- A duplicate refund request using the same idempotency key.
- An unauthorized attempt to refund the older disputed charge.
- A tool timeout with safe retry behavior.

Every variant must have a known expected final state.

Do not make an unsafe action succeed merely because it was invoked by a compiled tool.

### 7. Baseline execution

Run Gemini against the original API tools.

Capture:

- All model requests and responses.
- Model input, output, and cached token usage where supplied.
- Each tool call and tool result.
- Execution timestamps and duration.
- Retries, errors, and fallbacks.
- Final resolution and mutated API state.

Store the complete execution trace in the existing benchmark artifact format or a compatible structured JSON format.

### 8. Foundry compilation and deployment

Pass the original tool definitions and relevant baseline trace data through Foundry's existing SDK.

Foundry should discover which repeated API operations are suitable for compilation.

Potential opportunities include customer-context retrieval, invoice/payment aggregation, subscription-change lookup, and policy retrieval.

These are candidates, not mandatory handwritten implementations.

Requirements:

- Use Foundry's real compiler.
- Do not manually hardcode a combined optimized billing function.
- Validate compiled tools against their source API behavior.
- Preserve API authorization, freshness, idempotency, and error handling.
- Deploy compiled capabilities through the actual SDK deployment mechanism.
- Record compiled tool IDs, versions, validation results, and deployment status.
- If the compiler cannot support the workflow, record that limitation rather than simulating success.

### 9. Optimized execution

Reset the mock environment to an identical starting snapshot.

Run the identical agent task using the identical Gemini model configuration.

Expose the deployed Foundry capabilities as callable agent tools and retain the original tools needed for unsupported branches or safe fallbacks.

Capture the same telemetry as the baseline.

Do not use a precomputed final answer or change the task prompt to encourage fewer steps.

### 10. UI/UX requirements

Extend the existing Foundry interface to support:

1. Select Enterprise Billing Investigation.
2. View registered simulated APIs.
3. Run Baseline.
4. Inspect the baseline execution trace.
5. Compile API workflows.
6. View compilation and validation results.
7. Deploy approved compiled tools.
8. Run Optimized.
9. View correctness, token, cost, and latency comparisons.
10. Inspect fallback and authorization events.

The UI must call the same services used by the SDK. No frontend-only mock deployment or fake benchmark values are permitted.

### 11. Deterministic correctness checks

A run passes only if:

- Exactly two authorized refunds are created, totaling $200.
- The legitimate $200 charge is not refunded.
- The older disputed charge is escalated, not automatically refunded.
- No duplicate refund is created.
- The support ticket contains a correct itemized resolution.
- Refunds and decisions have audit records.
- All API mutations satisfy policy and authorization checks.

### 12. Measurement and acceptance

Run at least five paired baseline/optimized trials for each variant, resetting state between runs. Use matched seeds and fault schedules.

Report:

- Task success rate.
- Input/output/cached tokens.
- Total model calls.
- Total tool calls.
- End-to-end execution time.
- Actual inference cost where pricing is configured.
- Compilation/deployment time and overhead.
- Tool error and retry rates.
- Authorization or correctness violations.
- Percentage token and cost reduction.

Success requires equivalent correctness with measurable, reproducible usage reduction. A target of at least 50% fewer inference tokens may be used as a stretch goal, not as a fabricated result or mandatory reason to change test conditions.

### 13. Deliverables

- Working mock APIs and fixture dataset.
- Reproducible benchmark runner.
- SDK compile/validate/deploy integration.
- UI functionality backed by the SDK.
- Correctness assertions and automated tests.
- Saved baseline and optimized traces.
- A final comparison report.
- Documented commands for reproducing the experiment.

Inspect the repository first, reuse existing infrastructure, and preserve current working functionality. Implement and run the test, reporting any actual limitations or failed requirements.
