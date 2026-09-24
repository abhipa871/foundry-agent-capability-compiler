import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  codingPolicySchema,
  type Check,
  type CodingCapability,
  type CodingPolicy,
} from '../domain.js';

// Hash only execution-affecting fields; lifecycle metadata cannot change the approved artifact.
export function codingDigest(cap: CodingCapability): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: cap.id,
        name: cap.name,
        version: cap.version,
        sessionId: cap.sessionId,
        executionMode: cap.executionMode,
        simulated: cap.simulated,
        task: cap.task,
        prompt: cap.prompt,
        provider: cap.provider,
        workspace: cap.workspace,
        sourceEvents: cap.sourceEvents,
        policy: cap.policy,
        sideEffects: cap.sideEffects,
        rollback: cap.rollback,
      }),
    )
    .digest('hex');
}

function workspaceFile(workspace: string, path: string) {
  // Reject Windows aliases, ADS, traversal and sensitive paths on every platform.
  const parts = path.replaceAll('\\', '/').split('/');
  if (
    isAbsolute(path) ||
    path.includes(':') ||
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[. ]$/.test(p) ||
        /^(\.env.*|\.git|\.codex|data|node_modules|.*\.(pem|key))$/i.test(p),
    )
  ) {
    throw new Error('Assertion path must be a non-sensitive relative workspace file.');
  }
  const root = realpathSync(workspace);
  let file = root;
  for (const part of parts) {
    file = resolve(file, part);
    if (lstatSync(file).isSymbolicLink())
      throw new Error('Assertion paths cannot use symbolic links.');
  }
  const target = realpathSync(file);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Assertion path escapes the workspace.');
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > 1000000)
    throw new Error('Assertion requires a regular file under 1 MB.');
  return target;
}

export function assertionChecks(policy: CodingPolicy, workspace: string, output: string): Check[] {
  return policy.assertions.map((assertion, index) => {
    const start = performance.now();
    try {
      const passed =
        assertion.kind === 'output_contains'
          ? output.includes(assertion.text)
          : assertion.kind === 'file_exists'
            ? Boolean(workspaceFile(workspace, assertion.path))
            : readFileSync(workspaceFile(workspace, assertion.path), 'utf8').includes(
                assertion.text,
              );
      return {
        name: `Assertion ${index + 1}: ${assertion.kind}`,
        category: 'regression',
        passed,
        detail: passed ? 'Expected result found.' : 'Expected result was not found.',
        durationMs: performance.now() - start,
      };
    } catch {
      return {
        name: `Assertion ${index + 1}: ${assertion.kind}`,
        category: 'regression',
        passed: false,
        detail: 'File is missing, unsafe, too large, or unreadable.',
        durationMs: performance.now() - start,
      };
    }
  });
}

export function verifyCoding(cap: CodingCapability, output: string): Check[] {
  const check = (
    name: string,
    category: Check['category'],
    passed: boolean,
    detail: string,
  ): Check => ({ name, category, passed, detail, durationMs: 0 });
  const parsed = codingPolicySchema.safeParse(cap.policy);
  const ids = new Set(cap.sourceEvents.map((event) => event.id));
  const checks = [
    check(
      'Execution policy schema',
      'schema',
      parsed.success,
      'Strict policy with bounded runtime and output.',
    ),
    check(
      'Artifact integrity',
      'schema',
      codingDigest(cap) === cap.digest,
      'Task, source steps, provider and policy must match the stored digest.',
    ),
    check(
      'Successful source steps',
      'regression',
      cap.sourceEvents.length > 0 &&
        ids.size === cap.sourceEvents.length &&
        cap.sourceEvents.every((event) => event.status === 'success'),
      'Failed and skipped events must be excluded.',
    ),
    check(
      'Supported provider',
      'policy',
      cap.provider.kind === 'codex-cli' && cap.provider.enabled,
      'Only the enabled local CLI adapter can run.',
    ),
    check(
      'Bounded sandbox invocation',
      'sandbox',
      parsed.success && cap.policy.networkAccess === false,
      'CLI sandbox selected; shell network disabled. This is a configuration check, not an isolation penetration test.',
    ),
    check(
      'No automatic retries',
      'failure',
      cap.policy.maxAttempts === 1,
      'A failed coding task cannot be automatically replayed with partial writes.',
    ),
    check(
      'Task assertions configured',
      'regression',
      cap.policy.assertions.length > 0,
      'Add at least one file or output assertion before approval.',
    ),
  ];
  if (parsed.success) checks.push(...assertionChecks(parsed.data, cap.workspace, output));
  return checks;
}
