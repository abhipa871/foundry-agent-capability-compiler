import { describe, expect, it } from 'vitest';
import { assertionChecks } from '../../src/verification/coding.js';
import { defaultCodingPolicy } from '../../src/domain.js';

describe('safe file assertions', () => {
  it.each([
    '../package.json',
    'C:\\Windows\\win.ini',
    '/etc/passwd',
    '.env',
    '.codex/config.toml',
    'data/foundry.sqlite',
    'package.json:secret',
    'src/../../package.json',
    'missing-file.ts',
  ])('rejects %s', (path) => {
    const checks = assertionChecks(
      { ...defaultCodingPolicy, assertions: [{ kind: 'file_exists', path }] },
      process.cwd(),
      '',
    );
    expect(checks[0].passed).toBe(false);
  });
  it('checks real file contents and literal output without executing commands', () => {
    const checks = assertionChecks(
      {
        ...defaultCodingPolicy,
        assertions: [
          { kind: 'file_contains', path: 'package.json', text: 'agent-capability-compiler' },
          { kind: 'output_contains', text: 'complete' },
          { kind: 'output_contains', text: 'not present' },
        ],
      },
      process.cwd(),
      'Task complete',
    );
    expect(checks.map((c) => c.passed)).toEqual([true, true, false]);
  });
});
