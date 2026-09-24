import { randomUUID } from 'node:crypto';
import {
  DomainError,
  operations,
  rawAgentTrajectorySchema,
  trajectorySchema,
  type BranchAnalysis,
  type DiscardedBranch,
  type Operation,
  type RawAgentEvent,
  type RawAgentTrajectory,
  type Trajectory,
  type TrajectoryDraft,
} from '../domain.js';

export const sampleTrajectory: TrajectoryDraft = {
  name: 'handle_late_shipments',
  task: 'Find customers whose shipments are more than five days late, give them a $20 credit, update Salesforce, and notify their account managers.',
  model: 'Recorded demo agent',
  success: true,
  inputs: { delay_days: 5, credit_amount: 20 },
  durationMs: 48200,
  steps: [
    {
      operation: 'shipments.list',
      transport: 'browser',
      description: 'Filter the shipping portal for eligible delayed shipments.',
    },
    {
      operation: 'credits.issue',
      transport: 'browser',
      description: 'Issue a service recovery credit to each eligible customer.',
    },
    {
      operation: 'crm.update',
      transport: 'browser',
      description: 'Record the resolution on the customer account.',
    },
    {
      operation: 'notifications.send',
      transport: 'api',
      description: 'Notify each account manager with the credit details.',
    },
  ],
};

export const sampleRawAgentTrajectory: RawAgentTrajectory = {
  name: 'handle_late_shipments',
  task: 'Find customers whose shipments are more than five days late, give them a $20 credit, update Salesforce, and notify their account managers.',
  model: 'Recorded demo agent with retries',
  success: true,
  inputs: { delay_days: 5, credit_amount: 20 },
  durationMs: 61200,
  finalEventId: 'notify_success',
  events: [
    {
      id: 'portal_search_failed',
      operation: 'legacy_shipping.search',
      transport: 'browser',
      status: 'failed',
      description: 'Tried the legacy shipping portal search first.',
      error: 'Portal returned no exportable rows.',
    },
    {
      id: 'shipments_success',
      parentId: 'portal_search_failed',
      operation: 'shipments.list',
      transport: 'api',
      status: 'success',
      description: 'Loaded eligible delayed shipments from the shipping API.',
    },
    {
      id: 'spreadsheet_branch',
      parentId: 'portal_search_failed',
      operation: 'sheets.lookup_customer_credits',
      transport: 'tool',
      status: 'failed',
      description: 'Checked a spreadsheet branch for existing credits.',
      error: 'Sheet was stale and missing current account owners.',
    },
    {
      id: 'credit_declined',
      parentId: 'shipments_success',
      operation: 'credits.preview',
      transport: 'api',
      status: 'failed',
      description: 'Previewed the wrong credit product.',
      error: 'Credit product was not service-recovery eligible.',
    },
    {
      id: 'credit_success',
      parentId: 'shipments_success',
      operation: 'credits.issue',
      transport: 'api',
      status: 'success',
      description: 'Issued service recovery credits through the credit ledger.',
    },
    {
      id: 'crm_wrong_tool',
      parentId: 'credit_success',
      operation: 'crm.bulk_note',
      transport: 'browser',
      status: 'failed',
      description: 'Tried a bulk note path before finding the account update API.',
      error: 'Bulk note endpoint rejected account identifiers.',
    },
    {
      id: 'crm_success',
      parentId: 'crm_wrong_tool',
      operation: 'crm.update',
      transport: 'api',
      status: 'success',
      description: 'Updated each customer account with the recovery resolution.',
    },
    {
      id: 'notify_success',
      parentId: 'crm_success',
      operation: 'notifications.send',
      transport: 'api',
      status: 'success',
      description: 'Sent account-manager notifications with credit details.',
    },
  ],
};

export function capture(value: unknown, source: Trajectory['source']): Trajectory {
  const draft = trajectorySchema.parse(value);
  if (draft.steps.some((step, i) => step.operation !== operations[i])) {
    throw new DomainError(
      'Unsupported trajectory: expected shipments.list -> credits.issue -> crm.update -> notifications.send.',
    );
  }
  return { ...draft, id: randomUUID(), createdAt: new Date().toISOString(), source };
}

