import { DomainError } from '../domain.js';
import type { StoredToolTrace } from '../exploration/tool-events.js';
import { contracts } from '../runtime/adapters/registry.js';
import type { ReadOperation } from '../compiler/ir.js';

export function validateEvidence(trace: StoredToolTrace) {
  for (const event of trace.events) {
    if (event.status !== 'success' || !(event.operation in contracts)) continue;
    const contract = contracts[event.operation as ReadOperation];
    const arg = event.args.customerId;
    const output = contract.output.parse(event.result?.projection);
    if (
      event.effect !== 'read' ||
      event.writes.length ||
      event.adapterVersion !== contract.version ||
      event.result?.schemaId !== contract.schemaId ||
      !event.credentialScopeIds.includes(contract.scope) ||
      event.policyVersion !== trace.policyVersion ||
      (event.principalId && event.principalId !== trace.principalId) ||
      output.customerId !== trace.taskInput.customerId ||
      output.tenantId !== trace.tenantId ||
      output.snapshot !== trace.snapshot ||
      !arg ||
      arg.value !== output.customerId
    )
      throw new DomainError('Read evidence diverged from its adapter contract or identity.', 409);
    if (arg.source === 'task_input' && arg.value !== trace.taskInput.customerId)
      throw new DomainError('Task input lineage diverged.', 409);
    if (arg.source === 'event_output') {
      const producer = trace.events.find((entry) => entry.eventId === arg.ref.producerEventId);
      if (
        producer?.status !== 'success' ||
        !producer.result ||
        (producer.result.projection as { customerId?: string }).customerId !== arg.value
      )
        throw new DomainError('Recorded producer value diverged from reference lineage.', 409);
    }
  }
}
