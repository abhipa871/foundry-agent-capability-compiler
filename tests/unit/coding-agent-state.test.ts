import { describe, expect, it } from 'vitest';
import type { CodingAgentEvent, CodingAgentSession } from '../../src/domain.js';
import { Foundry } from '../../src/service.js';
import { Store } from '../../src/registry/store.js';

function event(id: string, parentId?: string): CodingAgentEvent {
  return {
    id,
    parentId,
    operation: id.startsWith('task') ? 'task.received' : id.startsWith('exec') ? 'codex.exec' : id,
    status: 'success',
    transport: 'cli',
    description: id,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
}

describe('coding-agent state normalization', () => {
  it('repairs old branch analyses whose final exec parent was truncated away', () => {
    const store = new Store(':memory:');
    try {
      const events = [
        event('task.received-old'),
        ...Array.from({ length: 20 }, (_, index) =>
          event(
            `codex.event-${index + 1}`,
            index === 0 ? 'task.received-old' : `codex.event-${index}`,
          ),
        ),
        event('exec-old', 'codex.event-21'),
      ];
      const session: CodingAgentSession = {
        id: 'session-old',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        task: 'Repair an old coding-agent branch analysis.',
        status: 'success',
        provider: {
          id: 'codex-cli-gpt-5-5-high',
          label: 'Legacy provider label',
          kind: 'codex-cli',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          enabled: true,
          note: 'legacy',
        },
        messages: [],
        events,
        finalEventId: 'exec-old',
        branchAnalysis: {
          rawEventCount: 22,
          keptEventIds: ['exec-old'],
          discarded: events.slice(0, -1).map((oldEvent) => ({
            eventId: oldEvent.id,
            operation: oldEvent.operation,
            status: oldEvent.status,
            reason: 'non_causal_success',
            description: oldEvent.description,
          })),
          strategy: 'lineage',
        },
        usageBefore: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true },
        lastOutput: 'done',
      };

      store.put('agentSession', session);

      const normalized = new Foundry(store).state().agentSessions[0];

      expect(normalized.branchAnalysis.keptEventIds).toEqual(events.map((oldEvent) => oldEvent.id));
      expect(normalized.branchAnalysis.discarded).toHaveLength(0);
      expect(normalized.events.at(-1)?.parentId).toBe('codex.event-20');

      // Failed ancestors are context for traversal, never executable successful steps.
      session.events[1].status = 'failed';
      store.put('agentSession', session);
      const pruned = new Foundry(store).state().agentSessions[0];
      expect(pruned.branchAnalysis.keptEventIds).not.toContain(session.events[1].id);
      expect(pruned.branchAnalysis.discarded[0].reason).toBe('failed_tool');

      // Corrupt legacy parent cycles must not hang state reads.
      session.events.at(-1)!.parentId = session.events.at(-1)!.id;
      store.put('agentSession', session);
      expect(new Foundry(store).state().agentSessions[0].branchAnalysis.keptEventIds).toEqual([
        'exec-old',
      ]);
    } finally {
      store.close();
    }
  });
});
