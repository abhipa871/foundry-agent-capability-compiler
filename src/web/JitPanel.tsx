import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, Database, Play, ShieldCheck } from 'lucide-react';
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
const views = ['Build', 'Validate', 'Run'] as const;
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
  const [view, setView] = useState<View>('Build');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('C-101');
  const [busy, setBusy] = useState(false);
  const [expandedChecks, setExpandedChecks] = useState<Record<string, boolean>>({});
  const refresh = useCallback(async () => {
    setState(await call<JitState>('/state'));
  }, []);
  useEffect(() => {
    void refresh().catch((error: Error) => notify(error.message, true));
  }, [refresh, notify]);
  const artifact =
    state?.artifacts.find((entry) => entry.id === selectedId) ?? state?.artifacts[0] ?? null;
  async function act(label: string, run: () => Promise<unknown>, nextView?: View) {
    setBusy(true);
    try {
      await run();
      await refresh();
      if (nextView) setView(nextView);
      notify(label);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Request failed', true);
    } finally {
      setBusy(false);
    }
  }
  if (!state) return <div className="loading">Loading compiler state…</div>;
  const deployed = state.artifacts.find(
    (entry) => entry.status === 'approved' && state.active[entry.name] === entry.id,
  );
  const lastRun = state.runs[0];
  const passed = artifact?.checks.filter((check) => check.passed).length ?? 0;
  const descriptions = {
    Build: 'Gather evidence and compile a reusable read plan.',
    Validate: 'Check the exact version before approving execution.',
    Run: 'Test the deployed plan and inspect its actual outcome.',
  };
  const complete = {
    Build: !!artifact,
    Validate: artifact?.status === 'approved',
    Run: state.runs.some((run) => run.outcome === 'success' && run.capabilityId === artifact?.id),
  };
  return (
    <section className="panel capability-workflow" aria-label="Capability workflow">
      <div className="workflow-intro">
        <div>
          <span className="workflow-eyebrow">READ-ONLY CAPABILITY</span>
          <h2>Capability workflow</h2>
          <p>From recorded reads to trusted execution, in three steps.</p>
        </div>
        <span className="workflow-safety">
          <ShieldCheck size={13} />
          Guards always enforced
        </span>
      </div>
      <nav className="workflow-steps" aria-label="Capability steps">
        {views.map((step, index) => (
          <button
            key={step}
            aria-label={step}
            aria-current={view === step ? 'step' : undefined}
            className={view === step ? 'active' : ''}
            onClick={() => setView(step)}
          >
            <span className={`workflow-step-number ${complete[step] ? 'complete' : ''}`}>
              {complete[step] ? <Check size={14} /> : index + 1}
            </span>
            <span>
              <strong>{step}</strong>
              <small>
                {step === 'Build'
                  ? 'Evidence & plan'
                  : step === 'Validate'
                    ? 'Checks & approval'
                    : 'Execution & results'}
              </small>
            </span>
            {index < 2 && <ArrowRight size={14} className="workflow-step-arrow" />}
          </button>
        ))}
      </nav>
      <div className="workflow-body">
        <div className="workflow-stage-heading">
          <div>
            <h3>
              {view === 'Build'
                ? 'Start with a repeatable workflow'
                : view === 'Validate'
                  ? 'Make sure the plan is safe to reuse'
                  : 'See your capability in action'}
            </h3>
            <p>{descriptions[view]}</p>
          </div>
          {state.artifacts.length > 1 && (
            <label className="workflow-version">
              Version
              <select
                aria-label="Capability version"
                value={artifact?.id ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {state.artifacts.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    v{entry.version} · {entry.status}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {view === 'Build' && (
          <>
            <div className="workflow-next-action">
              <div className="workflow-action-icon">
                <Database size={20} />
              </div>
              <div>
                <strong>
                  {state.traces.length < 2
                    ? 'Add evidence to get started'
                    : `${state.traces.length} recorded trajectories available`}
                </strong>
                <p>
                  {state.traces.length < 2
                    ? 'The compiler needs at least two compatible recordings. Try the local samples first.'
                    : 'Compile a candidate from compatible typed reads. Nothing is approved automatically.'}
                </p>
              </div>
              <div className="coding-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void act('Sample traces ingested.', () => call('/traces/samples', {}))
                  }
                >
                  Load sample traces
                </button>
                <button
                  className="button primary"
                  disabled={busy || state.traces.length < 2}
                  onClick={() =>
                    void act(
                      'Candidate compiled. Review its validation next.',
                      async () => {
                        const compiled = await call<IRArtifact>('/compile', {});
                        setSelectedId(compiled.id);
                      },
                      'Validate',
                    )
                  }
                >
                  Compile candidate
                  <ArrowRight size={13} />
                </button>
              </div>
            </div>
            {state.traces.length > 0 && (
              <details className="workflow-details">
                <summary>
                  Recorded evidence <span>{state.traces.length} trajectories</span>
                </summary>
                <div className="table-scroll">
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
                            {trace.events.filter((event) => event.status !== 'success').length}{' '}
                            exploratory)
                          </td>
                          <td>
                            {trace.events.reduce(
                              (sum, event) =>
                                sum +
                                Object.values(event.args).filter(
                                  (arg) => arg.source === 'event_output',
                                ).length,
                              0,
                            )}
                          </td>
                          <td>
                            {trace.llmInvocations} LLM calls · {trace.agentTokens} tokens (
                            {trace.measurement?.origin ??
                              (trace.source === 'demo' ? 'fixture' : 'unverified')}
                            )
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
            {artifact && (
              <details className="workflow-details">
                <summary>
                  Compiled plan & optimizations <span>v{artifact.version}</span>
                </summary>
                <CompilerView artifact={artifact} />
              </details>
            )}
          </>
        )}
        {view === 'Validate' &&
          (artifact ? (
            <>
              <div className="workflow-next-action">
                <div className="workflow-action-icon">
                  <ShieldCheck size={20} />
                </div>
                <div>
                  <strong>
                    {artifact.status === 'approved'
                      ? 'This version is approved'
                      : artifact.checks.length
                        ? `${passed} of ${artifact.checks.length} validation checks passed`
                        : 'This candidate needs validation'}
                  </strong>
                  <p>
                    {artifact.status === 'approved'
                      ? 'Continue to Run to test the deployed capability.'
                      : artifact.status === 'verified'
                        ? 'Review the checks, then explicitly approve this exact version.'
                        : 'Validation checks correctness, authorization, freshness and failure behavior.'}
                  </p>
                </div>
                <div className="coding-actions">
                  {artifact.status === 'approved' ? (
                    <button className="button primary" onClick={() => setView('Run')}>
                      Test capability
                      <ArrowRight size={13} />
                    </button>
                  ) : (
                    <>
                      <button
                        className={`button ${artifact.status === 'verified' ? 'secondary' : 'primary'}`}
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
                          void act(
                            'Version approved and deployed.',
                            async () => {
                              await call(`/capabilities/${artifact.id}/approve`, {
                                note: 'Reviewed the IR, guards, scopes and read-only effect declaration.',
                              });
                            },
                            'Run',
                          )
                        }
                      >
                        Approve version
                        <ArrowRight size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {artifact.checks.length > 0 && (
                <details
                  className="workflow-details"
                  open={expandedChecks[artifact.id] ?? passed !== artifact.checks.length}
                >
                  <summary
                    onClick={(event) => {
                      event.preventDefault();
                      setExpandedChecks((previous) => ({
                        ...previous,
                        [artifact.id]: !(
                          previous[artifact.id] ?? passed !== artifact.checks.length
                        ),
                      }));
                    }}
                  >
                    Validation checks{' '}
                    <span>
                      {passed}/{artifact.checks.length} passed
                    </span>
                  </summary>
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
                </details>
              )}
              <details className="workflow-details">
                <summary>
                  Compiled plan & optimizations <span>v{artifact.version}</span>
                </summary>
                <CompilerView artifact={artifact} />
              </details>
              <details className="workflow-details">
                <summary>
                  Artifact details & JSON <span>{artifact.status}</span>
                </summary>
                <div className="detail-content">
                  <div className="code-header">
                    <span>
                      {artifact.name} v{artifact.version} · {artifact.status}
                    </span>
                    <code>sha256 {artifact.digest.slice(0, 24)}…</code>
                  </div>
                  <pre className="json-block">{JSON.stringify(artifact.ir, null, 2)}</pre>
                  <a
                    className="button secondary"
                    href={`/api/v2/capabilities/${artifact.id}/artifact`}
                    download
                  >
                    Download artifact
                  </a>
                </div>
              </details>
            </>
          ) : (
            <div className="workflow-empty">
              <ShieldCheck size={27} />
              <h3>Build a candidate first</h3>
              <p>
                Validation checks the compiled artifact. Start by collecting evidence and compiling
                a plan.
              </p>
              <button className="button primary" onClick={() => setView('Build')}>
                Go to Build
                <ArrowRight size={13} />
              </button>
            </div>
          ))}
        {view === 'Run' && (
          <>
            {!deployed && (
              <div className="workflow-next-action">
                <div className="workflow-action-icon">
                  <ShieldCheck size={20} />
                </div>
                <div>
                  <strong>Approval comes before execution</strong>
                  <p>Validate and approve a candidate before testing its compiled execution.</p>
                </div>
                <button
                  className="button secondary"
                  onClick={() => setView(artifact ? 'Validate' : 'Build')}
                >
                  {artifact ? 'Go to Validate' : 'Go to Build'}
                  <ArrowRight size={13} />
                </button>
              </div>
            )}
            {deployed && (
              <p className="workflow-deployment">
                <ShieldCheck size={13} />
                Testing deployed version: {deployed.name} v{deployed.version}
              </p>
            )}
            <div className="workflow-run-form">
              <label className="field">
                Customer id
                <input value={customerId} onChange={(event) => setCustomerId(event.target.value)} />
              </label>
              <button
                className="button primary"
                disabled={busy || !deployed}
                onClick={() =>
                  void act('Task dispatched.', () =>
                    call('/tasks/dispatch', { kind: 'customer_context', input: { customerId } }),
                  )
                }
              >
                <Play size={13} />
                Dispatch task
              </button>
            </div>
            <p className="hint workflow-run-hint">
              Read-only sandbox: C-101 and C-202 are covered. C-303 is ineligible; C-404 tests
              guarded fallback. Runtime guards remain authoritative.
            </p>
            {lastRun && (
              <div
                className={`workflow-run-result ${lastRun.outcome !== 'success' ? 'workflow-result-warning' : ''}`}
              >
                <div className="workflow-result-heading">
                  <ShieldCheck size={17} />
                  <div>
                    <strong>
                      {lastRun.mode === 'compiled' && lastRun.outcome === 'success'
                        ? 'Compiled execution completed'
                        : lastRun.outcome === 'success'
                          ? 'Authorized fallback completed'
                          : 'Compiled execution unavailable'}
                    </strong>
                    <p>
                      mode: {lastRun.mode} · outcome: {lastRun.outcome}
                      {lastRun.capability
                        ? ` · ${lastRun.capability} v${lastRun.capabilityVersion}`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="workflow-result-metrics">
                  <div>
                    <span>Business reads</span>
                    <strong>{lastRun.adapterCalls}</strong>
                  </div>
                  <div>
                    <span>Complete runtime</span>
                    <strong>
                      {Math.round(lastRun.durationMs)}
                      <small>ms</small>
                    </strong>
                  </div>
                  <div>
                    <span>Compiled model calls</span>
                    <strong>{lastRun.mode === 'compiled' ? '0' : '—'}</strong>
                  </div>
                </div>
                <p className="hint">
                  LLM calls inside compiled portion: {lastRun.mode === 'compiled' ? 0 : '—'}
                </p>
                <details className="workflow-details">
                  <summary>
                    Guard checks{' '}
                    <span>
                      {lastRun.guards.filter((guard) => guard.ok).length}/{lastRun.guards.length}{' '}
                      passed
                    </span>
                  </summary>
                  <div className="table-scroll">
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
                  </div>
                </details>
                <details className="workflow-details">
                  <summary>Execution details & output</summary>
                  <pre className="json-block">
                    {JSON.stringify(
                      lastRun.mode === 'compiled'
                        ? {
                            executedNodeIds: lastRun.executedNodeIds,
                            adapterCalls: lastRun.adapterCalls,
                            peakParallel: lastRun.peakParallel,
                            durationMs: Math.round(lastRun.durationMs),
                            observable: lastRun.observable,
                            result: lastRun.result,
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
                </details>
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
              </div>
            )}
            <details className="workflow-details">
              <summary>
                Performance & run history <span>{state.runs.length} runs</span>
              </summary>
              <div className="detail-content">
                {state.runs.length > 0 && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Input</th>
                          <th>Path</th>
                          <th>Outcome</th>
                          <th>Latency</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.runs.slice(0, 8).map((run) => (
                          <tr key={run.id}>
                            <td>
                              <code>{JSON.stringify(run.input)}</code>
                            </td>
                            <td>{run.mode}</td>
                            <td>{run.outcome}</td>
                            <td>{Math.round(run.durationMs)}ms</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {state.profiles.length === 0 ? (
                  <p className="hint">Run a capability to collect its execution profile.</p>
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
            </details>
          </>
        )}
      </div>
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
