import { useCallback, useEffect, useState } from 'react';
import type { CapabilityIR, CompileReport, IRArtifact } from '../compiler/ir';
import type { StoredToolTrace } from '../exploration/tool-events';
import type { ExecutionCheckpoint } from '../runtime/checkpoint';
import type { DispatchOutcome } from '../runtime/dispatcher';
import type { JitProfile } from '../registry/jit';

type JitState = {
  traces: StoredToolTrace[];
  artifacts: IRArtifact[];
  runs: (DispatchOutcome & { id: string })[];
  checkpoints: ExecutionCheckpoint[];
  active: Record<string, string | null>;
  profiles: JitProfile[];
};
type Props = { notify: (text: string, error?: boolean) => void };
const views = ['Traces', 'Compiler', 'Artifact', 'Dispatcher', 'Profile'] as const;
type View = (typeof views)[number];

async function call<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    `/api/v2${path}`,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Foundry-Client': 'local-ui' },
          body: JSON.stringify(data),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value as T;
}

export function JitPanel({ notify }: Props) {
  const [state, setState] = useState<JitState | null>(null);
  const [view, setView] = useState<View>('Traces');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('C-101');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await call<JitState>('/state'));
  }, []);
  useEffect(() => {
    void refresh().catch((error: Error) => notify(error.message, true));
  }, [refresh, notify]);

  const artifact =
    state?.artifacts.find((entry) => entry.id === selectedId) ?? state?.artifacts[0] ?? null;

  async function act(label: string, run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      await refresh();
      notify(label);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Request failed', true);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <div className="loading">Loading compiler state…</div>;
  const lastRun = state.runs[0];
  return (
    <section className="panel">
      <div className="section-header">
        <div>
          <h2>Agent JIT compiler</h2>
          <p>
            Structured trajectories become a typed IR program, verified as an artifact, then
            dispatched behind guards. The compiled path performs no inference at all.
          </p>
        </div>
        <div className="coding-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void act('Sample traces ingested.', () => call('/traces/samples', {}))}
          >
            Load sample traces
          </button>
          <button
            className="button primary"
            disabled={busy || state.traces.length < 2}
            onClick={() =>
              void act('Candidate compiled from trace evidence.', async () => {
                const compiled = await call<IRArtifact>('/compile', {});
                setSelectedId(compiled.id);
              })
            }
          >
            Compile candidate
          </button>
        </div>
      </div>
      <div className="tabs">
        {views.map((entry) => (
          <button
            key={entry}
            className={view === entry ? 'selected' : ''}
            onClick={() => setView(entry)}
          >
            {entry}
          </button>
        ))}
      </div>

      {view === 'Traces' && (
        <div className="table-scroll">
          {state.traces.length === 0 ? (
            <p className="hint">No structured traces yet. Load the samples to begin.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Task kind</th>
                  <th>Input</th>
                  <th>Typed events</th>
                  <th>Data edges</th>
                  <th>Recorded agent cost</th>
                </tr>
              </thead>
              <tbody>
                {state.traces.map((trace) => (
                  <tr key={trace.id}>
                    <td>{trace.taskKind}</td>
                    <td>{trace.taskInput.customerId}</td>
                    <td>
                      {trace.events.length} (
                      {trace.events.filter((e) => e.status !== 'success').length} exploratory)
                    </td>
                    <td>
                      {trace.events.reduce(
                        (sum, event) =>
                          sum +
                          Object.values(event.args).filter((arg) => arg.source === 'event_output')
                            .length,
                        0,
                      )}
                    </td>
                    <td>
                      {trace.llmInvocations} LLM calls · {trace.agentTokens} tokens (fixture)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {view === 'Compiler' && <CompilerView artifact={artifact} />}

      {view === 'Artifact' && artifact && (
        <div className="detail-content">
          <div className="code-header">
            <span>
              {artifact.name} v{artifact.version} · {artifact.status}
            </span>
            <code>sha256 {artifact.digest.slice(0, 24)}…</code>
          </div>
          <pre className="json-block">{JSON.stringify(artifact.ir, null, 2)}</pre>
          <div className="coding-checks">
            {artifact.checks.map((check) => (
              <div className="check-row" key={check.name}>
                <span className={check.passed ? 'green-text' : 'red-text'}>
                  {check.passed ? 'PASS' : 'FAIL'}
                </span>
                <strong>{check.name}</strong>
                <span className="category">{check.category}</span>
                <span className="hint">{check.detail}</span>
              </div>
            ))}
          </div>
          <div className="coding-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void act('Candidate verified.', () =>
                  call(`/capabilities/${artifact.id}/verify`, {}),
                )
              }
            >
              Verify candidate
            </button>
            <button
              className="button primary"
              disabled={busy || artifact.status !== 'verified'}
              onClick={() =>
                void act('Version approved and deployed.', () =>
                  call(`/capabilities/${artifact.id}/approve`, {
                    note: 'Reviewed the IR, guards, scopes and read-only effect declaration.',
                  }),
                )
              }
            >
              Approve version
            </button>
            <a
              className="button secondary"
              href={`/api/v2/capabilities/${artifact.id}/artifact`}
              download
            >
              Download artifact
            </a>
          </div>
        </div>
      )}

      {view === 'Dispatcher' && (
        <div className="detail-content">
          <div className="agent-form">
            <label className="field">
              Customer id
              <input value={customerId} onChange={(event) => setCustomerId(event.target.value)} />
            </label>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void act('Task dispatched.', () =>
                  call('/tasks/dispatch', {
                    kind: 'customer_context',
                    input: { customerId },
                  }),
                )
              }
            >
              Dispatch task
            </button>
          </div>
          <p className="hint">
            C-101 and C-202 are covered by the compiled input class. C-404 is outside it and
            deoptimizes to a checkpoint; C-303 is covered but ineligible.
          </p>
          {lastRun && (
            <>
              <div className="code-header">
                <span>
                  mode: {lastRun.mode}
                  {lastRun.capability
                    ? ` · ${lastRun.capability} v${lastRun.capabilityVersion}`
                    : ''}
                </span>
                <code>
                  LLM calls inside compiled portion: {lastRun.mode === 'compiled' ? 0 : '—'}
                </code>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Guard</th>
                    <th>Result</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRun.guards.map((guard) => (
                    <tr key={guard.name}>
                      <td>{guard.name}</td>
                      <td className={guard.ok ? 'green-text' : 'red-text'}>
                        {guard.ok ? 'pass' : 'fail'}
                      </td>
                      <td>{guard.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <pre className="json-block">
                {JSON.stringify(
                  lastRun.mode === 'compiled'
                    ? {
                        executedNodeIds: lastRun.executedNodeIds,
                        adapterCalls: lastRun.adapterCalls,
                        peakParallel: lastRun.peakParallel,
                        durationMs: Math.round(lastRun.durationMs),
                        observable: lastRun.observable,
                      }
                    : {
                        fallbackReason: lastRun.fallbackReason,
                        detail: lastRun.fallbackDetail,
                        checkpoint: lastRun.checkpoint && {
                          completedNodeIds: lastRun.checkpoint.completedNodeIds,
                          nextNodeIds: lastRun.checkpoint.nextNodeIds,
                          completedEffects: lastRun.checkpoint.completedEffects,
                          resolution: lastRun.checkpoint.resolution ?? null,
                        },
                      },
                  null,
                  2,
                )}
              </pre>
              {lastRun.checkpoint && !lastRun.checkpoint.resolution && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void act('Checkpoint closed as exception evidence.', () =>
                      call(`/runs/${lastRun.id}/recover`, {
                        by: 'operator',
                        note: 'Resolved by hand; recorded as evidence for a future specialization.',
                      }),
                    )
                  }
                >
                  Record recovery
                </button>
              )}
            </>
          )}
        </div>
      )}

      {view === 'Profile' && (
        <div className="detail-content">
          {state.profiles.length === 0 ? (
            <p className="hint">Compile and dispatch a capability to collect a profile.</p>
          ) : (
            state.profiles.map((profile) => (
              <div key={profile.name}>
                <div className="code-header">
                  <span>{profile.name}</span>
                  <code>
                    {profile.compiled} compiled · {profile.agent} agent
                  </code>
                </div>
                <pre className="json-block">{JSON.stringify(profile, null, 2)}</pre>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function CompilerView({ artifact }: { artifact: IRArtifact | null }) {
  if (!artifact) return <p className="hint">Compile a candidate to see the derived plan.</p>;
  const report: CompileReport = artifact.report;
  const ir: CapabilityIR = artifact.ir;
  return (
    <div className="detail-content">
      <div className="provenance">
        <h4>Derived plan</h4>
        <ul>
          {ir.nodes.map((node) => (
            <li key={node.id}>
              <code>{node.id}</code> {node.opcode}
              {node.opcode === 'adapter.read' ? ` ${node.operation}` : ''} · deps:{' '}
              {node.deps.length ? node.deps.join(', ') : 'none (entry)'}
            </li>
          ))}
        </ul>
      </div>
      <div className="provenance">
        <h4>Parameter inference</h4>
        <ul>
          {report.parameters.map((parameter) => (
            <li key={parameter.arg}>
              <code>{parameter.arg}</code> → {parameter.binding}: {parameter.evidence}
            </li>
          ))}
        </ul>
      </div>
      <div className="provenance">
        <h4>Optimizations applied</h4>
        <ul>
          {ir.optimizations.map((optimization) => (
            <li key={optimization}>{optimization}</li>
          ))}
        </ul>
      </div>
      <div className="provenance">
        <h4>Exception evidence retained</h4>
        <ul>
          {report.prunedEvents.map((event) => (
            <li key={event.eventId}>
              {event.operation} · {event.reason} — {event.detail}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
