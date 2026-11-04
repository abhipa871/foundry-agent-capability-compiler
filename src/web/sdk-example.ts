export const generalSdkExample = `// Node.js 24+ application code. Keep credentials on your server.
import { FoundryClient, TaskObserver, selectTaskExecution }
  from '@foundry/read-runtime';

// Register matching trusted task/tool contracts in your app and control plane.
const client = new FoundryClient({
  registry: yourContractRegistry,
  context: authorizedRuntimeContext,
  endpoint: process.env.FOUNDRY_ENDPOINT,
  apiKey: process.env.FOUNDRY_API_KEY,
  trustedPublicKey: pinnedPublicKey,
});

// Capture two distinct inputs with explicit input/result provenance.
const uploaded = await Promise.all(
  [traceA, traceB].map(trace => client.observe(trace)),
);
const draft = await client.compile(capabilityName, uploaded.map(t => t.id));
const verified = await client.verify(draft.id);
if (verified.status !== 'verified') throw new Error('Verification failed');
for (const input of authorizedShadowInputs) {
  const shadow = await client.shadow(draft.id, input);
  if (shadow.status !== 'match') throw new Error('Shadow mismatch');
}
// Explicit application review and authorized approval, then deployment.
await client.approve(draft.id);
await client.deploy(draft.id);

const artifact = await client.capability(capabilityName);
const selection = selectTaskExecution({
  registry: yourContractRegistry,
  context: authorizedRuntimeContext(), artifact,
  kind: taskKind, input, requirement: 'known', requiredTools,
});
if (selection.mode === 'denied') throw new Error('Access denied');
if (selection.mode === 'normal') return yourOriginalAgent({ input });
// Your app applies the placement: prefetch, agent tool, or original agent.
const run = await client.execute({ name: capabilityName, kind: taskKind, input });
if (run.outcome === 'denied') throw new Error('Access denied');
if (run.outcome === 'unresolved') return yourOriginalAgent(run.checkpoint);
return yourAgentWithContext(run.result);

// Revoke when this version should no longer be offered:
// await client.revoke(draft.id);`;
