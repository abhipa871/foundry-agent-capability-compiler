import { DomainError } from '../domain.js';
import type { StoredToolTrace } from '../exploration/tool-events.js';
import type { Expression } from './ir.js';
import type { PatternNode } from './patterns.js';

export type Binding = {
  arg: string;
  binding: 'input' | 'literal' | 'ref';
  evidence: string;
  expression: Expression;
};
export type BindContext = {
  idFor: (key: string) => string;
  traces: Map<string, StoredToolTrace>;
};

// A literal becomes a parameter only when the captured argument declares task-input lineage and
// its observed value equals that trace's task input in every supporting trace. Matching strings
// are not evidence on their own.
export function bindNode(node: PatternNode, ctx: BindContext): Binding[] {
  return Object.entries(node.args)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, arg]): Binding => {
      const observed = observedValues(node, name, ctx.traces);
      if (arg.source === 'event_output') {
        return {
          arg: name,
          binding: 'ref',
          evidence: `value flowed from ${arg.producerKey}.${arg.outputPath} in ${observed.length} captured call(s)`,
          expression: { kind: 'ref', node: ctx.idFor(arg.producerKey), path: arg.outputPath },
        };
      }
      const distinct = [...new Set(observed.map((entry) => entry.value))].sort();
      if (arg.source === 'task_input') {
        const mismatched = observed.filter((entry) => entry.value !== entry.taskInput);
        if (mismatched.length)
          throw new DomainError(
            `Argument ${name} of ${node.operation} claims task-input lineage but diverged from the task input.`,
            409,
          );
        const traceCount = new Set(observed.map((entry) => entry.traceId)).size;
        if (traceCount < 2)
          throw new DomainError(
            `Argument ${name} of ${node.operation} has task-input evidence from only one trace.`,
            409,
          );
        return {
          arg: name,
          binding: 'input',
          evidence: `tracked the task input across ${traceCount} traces (${distinct.join(', ')})`,
          expression: { kind: 'input', key: 'customerId' },
        };
      }
      if (distinct.length !== 1)
        throw new DomainError(
          `Argument ${name} of ${node.operation} varies without lineage evidence; it cannot be generalized.`,
          409,
        );
      return {
        arg: name,
        binding: 'literal',
        evidence: `constant in every supporting trace (${distinct[0]})`,
        expression: { kind: 'literal', value: distinct[0] },
      };
    });
}

function observedValues(node: PatternNode, arg: string, traces: Map<string, StoredToolTrace>) {
  return node.occurrences.flatMap((occurrence) => {
    const trace = traces.get(occurrence.traceId);
    if (!trace) throw new DomainError('Supporting trace is missing.', 409);
    return occurrence.eventIds.map((eventId) => {
      const event = trace.events.find((candidate) => candidate.eventId === eventId)!;
      return {
        traceId: trace.traceId,
        value: event.args[arg]?.value ?? '',
        taskInput: trace.taskInput.customerId,
      };
    });
  });
}
