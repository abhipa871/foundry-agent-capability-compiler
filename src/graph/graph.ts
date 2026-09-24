import type { Capability, CodingCapability, GraphNode, State } from '../domain.js';

export function buildGraph(
  capabilities: Capability[],
  deployed: Record<string, string>,
  codingCapabilities: CodingCapability[] = [],
): State['graph'] {
  const nodes: GraphNode[] = [];
  const edges: State['graph']['edges'] = [];
  const codingNames = new Set(codingCapabilities.map((cap) => cap.name));
  if (codingNames.size)
    nodes.push({
      id: 'codex-cli',
      label: 'Codex CLI replay',
      kind: 'system',
      status: 'Model-driven',
    });
  for (const name of codingNames) {
    const versions = codingCapabilities
      .filter((cap) => cap.name === name)
      .sort((a, b) => b.version - a.version);
    const shown = versions.find((cap) => deployed[name] === cap.id) ?? versions[0];
    nodes.push({
      id: shown.id,
      label: shown.task.slice(0, 48),
      kind: 'capability',
      status: deployed[name] === shown.id ? `Deployed v${shown.version}` : shown.status,
    });
    nodes.push({
      id: `policy-${shown.id}`,
      label: `${shown.policy.sandbox}; ${shown.policy.assertions.length} assertions`,
      kind: 'policy',
      status: 'Checked before execution',
    });
    edges.push({ from: `policy-${shown.id}`, to: shown.id }, { from: shown.id, to: 'codex-cli' });
  }
  if (!capabilities.length) return { nodes, edges };
  const systems = [
    ['shipments', 'Shipment portal'],
    ['credits', 'Credit ledger'],
    ['crm', 'Salesforce demo'],
    ['notifications', 'Notification outbox'],
  ];
  for (const [id, label] of systems)
    nodes.push({ id, label, kind: 'system', status: 'local adapter' });
  const latest = new Map<string, Capability>();
  for (const cap of [...capabilities].sort((a, b) => b.version - a.version))
    if (!latest.has(cap.name)) latest.set(cap.name, cap);
  for (const cap of latest.values()) {
    const active = capabilities.find((c) => c.id === deployed[cap.name]);
    const shown = active ?? cap;
    nodes.push({
      id: shown.id,
      label: shown.name,
      kind: 'capability',
      status: active ? `Live · v${active.version}` : shown.status,
    });
    nodes.push({
      id: `policy-${shown.id}`,
      label: `$${shown.policy.maxCredit}/customer · $${shown.policy.maxTotal}/run`,
      kind: 'policy',
      status: 'Enforced at runtime',
    });
    edges.push({ from: `policy-${shown.id}`, to: shown.id });
    systems.forEach(([id]) => edges.push({ from: shown.id, to: id }));
  }
  return { nodes, edges };
}
