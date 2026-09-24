import { describe, expect, it } from 'vitest';
import {
  agentProviders,
  buildCodexExecArgs,
  codexLaunch,
  eventsFromCodex,
} from '../../src/agent/codex.js';

describe('Codex CLI adapter arguments', () => {
  it('passes approval policy as a global option before exec', () => {
    const args = buildCodexExecArgs(agentProviders[0], 'C:/repo');

    expect(args.slice(0, 3)).toEqual(['--ask-for-approval', 'never', 'exec']);
    expect(args.indexOf('--ask-for-approval')).toBeLessThan(args.indexOf('exec'));
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('uses a non-shell launch target with args prefix support', () => {
    const original = process.env.FOUNDRY_CODEX_BIN;
    delete process.env.FOUNDRY_CODEX_BIN;
    try {
      const launch = codexLaunch();
      expect(launch.command.length).toBeGreaterThan(0);
      if (process.env.APPDATA) expect(launch.argsPrefix.join(' ')).toContain('codex.js');
    } finally {
      if (original === undefined) delete process.env.FOUNDRY_CODEX_BIN;
      else process.env.FOUNDRY_CODEX_BIN = original;
    }
  });

  it('keeps the causal lineage intact when Codex emits more events than the recorder stores', () => {
    const events = eventsFromCodex(
      Array.from({ length: 25 }, (_, index) => ({
        type: 'item.completed',
        message: `completed ${index + 1}`,
      })),
      new Date().toISOString(),
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      'success',
      '',
    );
    const byId = new Map(events.map((event) => [event.id, event]));
    const lineage = new Set<string>();
    let cursor = events.at(-1);

    while (cursor) {
      lineage.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }

    expect(events).toHaveLength(27);
    expect(lineage.size).toBe(events.length);
    expect(lineage.has(events[0].id)).toBe(true);
  });
});