export function captureRaw(value: unknown, source: Trajectory['source']): Trajectory {
  const raw = rawAgentTrajectorySchema.parse(value);
  const { kept, analysis } = pruneAgenticBranches(raw);
  const draft: TrajectoryDraft = {
    name: raw.name,
    task: raw.task,
    model: raw.model,
    success: raw.success,
    inputs: raw.inputs,
    durationMs: raw.durationMs,
    steps: kept.map((event) => ({
      operation: event.operation as Operation,
      transport: event.transport === 'api' ? 'api' : 'browser',
      description: event.description,
    })),
  };
  return { ...capture(draft, source), branchAnalysis: analysis };
}

export function pruneAgenticBranches(raw: RawAgentTrajectory): {
  kept: RawAgentEvent[];
  analysis: BranchAnalysis;
} {
  const eventsById = new Map<string, RawAgentEvent>();
  for (const event of raw.events) {
    if (eventsById.has(event.id)) throw new DomainError(`Duplicate raw event id: ${event.id}.`);
    eventsById.set(event.id, event);
  }
  for (const event of raw.events) {
    if (event.parentId && !eventsById.has(event.parentId)) {
      throw new DomainError(`Raw event ${event.id} references missing parent ${event.parentId}.`);
    }
  }
  const lineageIds = raw.finalEventId ? lineageFor(raw.finalEventId, eventsById) : undefined;
  const candidates = raw.events.filter((event) => !lineageIds || lineageIds.has(event.id));
  const kept = selectSuccessfulPath(candidates);
  const keptIds = new Set(kept.map((event) => event.id));
  const candidateIds = new Set(candidates.map((event) => event.id));
  const discarded = raw.events
    .filter((event) => !keptIds.has(event.id))
    .map((event) => discardReason(event, candidateIds))
    .filter((event): event is DiscardedBranch => event !== undefined);
  if (kept.length !== operations.length) {
    throw new DomainError(
      'Raw trajectory did not contain a complete successful causal path for the supported capability.',
    );
  }
  return {
    kept,
    analysis: {
      rawEventCount: raw.events.length,
      keptEventIds: kept.map((event) => event.id),
      discarded,
      strategy: lineageIds ? 'lineage' : 'ordered_success_scan',
    },
  };
}

function lineageFor(finalEventId: string, eventsById: Map<string, RawAgentEvent>): Set<string> {
  const lineage = new Set<string>();
  let cursor = eventsById.get(finalEventId);
  if (!cursor)
    throw new DomainError(`finalEventId ${finalEventId} was not found in the raw event log.`);
  while (cursor) {
    if (lineage.has(cursor.id))
      throw new DomainError(`Cycle detected while tracing raw event ${cursor.id}.`);
    lineage.add(cursor.id);
    cursor = cursor.parentId ? eventsById.get(cursor.parentId) : undefined;
  }
  return lineage;
}

function selectSuccessfulPath(events: RawAgentEvent[]): RawAgentEvent[] {
  const kept: RawAgentEvent[] = [];
  let expected = 0;
  for (const event of events) {
    if (event.status !== 'success') continue;
    if (event.operation === operations[expected]) {
      kept.push(event);
      expected += 1;
    }
  }
  return kept;
}

function discardReason(
  event: RawAgentEvent,
  candidateIds: Set<string>,
): DiscardedBranch | undefined {
  const base = {
    eventId: event.id,
    operation: event.operation,
    status: event.status,
    description: event.description,
    error: event.error,
  };
  if (!candidateIds.has(event.id)) return { ...base, reason: 'abandoned_branch' };
  if (event.status === 'failed') return { ...base, reason: 'failed_tool' };
  if (event.status === 'skipped') return { ...base, reason: 'skipped_tool' };
  if (!operations.includes(event.operation as Operation))
    return { ...base, reason: 'unsupported_success' };
  return { ...base, reason: 'non_causal_success' };
}
