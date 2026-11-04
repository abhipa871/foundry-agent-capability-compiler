import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  Database,
  FileJson,
  LoaderCircle,
  Play,
  Rocket,
  ShieldCheck,
} from 'lucide-react';
import type { TaskArtifact } from '../runtime/task-runtime';
import { SchemaInput, schemaDefault } from './SchemaInput';
import { generalSdkExample } from './sdk-example';
import { taskApi, type GeneralTaskRun, type TaskWorkspace } from './task-api';
import './task-console.css';

type View = 'Evidence' | 'Review' | 'Run' | 'Registry';
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function GeneralTaskPanel({
  notify,
  mode,
}: {
  notify: (text: string, error?: boolean) => void;
  mode?: 'workflow' | 'registry';
}) {
  const [workspace, setWorkspace] = useState<TaskWorkspace>();
  const [view, setView] = useState<View>('Evidence');
  const [kind, setKind] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [traceIds, setTraceIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [input, setInput] = useState<unknown>({});
  const [inputJson, setInputJson] = useState('{}');
  const [jsonMode, setJsonMode] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [lastRun, setLastRun] = useState<GeneralTaskRun>();
  const [copyMessage, setCopyMessage] = useState('');
  const task = workspace?.tasks.find((entry) => entry.kind === kind);
  const artifact = workspace?.artifacts.find((entry) => entry.id === selectedId);
  const examples = workspace?.examples.filter((entry) => entry.kind === kind) ?? [];
  const traces = workspace?.traces.filter((entry) => entry.kind === kind) ?? [];
  const versions = workspace?.artifacts.filter((entry) => entry.plan.kind === kind) ?? [];
  const coverage = artifact && workspace?.shadowCoverage[artifact.id];
  const deployed = !!artifact && workspace?.active[artifact.plan.name] === artifact.id;
  const verified =
    !!artifact &&
    artifact.verifiedDigest === artifact.digest &&
    !!artifact.checks.length &&
    artifact.checks.every((check) => check.passed) &&
    artifact.status !== 'revoked';
  const allowed = (permission: string) =>
    workspace?.identity.permissions.includes(permission) ?? false;

  async function refresh() {
    const next = await taskApi<TaskWorkspace>('/workspace');
    setWorkspace(next);
    return next;
  }
  useEffect(() => {
    const controller = new AbortController();
    void taskApi<TaskWorkspace>('/workspace', undefined, controller.signal)
      .then(setWorkspace)
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (mode === 'registry') setView('Registry');
    if (mode === 'workflow')
      setView((previous) => (previous === 'Registry' ? 'Evidence' : previous));
  }, [mode]);
  async function act(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    setMessage('');
    try {
      await action();
      await refresh();
      setMessage(label);
      notify(label);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Task request failed.');
      notify('Task action failed. See the console for details.', true);
      await refresh().catch(() => {});
    } finally {
      setBusy('');
    }
  }
  function changeInput(next: unknown) {
    setInput(next);
    setInputJson(pretty(next));
    setLastRun(undefined);
  }
  function editJson(next: string) {
    setInputJson(next);
    setLastRun(undefined);
  }
  function selectTask(nextKind: string) {
    setKind(nextKind);
    setSelectedId('');
    setTraceIds([]);
    setReviewed(false);
    setError('');
    setMessage('');
    setLastRun(undefined);
    setName(`load_${nextKind}_context`.slice(0, 96));
    const example = workspace?.examples.find((entry) => entry.kind === nextKind);
    const manifest = workspace?.tasks.find((entry) => entry.kind === nextKind);
    changeInput(example?.input ?? schemaDefault(manifest?.inputSchema ?? { type: 'object' }));
  }
  function chooseArtifact(next: TaskArtifact) {
    if (next.plan.kind !== kind) selectTask(next.plan.kind);
    setSelectedId(next.id);
    setReviewed(false);
    setLastRun(undefined);
  }
  const currentInput = () => (jsonMode ? JSON.parse(inputJson) : input);
  async function importTraces() {
    const parsed: unknown = JSON.parse(importJson);
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    if (
      !batch.length ||
      batch.length > 32 ||
      batch.some(
        (trace) =>
          !trace || typeof trace !== 'object' || (trace as { kind?: unknown }).kind !== kind,
      )
    )
      throw new Error('Import 1–32 trace objects for the selected task.');
    const ids: string[] = [];
    for (const trace of batch) ids.push((await taskApi<{ id: string }>('/traces', trace)).id);
    setTraceIds(ids);
    setImportJson('');
  }
  const submit = (event: FormEvent, action: () => void) => {
    event.preventDefault();
    action();
  };

  return (
    <section className="task-console" aria-label="General task console" aria-busy={!!busy}>
      <header className="task-console-intro">
        <div>
          <span className="task-eyebrow">GENERAL TASK COMPILER</span>
          <h2>{view === 'Registry' ? 'Registered capabilities' : 'Compile and deploy a tool'}</h2>
          <p>
            Choose a registered workflow, review its evidence, and promote the exact validated
            version.
          </p>
        </div>
        <span className="task-trust">
          <ShieldCheck size={16} />
          Read &amp; pure operations
        </span>
      </header>
      <div className="task-context-bar">
        <label className="task-field">
          Registered task
          <select
            value={kind}
            disabled={!!busy || !workspace}
            onChange={(event) => selectTask(event.target.value)}
          >
            <option value="">Choose a task…</option>
            {workspace?.tasks.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.kind.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <div>
          <small>ACTING AS</small>
          <strong>
            {workspace
              ? `${workspace.identity.principalId} · ${workspace.identity.tenantId}`
              : 'Loading workspace…'}
          </strong>
          <span>
            {workspace?.localDemo ? 'Local operator session' : 'Authenticated API session'}
          </span>
        </div>
        <button
          className="bw-button bw-button-white"
          disabled={!!busy}
          onClick={() => void act('Workspace refreshed.', async () => {})}
        >
          Refresh
        </button>
      </div>
      {error && (
        <div className="task-error" role="alert">
          <strong>Action could not complete</strong>
          <p>{error}</p>
        </div>
      )}
      {message && (
        <p className="task-success" role="status">
          <Check size={16} />
          {message}
        </p>
      )}
      {busy && (
        <p className="task-pending" role="status">
          <LoaderCircle size={16} className="spin" />
          {busy} Please wait…
        </p>
      )}
      {workspace && workspace.tasks.length === 0 && (
        <div className="task-empty">
          <Database size={28} />
          <h3>No task contracts registered</h3>
          <p>
            Configure an operator-owned task module with schemas, adapters, verification cases and a
            native callback. Then refresh this workspace.
          </p>
          <code>FOUNDRY_TASK_MODULE=/path/to/trusted-module.ts</code>
        </div>
      )}
      <nav className="task-stages" aria-label="General task stages">
        {(['Evidence', 'Review', 'Run', 'Registry'] as View[]).map((entry, index) => (
          <button
            key={entry}
            disabled={!!busy}
            aria-current={view === entry ? 'step' : undefined}
            className={view === entry ? 'active' : ''}
            onClick={() => setView(entry)}
          >
            <span>{index + 1}</span>
            {entry}
          </button>
        ))}
      </nav>
      {task && <p className="task-description">{task.description}</p>}
      {view === 'Evidence' && (
        <div className="task-columns">
          <section className="task-card">
            <div className="task-card-heading">
              <Database size={19} />
              <h3>Choose compilation evidence</h3>
            </div>
            <p>At least two distinct inputs must agree on the same explicit dataflow.</p>
            {workspace?.fixtureKinds.includes(kind) && (
              <div className="task-fixture">
                <strong>Try a local example</strong>
                <p>
                  Synthetic fixture evidence. No model is called and no token savings are measured
                  here.
                </p>
                <button
                  className="bw-button bw-button-white"
                  disabled={!!busy || !allowed('observe')}
                  onClick={() =>
                    void act('Fixture evidence captured (0 model calls).', async () => {
                      const result = await taskApi<{ ids: string[] }>('/samples', { kind });
                      setTraceIds(result.ids);
                    })
                  }
                >
                  Load fixture evidence
                </button>
              </div>
            )}
            {traces.length ? (
              <div className="task-evidence-list">
                {traces.map((trace) => (
                  <label key={trace.id} className="task-evidence">
                    <input
                      type="checkbox"
                      disabled={!!busy}
                      checked={traceIds.includes(trace.id)}
                      onChange={(event) =>
                        setTraceIds((previous) =>
                          event.target.checked
                            ? [...previous, trace.id]
                            : previous.filter((id) => id !== trace.id),
                        )
                      }
                      aria-label={`Select trace ${trace.id}`}
                    />
                    <span>
                      <strong>
                        {trace.id.slice(0, 8)}{' '}
                        <em>{trace.source === 'fixture' ? 'Fixture' : 'SDK / import'}</em>
                      </strong>
                      <small>
                        {trace.eventCount} operations · {pretty(trace.input)}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="task-empty-small">
                {kind
                  ? 'No evidence for this task yet. Import SDK traces or load its local fixtures.'
                  : 'Select a registered task to get started.'}
              </div>
            )}
            <label className="task-field">
              Capability name
              <input
                value={name}
                disabled={!!busy || !kind}
                onChange={(event) => setName(event.target.value)}
                maxLength={96}
              />
            </label>
            <div className="task-action-row">
              <span>{traceIds.length} trajectories selected</span>
              <button
                className="bw-button bw-button-primary"
                disabled={!!busy || traceIds.length < 2 || !name || !allowed('compile')}
                onClick={() =>
                  void act(
                    'Candidate compiled. Verification is required before approval.',
                    async () => {
                      const result = await taskApi<TaskArtifact>('/compile', { name, traceIds });
                      setSelectedId(result.id);
                      setReviewed(false);
                      setView('Review');
                    },
                  )
                }
              >
                Compile candidate
                <ArrowRight size={15} />
              </button>
            </div>
          </section>
          <section className="task-card">
            <div className="task-card-heading">
              <FileJson size={19} />
              <h3>Import SDK trajectories</h3>
            </div>
            <p>
              Paste one trace or an array of traces captured with <code>TaskObserver</code>. Only
              JSON evidence is accepted; tool code is registered by your operator.
            </p>
            <label className="task-field">
              Trace JSON
              <textarea
                aria-label="Trace JSON"
                className="task-code-input"
                value={importJson}
                disabled={!!busy}
                onChange={(event) => setImportJson(event.target.value)}
                maxLength={1048576}
                placeholder='[{ "id": "…", "kind": "…", "events": […] }]'
              />
            </label>
            <label className="task-field">
              Read a JSON file
              <input
                type="file"
                accept=".json,application/json"
                disabled={!!busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 1048576) {
                    setError('Trace file exceeds the 1 MB import budget.');
                    return;
                  }
                  void file
                    .text()
                    .then(setImportJson)
                    .catch(() => setError('Unable to read this trace file.'));
                }}
              />
            </label>
            <button
              className="bw-button bw-button-white"
              disabled={!!busy || !kind || !importJson.trim() || !allowed('observe')}
              onClick={() => void act('Trace evidence imported.', importTraces)}
            >
              Import traces
            </button>
            <details className="task-details">
              <summary>Registered tools and permissions</summary>
              {task?.tools.map((toolName) => {
                const tool = workspace?.tools.find((entry) => entry.name === toolName);
                return (
                  <div className="task-tool" key={toolName}>
                    <strong>{toolName}</strong>
                    <small>
                      {tool?.effect} · v{tool?.version} ·{' '}
                      {tool?.scopes.join(', ') || 'No additional scope'}
                    </small>
                    <p>{tool?.description}</p>
                  </div>
                );
              })}
            </details>
          </section>
        </div>
      )}
      {view === 'Review' && (
        <>
          <ArtifactPicker
            artifacts={versions}
            selectedId={selectedId}
            onSelect={(id) => {
              const next = versions.find((entry) => entry.id === id);
              if (next) chooseArtifact(next);
            }}
            disabled={!!busy}
          />
          {!artifact ? (
            <div className="task-empty">
              <ShieldCheck size={28} />
              <h3>No candidate selected</h3>
              <p>Compile compatible evidence or choose a candidate from the registry.</p>
            </div>
          ) : (
            <>
              <div className="task-artifact-banner">
                <div>
                  <span className={`task-status task-status-${artifact.status}`}>
                    {artifact.status}
                  </span>
                  <h3>{artifact.plan.name}</h3>
                  <p>
                    {artifact.plan.nodes.length} operations · {artifact.plan.evidence.length} source
                    trajectories
                  </p>
                </div>
                <div>
                  <small>EXACT ARTIFACT DIGEST</small>
                  <code>{artifact.digest}</code>
                </div>
              </div>
              <div className="task-columns">
                <section className="task-card">
                  <h3>1. Verify this candidate</h3>
                  <p>
                    Run schema, sandbox, evidence, policy, freshness and failure checks on this
                    exact digest.
                  </p>
                  <button
                    className="bw-button bw-button-white"
                    disabled={!!busy || artifact.status === 'revoked' || !allowed('verify')}
                    onClick={() => {
                      if (
                        deployed &&
                        !window.confirm(
                          'Reverification removes the active deployment and requires new shadow coverage. Continue?',
                        )
                      )
                        return;
                      void act('Verification completed. Review the results.', async () => {
                        await taskApi(`/capabilities/${artifact.id}/verify`, {});
                        setReviewed(false);
                      });
                    }}
                  >
                    Verify candidate
                  </button>
                  <div className="task-checks">
                    {artifact.checks.map((check) => (
                      <div className={check.passed ? 'pass' : 'fail'} key={check.name}>
                        <span>{check.passed ? 'PASS' : 'FAIL'}</span>
                        {check.name}
                      </div>
                    ))}
                  </div>
                  {!artifact.checks.length && (
                    <p className="task-muted">No verification results yet.</p>
                  )}
                </section>
                <section className="task-card">
                  <h3>2. Compare with native execution</h3>
                  <p>
                    Distinct passing inputs are required for the current verification stamp.
                    Comparison uses the server’s trusted native callback.
                  </p>
                  <strong className="task-coverage">
                    {coverage?.matchedInputs ?? 0} / {coverage?.required ?? 3} distinct shadow
                    inputs matched
                  </strong>
                  {!!coverage?.failed && (
                    <p className="task-error">
                      {coverage.failed} failed or mismatched comparisons block deployment. Reverify
                      to start a fresh validation cycle.
                    </p>
                  )}
                  {examples.length > 0 && (
                    <button
                      className="bw-button bw-button-white"
                      disabled={!!busy || !verified || !allowed('invoke')}
                      onClick={() =>
                        void act('Example shadow comparisons completed.', async () => {
                          for (const example of examples) {
                            const result = await taskApi<{ status: string }>(
                              `/capabilities/${artifact.id}/shadow`,
                              { input: example.input },
                            );
                            if (result.status !== 'match')
                              throw new Error(
                                'A native shadow comparison failed. Review coverage before deploying.',
                              );
                          }
                        })
                      }
                    >
                      Compare example inputs
                    </button>
                  )}
                  <form
                    onSubmit={(event) =>
                      submit(
                        event,
                        () =>
                          void act('Shadow comparison recorded.', async () => {
                            const result = await taskApi<{ status: string }>(
                              `/capabilities/${artifact.id}/shadow`,
                              { input: currentInput() },
                            );
                            if (result.status !== 'match')
                              throw new Error('Native and compiled execution did not match.');
                          }),
                      )
                    }
                  >
                    <InputEditor
                      schema={task?.inputSchema}
                      input={input}
                      changeInput={changeInput}
                      json={inputJson}
                      setJson={editJson}
                      jsonMode={jsonMode}
                      setJsonMode={setJsonMode}
                      examples={examples}
                      disabled={!!busy}
                    />
                    <button
                      className="bw-button bw-button-white"
                      type="submit"
                      disabled={!!busy || !verified || !allowed('invoke')}
                    >
                      Compare this input
                    </button>
                  </form>
                </section>
              </div>
              <section className="task-card task-promotion">
                <div>
                  <h3>3. Approve, then deploy</h3>
                  <p>
                    Approval records review of this digest. Deployment separately activates this
                    version after passing shadow coverage.
                  </p>
                  <label className="task-checkbox">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      disabled={!!busy || !verified || artifact.status !== 'verified'}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />
                    I reviewed this exact digest, verification results, and required scopes.
                  </label>
                  <p className="task-muted">
                    Scopes:{' '}
                    {[
                      ...new Set(
                        artifact.plan.nodes.flatMap(
                          (node) =>
                            workspace?.tools.find((tool) => tool.name === node.tool)?.scopes ?? [],
                        ),
                      ),
                    ].join(', ') || 'None'}
                  </p>
                </div>
                <div className="task-promotion-actions">
                  <button
                    className="bw-button bw-button-white"
                    disabled={
                      !!busy ||
                      !reviewed ||
                      !verified ||
                      artifact.status !== 'verified' ||
                      !allowed('approve')
                    }
                    onClick={() =>
                      void act('Version approved. Deployment is a separate action.', async () => {
                        await taskApi(`/capabilities/${artifact.id}/approve`, {});
                        setReviewed(false);
                      })
                    }
                  >
                    Approve version
                  </button>
                  <button
                    className="bw-button bw-button-primary"
                    disabled={
                      !!busy ||
                      artifact.status !== 'approved' ||
                      !coverage?.ready ||
                      deployed ||
                      !allowed('deploy')
                    }
                    onClick={() =>
                      void act('Version deployed. It is ready to run.', async () => {
                        await taskApi(`/capabilities/${artifact.id}/deploy`, {});
                        setView('Run');
                      })
                    }
                  >
                    <Rocket size={15} />
                    {deployed ? 'Deployed' : 'Deploy version'}
                  </button>
                </div>
              </section>
              <details className="task-details">
                <summary>Inspect compiled plan, bindings and pinned contracts</summary>
                <div className="task-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Node</th>
                        <th>Tool</th>
                        <th>Dependencies / argument bindings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {artifact.plan.nodes.map((node) => (
                        <tr key={node.id}>
                          <td>{node.id}</td>
                          <td>{node.tool}</td>
                          <td>
                            <code>{JSON.stringify(node.args)}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <pre>{pretty(artifact.plan)}</pre>
              </details>
            </>
          )}
        </>
      )}
      {view === 'Run' && (
        <section className="task-card">
          <ArtifactPicker
            artifacts={versions}
            selectedId={selectedId}
            onSelect={(id) => {
              const next = versions.find((entry) => entry.id === id);
              if (next) chooseArtifact(next);
            }}
            disabled={!!busy}
          />
          <h3>Execute the deployed tool</h3>
          <p>
            {deployed
              ? `Active: ${artifact?.plan.name} · ${artifact?.digest.slice(0, 12)}`
              : 'Select and deploy an approved version before running it.'}
          </p>
          <form
            onSubmit={(event) =>
              submit(
                event,
                () =>
                  void act('Execution completed. Inspect its actual outcome below.', async () => {
                    setLastRun(undefined);
                    setLastRun(
                      await taskApi<GeneralTaskRun>('/dispatch', {
                        name: artifact!.plan.name,
                        kind,
                        input: currentInput(),
                      }),
                    );
                  }),
              )
            }
          >
            <InputEditor
              schema={task?.inputSchema}
              input={input}
              changeInput={changeInput}
              json={inputJson}
              setJson={editJson}
              jsonMode={jsonMode}
              setJsonMode={setJsonMode}
              examples={examples}
              disabled={!!busy}
            />
            <button
              className="bw-button bw-button-primary"
              type="submit"
              disabled={!!busy || !deployed || !allowed('invoke')}
            >
              <Play size={15} />
              Run deployed tool
            </button>
          </form>
          {lastRun && (
            <div className="task-run-result" aria-live="polite">
              <div className="task-run-metrics">
                <span>
                  Outcome<strong>{lastRun.outcome}</strong>
                </span>
                <span>
                  Mode<strong>{lastRun.mode}</strong>
                </span>
                <span>
                  Tool calls<strong>{lastRun.toolCalls}</strong>
                </span>
                <span>
                  Model calls<strong>{lastRun.llmInvocations}</strong>
                </span>
              </div>
              {lastRun.outcome === 'unresolved' && (
                <p>
                  Execution handed off. No complete task result was returned; inspect the
                  checkpoint.
                </p>
              )}
              {lastRun.outcome === 'denied' && (
                <p>Access denied. No automatic agent fallback is authorized.</p>
              )}
              <pre aria-label="Execution JSON">{pretty(lastRun)}</pre>
            </div>
          )}
          {artifact && artifact.status === 'approved' && (
            <button
              className="bw-button bw-button-white task-revoke"
              disabled={!!busy || !allowed('deploy')}
              onClick={() => {
                if (
                  !window.confirm(
                    `Revoke ${artifact.plan.name}? Future deployed execution will be blocked.`,
                  )
                )
                  return;
                void act('Version revoked. Future deployed execution is blocked.', async () => {
                  await taskApi(`/capabilities/${artifact.id}/revoke`, {});
                  setLastRun(undefined);
                });
              }}
            >
              Revoke version
            </button>
          )}
        </section>
      )}
      {view === 'Registry' && (
        <section className="task-card">
          <h3>Capability registry</h3>
          <p>Versions and deployment state for your current tenant and principal.</p>
          {!workspace?.artifacts.length ? (
            <div className="task-empty-small">
              No capabilities yet. Choose Evidence to compile your first version.
            </div>
          ) : (
            <div className="task-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Capability / task</th>
                    <th>Status</th>
                    <th>Digest</th>
                    <th>Deployment</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {workspace.artifacts.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.plan.name}</strong>
                        <small>{entry.plan.kind}</small>
                      </td>
                      <td>
                        <span className={`task-status task-status-${entry.status}`}>
                          {entry.status}
                        </span>
                      </td>
                      <td>
                        <code>{entry.digest.slice(0, 12)}</code>
                      </td>
                      <td>
                        {workspace.active[entry.plan.name] === entry.id ? 'Active' : 'Inactive'}
                      </td>
                      <td>
                        <button
                          className="bw-button bw-button-white"
                          onClick={() => {
                            chooseArtifact(entry);
                            setView('Review');
                          }}
                        >
                          Inspect version
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <details className="task-details task-sdk">
        <summary>Use this workflow through the Node SDK</summary>
        <p>
          Server-side application example. Keep provider and control-plane credentials out of the
          browser.
        </p>
        <button
          className="bw-button bw-button-white"
          onClick={() => {
            void navigator.clipboard
              .writeText(generalSdkExample)
              .then(() => setCopyMessage('SDK example copied.'))
              .catch(() =>
                setCopyMessage('Clipboard unavailable. Select and copy the code below.'),
              );
          }}
        >
          Copy SDK example
        </button>
        <span role="status">{copyMessage}</span>
        <pre>
          <code>{generalSdkExample}</code>
        </pre>
      </details>
    </section>
  );
}

function ArtifactPicker({
  artifacts,
  selectedId,
  onSelect,
  disabled,
}: {
  artifacts: TaskArtifact[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="task-field task-version-picker">
      Capability version
      <select
        value={selectedId}
        onChange={(event) => onSelect(event.target.value)}
        disabled={disabled}
      >
        <option value="">Choose a candidate…</option>
        {artifacts.map((artifact) => (
          <option value={artifact.id} key={artifact.id}>
            {artifact.plan.name} · {artifact.status} · {artifact.digest.slice(0, 8)}
          </option>
        ))}
      </select>
    </label>
  );
}
function InputEditor({
  schema,
  input,
  changeInput,
  json,
  setJson,
  jsonMode,
  setJsonMode,
  examples,
  disabled,
}: {
  schema: unknown;
  input: unknown;
  changeInput: (value: unknown) => void;
  json: string;
  setJson: (value: string) => void;
  jsonMode: boolean;
  setJsonMode: (value: boolean) => void;
  examples: TaskWorkspace['examples'];
  disabled: boolean;
}) {
  const [parseError, setParseError] = useState('');
  if (!schema) return null;
  return (
    <div className="task-input-editor">
      {examples.length > 0 && (
        <label className="task-field">
          Example input
          <select
            value=""
            disabled={disabled}
            onChange={(event) => {
              const example = examples[Number(event.target.value)];
              if (example) changeInput(example.input);
            }}
          >
            <option value="">Load a synthetic example…</option>
            {examples.map((example, index) => (
              <option value={index} key={example.label}>
                {example.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="task-checkbox">
        <input
          type="checkbox"
          disabled={disabled}
          checked={jsonMode}
          onChange={(event) => {
            if (!event.target.checked) {
              try {
                changeInput(JSON.parse(json));
              } catch {
                setParseError('Correct invalid JSON before switching to form fields.');
                return;
              }
            }
            setParseError('');
            setJsonMode(event.target.checked);
          }}
        />
        Edit full input JSON
      </label>
      {parseError && (
        <p role="alert" className="task-error">
          {parseError}
        </p>
      )}
      {jsonMode ? (
        <label className="task-field">
          Task input JSON
          <textarea
            aria-label="Task input JSON"
            className="task-code-input"
            value={json}
            disabled={disabled}
            onChange={(event) => setJson(event.target.value)}
          />
        </label>
      ) : (
        <SchemaInput schema={schema} value={input} onChange={changeInput} disabled={disabled} />
      )}
    </div>
  );
}
