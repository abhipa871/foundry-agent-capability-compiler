import { DomainError } from '../../domain.js';

export type Scheduled = { levels: string[][]; concurrency: number; optimizations: string[] };

// Dependency-aware scheduling: nodes at the same topological depth have no value dependency on
// each other, so they may run concurrently. The concurrency limit is capped by the IR schema and
// by the adapters' rate-limit contract, never by how the agent happened to sequence its calls.
export function schedule(nodes: { id: string; deps: string[] }[], maxConcurrency = 3): Scheduled {
  const levels: string[][] = [];
  const done = new Set<string>();
  while (done.size < nodes.length) {
    const ready = nodes
      .filter((node) => !done.has(node.id) && node.deps.every((dep) => done.has(dep)))
      .map((node) => node.id);
    if (!ready.length) throw new DomainError('Cannot schedule a cyclic plan.', 409);
    ready.forEach((id) => done.add(id));
    levels.push(ready);
  }
  const widest = Math.max(...levels.map((level) => level.length));
  const concurrency = Math.min(maxConcurrency, Math.max(1, widest));
  return {
    levels,
    concurrency,
    optimizations:
      widest > 1
        ? [
            `parallelized ${widest} independent reads at depth ${levels.findIndex((level) => level.length === widest)} (concurrency limit ${concurrency})`,
          ]
        : ['no independent reads to parallelize; sequential plan'],
  };
}
