import type { TaskManifest, ToolManifest } from '../compiler/contracts';
import type { TaskArtifact, TaskOutcome } from '../runtime/task-runtime';

export type TaskWorkspace = {
  tasks: TaskManifest[];
  tools: ToolManifest[];
  traces: {
    id: string;
    kind: string;
    input: unknown;
    eventCount: number;
    source: 'fixture' | 'import';
  }[];
  artifacts: TaskArtifact[];
  active: Record<string, string>;
  shadowCoverage: Record<
    string,
    { matchedInputs: number; failed: number; required: number; ready: boolean }
  >;
  identity: { tenantId: string; principalId: string; permissions: string[] };
  examples: { kind: string; label: string; input: unknown }[];
  fixtureKinds: string[];
  localDemo: boolean;
};
export type GeneralTaskRun = TaskOutcome;

export async function taskApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v2/tasks${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined
        ? undefined
        : { 'Content-Type': 'application/json', 'X-Foundry-Client': 'local-ui' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Task request failed (${response.status}).`);
  return result as T;
}
