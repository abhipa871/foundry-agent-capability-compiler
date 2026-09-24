import type { ObservableResult } from '../exploration/tool-events.js';

// Equivalence is judged on the normalized observable result, never on call order, latency or
// message wording. The recorded agent result is one input to that judgement, not the oracle:
// an agent can be wrong, so independently specified invariants are checked as well.
export function differences(compiled: ObservableResult, recorded: ObservableResult): string[] {
  return (Object.keys(recorded) as (keyof ObservableResult)[])
    .filter((key) => compiled[key] !== recorded[key])
    .map((key) => `${key}: compiled ${String(compiled[key])} vs recorded ${String(recorded[key])}`);
}

export function sameObservable(compiled: ObservableResult, recorded: ObservableResult): boolean {
  return differences(compiled, recorded).length === 0;
}
