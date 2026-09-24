import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  agentProviders,
  buildCodexExecArgs,
  eventsFromCodex,
  runCodexTask,
} from '../../src/agent/codex.js';
import { defaultCodingPolicy } from '../../src/domain.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('Codex invocation boundaries', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false };
  let child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.stubEnv('FOUNDRY_CODEX_DRY_RUN', 'false');
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('enforces approved sandbox configuration without shell interpolation', () => {
    const args = buildCodexExecArgs(
      agentProviders[0],
      'C:/project with spaces',
      defaultCodingPolicy,
    );
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('sandbox_workspace_write.network_access=false');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('C:/project with spaces');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('fails closed when output exceeds the approved limit even if exit code is zero', async () => {
    const result = runCodexTask('Check documentation.', {
      provider: agentProviders[0],
      cwd: process.cwd(),
      policy: { ...defaultCodingPolicy, maxOutputBytes: 4096 },
    });
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true });
    child.stdout.write(Buffer.alloc(5000, 'a'));
    child.emit('close', 0);
    expect(await result).toMatchObject({
      status: 'failed',
      error: 'Codex CLI output limit exceeded.',
    });
    expect(child.kill).toHaveBeenCalled();
  });
  it('fails closed on timeout and input errors', async () => {
    vi.useFakeTimers();
    const result = runCodexTask('Check documentation.', {
      provider: agentProviders[0],
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1001);
    child.emit('close', 0);
    expect((await result).error).toContain('timed out');
    const second = runCodexTask('Check documentation.', {
      provider: agentProviders[0],
      cwd: process.cwd(),
    });
    child.stdin.emit('error', new Error('EPIPE'));
    child.emit('close', 0);
    expect((await second).status).toBe('failed');
  });
  it('classifies real failed tool exits without treating a null error field as failure', () => {
    const events = eventsFromCodex(
      [
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'missing-tool',
            exit_code: 1,
            status: 'completed',
          },
        },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'replacement-tool',
            exit_code: 0,
            error: null,
          },
        },
        { type: 'item.started', item: { status: 'in_progress' } },
      ],
      new Date().toISOString(),
      usage,
      'success',
      '',
    );
    expect(events.slice(1, 4).map((e) => e.status)).toEqual(['failed', 'success', 'skipped']);
  });
});
