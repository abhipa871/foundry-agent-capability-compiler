import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  Box,
  Braces,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Cpu,
  Database,
  ExternalLink,
  FileJson,
  GitBranch,
  Layers3,
  LayoutGrid,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Play,
  Plus,
  Radar,
  Rocket,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Waypoints,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import type { Capability, CodingCapability, CodingAgentSession, Run, State } from '../domain';
import { CodingRegistryPanel } from './CodingRegistryPanel';
import { JitPanel } from './JitPanel';

type Page =
  | 'Agent chat'
  | 'Registry'
  | 'JIT compiler'
  | 'Trajectories'
  | 'Executions'
  | 'Capability graph'
  | 'Audit log';
type Modal = 'capture' | 'approve' | 'reject' | 'run' | null;
const captureTabs = ['Demo workflow', 'Normalized JSON', 'Raw event log'] as const;
type CaptureTab = (typeof captureTabs)[number];
const nav: { label: Page; icon: typeof Box }[] = [
  { label: 'Agent chat', icon: MessageSquareText },
  { label: 'Registry', icon: LayoutGrid },
  { label: 'JIT compiler', icon: Cpu },
  { label: 'Trajectories', icon: Radar },
  { label: 'Executions', icon: Activity },
  { label: 'Capability graph', icon: Waypoints },
  { label: 'Audit log', icon: ShieldCheck },
];
const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const time = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    `/api${path}`,
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
function Badge({ children, kind = 'neutral' }: { children: ReactNode; kind?: string }) {
  return (
    <span className={`badge ${kind}`}>
      <span />
      {children}
    </span>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <Layers3 size={28} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onCancel={close}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="Close dialog">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [page, setPage] = useState<Page>('Agent chat');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState('Overview');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All capabilities');
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [startupError, setStartupError] = useState('');
  const [captureTab, setCaptureTab] = useState<CaptureTab>('Demo workflow');
  const [json, setJson] = useState('');
  const [reviewNote, setReviewNote] = useState(
    'Reviewed tests, permissions, and financial limits for local demo execution.',
  );
  const [delay, setDelay] = useState(5);
  const [credit, setCredit] = useState(20);
  const [fault, setFault] = useState('none');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [maxCredit, setMaxCredit] = useState(50);
  const [maxTotal, setMaxTotal] = useState(200);
  const [agentTask, setAgentTask] = useState(
    'Add a short docs note that explains how raw agent failures become branchAnalysis.',
  );
  const [providerId, setProviderId] = useState('codex-cli-gpt-5-5-high');
  const [selectedAgentSession, setSelectedAgentSession] = useState<string | null>(null);
  const [selectedCodingId, setSelectedCodingId] = useState<string | null>(null);

  async function refresh() {
    const value = await api<State>('/state');
    setState(value);
    return value;
  }
  useEffect(() => {
    let alive = true;
    api<State>('/state')
      .then((s) => {
        if (alive) setState(s);
      })
      .catch((e) => {
        if (alive) setStartupError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const cap = state?.capabilities.find((c) => c.id === selectedId) ?? state?.capabilities[0];
  const currentRun = state?.runs.find((r) => r.id === selectedRun) ?? state?.runs[0];
  const agentSession =
    state?.agentSessions.find((session) => session.id === selectedAgentSession) ??
    state?.agentSessions[0];
  const agentDeployment = agentSession?.deploymentId
    ? state?.agentDeployments.find((deployment) => deployment.id === agentSession.deploymentId)
    : undefined;
  async function act<T>(task: () => Promise<T>, message: string, after?: (result: T) => void) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await task();
      await refresh();
      setNotice({ text: message, error: false });
      after?.(result);
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'Something went wrong',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }
  function compileTrace(
    trajectoryId: string,
    policy = {
      maxCredit,
      maxTotal,
      scopes: ['shipments:read', 'credits:write', 'crm:write', 'notifications:send'],
    },
  ) {
    void act(
      () => api<Capability>('/capabilities', { trajectoryId, policy }),
      'Typed capability compiled. Run verification to continue.',
      (c) => {
        setSelectedId(c.id);
        setPage('Registry');
        setDetailTab('Implementation');
      },
    );
  }
  async function loadCaptureTemplate(tab: CaptureTab) {
    if (tab === 'Demo workflow') return;
    const path = tab === 'Raw event log' ? '/raw-trajectory-template' : '/trajectory-template';
    setJson(pretty(await api<unknown>(path)));
  }
  async function openCapture() {
    setModal('capture');
    if (!json)
      try {
        await loadCaptureTemplate(captureTab);
      } catch (e) {
        setNotice({ text: String(e), error: true });
      }
  }
  function captureWorkflow(event: FormEvent) {
    event.preventDefault();
    void act(
      async () => {
        const trace =
          captureTab === 'Demo workflow'
            ? await api<{ id: string }>('/trajectories/demo', {})
            : await api<{ id: string }>(
                captureTab === 'Raw event log' ? '/trajectories/raw' : '/trajectories',
                JSON.parse(json),
              );
        return api<Capability>('/capabilities', {
          trajectoryId: trace.id,
          policy: {
            maxCredit,
            maxTotal,
            scopes: ['shipments:read', 'credits:write', 'crm:write', 'notifications:send'],
          },
        });
      },
      'Trajectory captured and capability compiled.',
      (c) => {
        setSelectedId(c.id);
        setModal(null);
        setPage('Registry');
        setDetailTab('Overview');
      },
    );
  }
  function runWorkflow(event: FormEvent) {
    event.preventDefault();
    if (!cap) return;
    void act(
      () =>
        api<Run>(`/capabilities/${cap.id}/run`, {
          input: { delay_days: delay, credit_amount: credit },
          idempotencyKey: crypto.randomUUID(),
          fault,
        }),
      'Execution recorded.',
      (r) => {
        setSelectedRun(r.id);
        setModal(null);
        setPage('Executions');
        if (r.error) setNotice({ text: r.error, error: true });
      },
    );
  }
  function runAgentWorkflow(event: FormEvent) {
    event.preventDefault();
    void act(
      () =>
        api<CodingAgentSession>('/agent/sessions', {
          task: agentTask,
          providerId,
        }),
      'Coding-agent trajectory recorded.',
      (session) => {
        setSelectedAgentSession(session.id);
        setPage('Agent chat');
      },
    );
  }
  function deployAgentWorkflow(session: CodingAgentSession) {
    void act(
      () => api<CodingCapability>(`/agent/sessions/${session.id}/register`, {}),
      'Task added to the registry. Configure assertions and run security checks.',
      (capability) => {
        setSelectedCodingId(capability.id);
        setFilter('All capabilities');
        setQuery('');
        setPage('Registry');
      },
    );
  }
  const live = state ? Object.keys(state.deployments).length : 0;
  const registeredCount =
    (state?.capabilities.length ?? 0) + (state?.codingCapabilities?.length ?? 0);
  const verified =
    (state?.capabilities.filter((c) => c.status === 'verified').length ?? 0) +
    (state?.codingCapabilities?.filter((c) => c.status === 'verified').length ?? 0);
  const active = cap && state?.deployments[cap.name] === cap.id;
  const compatible = cap && cap.contractVersion === state?.contractVersion;
  const healthy = cap && compatible && cap.checks.length > 0 && cap.checks.every((c) => c.passed);
  const filtered =
    state?.capabilities.filter(
      (c) =>
        (c.name + c.description).toLowerCase().includes(query.toLowerCase()) &&
        (filter === 'All capabilities' ||
          (filter === 'Needs review'
            ? c.status === 'verified'
            : state.deployments[c.name] === c.id)),
    ) ?? [];

  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('Registry');
          }}
        >
          <div className="brand-mark">
            <Layers3 size={24} />
          </div>
          foundry<span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <div className="workspace-logo">A</div>
          <div>
            <strong>Acme workspace</strong>
            <small>Development</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`nav-item ${page === label ? 'active' : ''}`}
              onClick={() => {
                setPage(label);
                setQuery('');
              }}
            >
              <Icon size={18} />
              {label}
              {label === 'Registry' && <span className="nav-count">{registeredCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sandbox-card">
            <span className="sandbox-icon">
              <Box size={18} />
            </span>
            <strong>Your sandbox is ready</strong>
            <p>Explore the full capability lifecycle with safe, local integrations.</p>
            <span className="sandbox-status">
              <span /> Local demo environment
            </span>
          </div>
          <div className="profile">
            <div className="avatar">LO</div>
            <div>
              <strong>Local operator</strong>
              <small>Workspace administrator</small>
            </div>
            <MoreHorizontal size={18} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-indicator">
              <span /> Local mode
            </span>
            <span className="separator" />
            <span className="version-label">MVP v0.1</span>
            <div className="avatar small">LO</div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">AGENT CAPABILITY COMPILER</div>
              <h1>{page === 'Registry' ? 'From one-off to always-on.' : page}</h1>
              <p>
                {
                  {
                    Registry:
                      'Turn successful agent workflows into trusted, reusable capabilities.',
                    'Agent chat':
                      'Ask a coding agent to complete a task, record its trajectory, and compare deployment token usage.',
                    'JIT compiler':
                      'Structured trajectories compiled into a guarded IR program, and dispatched without inference.',
                    Trajectories:
                      'The evidence behind every capability. Capture once, build on what works.',
                    Executions: 'Every invocation, every outcome. A clear record of what happened.',
                    'Capability graph':
                      'See what your agents can do, and the systems they depend on.',
                    'Audit log': 'An accountable history of decisions, deployments, and execution.',
                  }[page]
                }
              </p>
            </div>
            <button className="button primary" onClick={() => void openCapture()} disabled={busy}>
              <Plus size={17} />
              New capability
            </button>
          </div>
          {startupError && (
            <div className="error-box">
              Cannot reach the API. Start the app with npm run dev. {startupError}
              <button onClick={() => window.location.reload()}>Retry</button>
            </div>
          )}
          {!state && !startupError && (
            <div className="loading">
              <LoaderCircle className="spin" /> Loading your workspace…
            </div>
          )}
          {state && (
            <>
              <section className="metrics" aria-label="Workspace metrics">
                <Metric
                  title="Registered versions"
                  value={String(registeredCount).padStart(2, '0')}
                  note={`${live} active deployment${live !== 1 ? 's' : ''}`}
                  icon={<Box size={17} />}
                />
                <Metric
                  title="Awaiting approval"
                  value={String(verified).padStart(2, '0')}
                  note="Verified and ready for review"
                  icon={<ShieldCheck size={17} />}
                />
                <Metric
                  title="Successful executions"
                  value={String(state.metrics.successful).padStart(2, '0')}
                  note={`${state.metrics.total} total invocation${state.metrics.total !== 1 ? 's' : ''}`}
                  icon={<Activity size={17} />}
                />
                <Metric
                  title="Average runtime"
                  value={
                    state.metrics.successful ? `${state.metrics.avgLatencyMs.toFixed(1)}` : '—'
                  }
                  suffix={state.metrics.successful ? 'ms' : undefined}
                  note="Measured local adapter execution"
                  icon={<Zap size={17} />}
                />
              </section>
              {page === 'Agent chat' && (
                <div className="agent-layout">
                  <section className="panel agent-composer">
                    <div className="section-header">
                      <div>
                        <h2>Coding-agent chat</h2>
                        <p>Run a task through Codex CLI, then deploy the recorded path.</p>
                      </div>
                      <Badge kind="green">Codex CLI</Badge>
                    </div>
                    <form onSubmit={runAgentWorkflow} className="agent-form">
                      <label className="field">
                        Task for the coding agent
                        <textarea
                          required
                          rows={7}
                          value={agentTask}
                          onChange={(e) => setAgentTask(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        Provider
                        <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                          {state.agentProviders.map((provider) => (
                            <option
                              key={provider.id}
                              value={provider.id}
                              disabled={!provider.enabled}
                            >
                              {provider.label}
                              {!provider.enabled ? ' (future)' : ''}
                            </option>
                          ))}
                        </select>
                        <small>
                          Current adapter uses the local Codex CLI with GPT 5.5 and high reasoning.
                        </small>
                      </label>
                      <button className="button primary full" disabled={busy}>
                        {busy ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <MessageSquareText size={16} />
                        )}
                        Run and record trajectory
                      </button>
                    </form>
                    <div className="agent-history">
                      <div className="section-label">RECORDED CHAT RUNS</div>
                      {!state.agentSessions.length ? (
                        <Empty
                          title="No coding-agent runs yet"
                          detail="Ask for a task, then deploy its recorded path to compare token usage."
                        />
                      ) : (
                        state.agentSessions.map((session) => (
                          <button
                            key={session.id}
                            className={`run-row ${agentSession?.id === session.id ? 'chosen' : ''}`}
                            onClick={() => setSelectedAgentSession(session.id)}
                          >
                            <span className={`run-icon ${session.status}`}>
                              {session.status === 'success' ? <Check size={18} /> : <X size={18} />}
                            </span>
                            <span>
                              <strong>{session.task.slice(0, 64)}</strong>
                              <small>
                                {time(session.createdAt)} · {session.usageBefore.totalTokens} tokens
                              </small>
                            </span>
                            <Badge kind={session.status === 'success' ? 'green' : 'red'}>
                              {session.status}
                            </Badge>
                          </button>
                        ))
                      )}
                    </div>
                  </section>
                  <section className="panel agent-detail">
                    {agentSession ? (
                      <>
                        <div className="section-header">
                          <div>
                            <h2>Recorded trajectory</h2>
                            <p>{agentSession.provider.label}</p>
                          </div>
                          <button
                            className="button primary"
                            disabled={busy || agentSession.status !== 'success'}
                            onClick={() => deployAgentWorkflow(agentSession)}
                          >
                            <Rocket size={16} />
                            {agentSession.registryCapabilityId
                              ? 'Open in registry'
                              : 'Prepare deployment'}
                          </button>
                        </div>
                        <div className="agent-detail-body">
                          <div className="usage-grid">
                            <UsageCard
                              title="Before deployment"
                              usage={agentSession.usageBefore}
                              note="Exploratory chat run"
                            />
                            <UsageCard
                              title="After deployment"
                              usage={agentDeployment?.usage}
                              note={
                                agentDeployment
                                  ? `${agentDeployment.tokenDelta >= 0 ? '-' : '+'}${Math.abs(
                                      agentDeployment.tokenDelta,
                                    )} tokens (${agentDeployment.tokenReductionPercent}%)`
                                  : 'Deploy this trajectory to measure'
                              }
                            />
                          </div>
                          <div className="agent-message">
                            <div className="section-label">USER TASK</div>
                            <p>{agentSession.task}</p>
                          </div>
                          <div className="agent-message">
                            <div className="section-label">AGENT OUTPUT</div>
                            <pre className="json-block">{agentSession.lastOutput}</pre>
                          </div>
                          {agentDeployment && (
                            <div className="agent-message">
                              <div className="section-label">DEPLOYMENT OUTPUT</div>
                              <pre className="json-block">{agentDeployment.output}</pre>
                            </div>
                          )}
                          <details className="branch-details" open>
                            <summary>Recorded branch analysis</summary>
                            <pre className="json-block">{pretty(agentSession.branchAnalysis)}</pre>
                          </details>
                        </div>
                      </>
                    ) : (
                      <Empty
                        title="Ask the coding agent"
                        detail="The successful path, discarded failures, and token usage will appear here."
                      />
                    )}
                  </section>
                </div>
              )}
              {page === 'Registry' && (
                <>
                  <CodingRegistryPanel
                    capabilities={state.codingCapabilities ?? []}
                    deployments={state.agentDeployments}
                    active={state.deployments}
                    selectedId={selectedCodingId}
                    select={setSelectedCodingId}
                    busy={busy}
                    query={query}
                    filter={filter}
                    action={(path, data, message) =>
                      void act(
                        () =>
                          api<CodingCapability | { capabilityId?: string; error?: string }>(
                            path,
                            data,
                          ),
                        message,
                        (result) => {
                          if ('policy' in result) setSelectedCodingId(result.id);
                          else if (result.error) setNotice({ text: result.error, error: true });
                        },
                      )
                    }
                  />
                  <section className="panel registry-panel">
                    <div className="panel-toolbar">
                      <div className="tabs">
                        {['All capabilities', 'Needs review', 'Deployed'].map((t) => (
                          <button
                            key={t}
                            className={filter === t ? 'selected' : ''}
                            onClick={() => setFilter(t)}
                          >
                            {t}
                            {t === 'All capabilities' && (
                              <span>
                                {state.capabilities.length +
                                  (state.codingCapabilities?.length ?? 0)}
                              </span>
                            )}
                            {t === 'Needs review' && verified > 0 && <span>{verified}</span>}
                          </button>
                        ))}
                      </div>
                      <label className="search">
                        <Search size={15} />
                        <input
                          aria-label="Search capabilities"
                          placeholder="Search capabilities…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                        <kbd>/</kbd>
                      </label>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>CAPABILITY</th>
                            <th>STATUS</th>
                            <th>VERIFICATION</th>
                            <th>VERSION</th>
                            <th>CREATED</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((c) => {
                            const isLive = state.deployments[c.name] === c.id;
                            const stale = c.contractVersion !== state.contractVersion;
                            return (
                              <tr key={c.id} className={cap?.id === c.id ? 'selected-row' : ''}>
                                <td>
                                  <button
                                    className="cap-name"
                                    onClick={() => {
                                      setSelectedId(c.id);
                                      setDetailTab('Overview');
                                    }}
                                  >
                                    <span className="cap-icon">
                                      <Braces size={20} />
                                    </span>
                                    <span>
                                      <strong>{c.name}</strong>
                                      <small>Customer operations · 4 connected steps</small>
                                    </span>
                                  </button>
                                </td>
                                <td>
                                  <Badge
                                    kind={
                                      stale
                                        ? 'red'
                                        : isLive
                                          ? 'green'
                                          : c.status === 'verified'
                                            ? 'amber'
                                            : 'neutral'
                                    }
                                  >
                                    {stale
                                      ? 'Needs revalidation'
                                      : isLive
                                        ? 'Deployed'
                                        : c.status === 'verified'
                                          ? 'Ready for review'
                                          : c.status}
                                  </Badge>
                                </td>
                                <td>
                                  <span className="test-count">
                                    {c.checks.length ? (
                                      <CheckCheck size={15} />
                                    ) : (
                                      <Circle size={14} />
                                    )}{' '}
                                    {c.checks.length
                                      ? `${c.checks.filter((v) => v.passed).length}/${c.checks.length} passed`
                                      : 'Not run'}
                                  </span>
                                </td>
                                <td>
                                  <code className="version-pill">v{c.version}.0</code>
                                </td>
                                <td className="muted">{time(c.createdAt)}</td>
                                <td>
                                  <button
                                    className="icon-button"
                                    aria-label={`Open version ${c.version}`}
                                    onClick={() => setSelectedId(c.id)}
                                  >
                                    <ChevronRight size={17} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {!filtered.length && (
                      <Empty
                        title="No matching capabilities"
                        detail="Capture a workflow or try a different filter."
                      />
                    )}
                    <div className="table-footer">
                      <span>
                        {filtered.length} capability version{filtered.length !== 1 ? 's' : ''}
                      </span>
                      <span>
                        <ShieldCheck size={13} /> Every deployment starts with verification
                      </span>
                    </div>
                  </section>
                  {cap && (
                    <div className="detail-layout">
                      <section className="panel detail-panel">
                        <div className="detail-heading">
                          <div>
                            <span className="section-kicker">CAPABILITY DETAIL</span>
                            <h2>
                              {cap.name}
                              <code className="version-pill">v{cap.version}.0</code>
                            </h2>
                            <p>{cap.description}</p>
                          </div>
                          <a
                            className="icon-button"
                            href={`/api/capabilities/${cap.id}/artifact`}
                            aria-label="Download capability artifact"
                            title="Download capability artifact"
                          >
                            <ArrowDownToLine size={19} />
                          </a>
                        </div>
                        <div className="tabs detail-tabs">
                          {['Overview', 'Implementation', 'Verification', 'Version history'].map(
                            (t) => (
                              <button
                                className={detailTab === t ? 'selected' : ''}
                                key={t}
                                onClick={() => setDetailTab(t)}
                              >
                                {t}
                                {t === 'Verification' && <span>{cap.checks.length}</span>}
                              </button>
                            ),
                          )}
                        </div>
                        <div className="detail-content">
                          {detailTab === 'Overview' && (
                            <>
                              <div className="section-label">
                                WORKFLOW <span>4 steps · deterministic execution</span>
                              </div>
                              <div className="workflow">
                                {[
                                  { icon: Search, label: 'Find shipments', sub: 'Shipping portal' },
                                  { icon: Database, label: 'Issue credits', sub: 'Credit ledger' },
                                  { icon: GitBranch, label: 'Update CRM', sub: 'Salesforce demo' },
                                  {
                                    icon: Bell,
                                    label: 'Notify owners',
                                    sub: 'Notification outbox',
                                  },
                                ].map(({ icon: Icon, label, sub }, i) => (
                                  <div className="workflow-step" key={label}>
                                    <div className="step-icon">
                                      <Icon size={18} />
                                    </div>
                                    <strong>{label}</strong>
                                    <small>{sub}</small>
                                    {i < 3 && <ArrowRight className="step-arrow" size={15} />}
                                  </div>
                                ))}
                              </div>
                              <div className="io-grid">
                                <div>
                                  <div className="section-label">INPUT CONTRACT</div>
                                  <div className="input-row">
                                    <code>delay_days</code>
                                    <span>integer · 1–90</span>
                                  </div>
                                  <div className="input-row">
                                    <code>credit_amount</code>
                                    <span>USD · 0.01–1,000</span>
                                  </div>
                                </div>
                                <div>
                                  <div className="section-label">EXECUTION GUARANTEES</div>
                                  {[
                                    'Typed input validation',
                                    'Idempotent customer credits',
                                    'Atomic local transactions',
                                  ].map((text) => (
                                    <div className="guarantee" key={text}>
                                      <Check size={14} />
                                      {text}
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="provenance">
                                <Radar size={17} />
                                <span>
                                  Compiled from a{' '}
                                  {state.trajectories.find((t) => t.id === cap.trajectoryId)
                                    ?.source === 'demo'
                                    ? 'recorded demo'
                                    : 'submitted'}{' '}
                                  trajectory
                                </span>
                                <button onClick={() => setPage('Trajectories')}>
                                  View source <ArrowRight size={13} />
                                </button>
                              </div>
                            </>
                          )}
                          {detailTab === 'Implementation' && (
                            <>
                              <div className="code-header">
                                <span>
                                  <Code2 size={15} /> Generated wrapper preview
                                </span>
                                <code>sha256:{cap.digest.slice(0, 12)}</code>
                              </div>
                              <pre className="code-block">{cap.implementation}</pre>
                              <p className="hint">
                                The local runtime interprets an allowlisted plan. Download the
                                artifact for the wrapper, schemas, provenance, and test results.
                              </p>
                              <details>
                                <summary>Input / output JSON schemas</summary>
                                <pre className="json-block">
                                  {pretty({ input: cap.inputSchema, output: cap.outputSchema })}
                                </pre>
                              </details>
                            </>
                          )}
                          {detailTab === 'Verification' && (
                            <>
                              <div className="verification-summary">
                                <ShieldCheck size={24} />
                                <div>
                                  <strong>
                                    {cap.checks.length
                                      ? `${cap.checks.filter((c) => c.passed).length} of ${cap.checks.length} checks passed`
                                      : 'Ready for sandbox validation'}
                                  </strong>
                                  <p>
                                    Isolated fixtures · schema, failure, policy, and regression
                                    tests
                                  </p>
                                </div>
                                <button
                                  className="button secondary small-button"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      () => api(`/capabilities/${cap.id}/verify`, {}),
                                      'Verification completed.',
                                    )
                                  }
                                >
                                  Run suite
                                </button>
                              </div>
                              {cap.checks.map((c) => (
                                <div className="check-row" key={c.name}>
                                  {c.passed ? (
                                    <CheckCircle2 size={17} className="green-text" />
                                  ) : (
                                    <XCircle size={17} className="red-text" />
                                  )}
                                  <div>
                                    <strong>{c.name}</strong>
                                    <small>{c.detail}</small>
                                  </div>
                                  <span className="category">{c.category}</span>
                                </div>
                              ))}
                            </>
                          )}
                          {detailTab === 'Version history' && (
                            <div className="version-list">
                              {state.capabilities
                                .filter((c) => c.name === cap.name)
                                .map((c) => (
                                  <div className="version-row" key={c.id}>
                                    <div className="version-icon">
                                      <GitBranch size={17} />
                                    </div>
                                    <div>
                                      <strong>
                                        Version {c.version}.0{' '}
                                        {state.deployments[c.name] === c.id && (
                                          <Badge kind="green">Active</Badge>
                                        )}
                                      </strong>
                                      <small>
                                        {time(c.createdAt)} · {c.status} · contract{' '}
                                        {c.contractVersion}
                                      </small>
                                    </div>
                                    {c.status === 'approved' &&
                                    state.deployments[c.name] !== c.id ? (
                                      <button
                                        className="button secondary small-button"
                                        disabled={
                                          busy || c.contractVersion !== state.contractVersion
                                        }
                                        onClick={() =>
                                          void act(
                                            () => api(`/capabilities/${c.id}/deploy`, {}),
                                            `Version ${c.version} is now active.`,
                                          )
                                        }
                                      >
                                        <RotateCcw size={14} />
                                        Restore
                                      </button>
                                    ) : (
                                      <button
                                        className="text-button"
                                        onClick={() => setSelectedId(c.id)}
                                      >
                                        Inspect
                                      </button>
                                    )}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      </section>
                      <aside className="panel trust-panel">
                        <div className="trust-heading">
                          <ShieldCheck size={19} />
                          <h3>Trust & deployment</h3>
                        </div>
                        <div className={`trust-banner ${healthy ? 'ready' : ''}`}>
                          <span className="status-orb">
                            {healthy ? <Check size={17} /> : <Clock3 size={17} />}
                          </span>
                          <div>
                            <strong>
                              {!compatible
                                ? 'Adapter changed'
                                : active
                                  ? 'Available to your agents'
                                  : healthy
                                    ? 'Ready for your review'
                                    : 'Verification required'}
                            </strong>
                            <small>
                              {!compatible
                                ? 'Compile a new version to continue.'
                                : active
                                  ? 'Policy enforced on every invocation.'
                                  : healthy
                                    ? 'All checks passed in the sandbox.'
                                    : 'Validate before granting access.'}
                            </small>
                          </div>
                        </div>
                        <div className="policy-values">
                          <div>
                            <span>Environment</span>
                            <strong>Local sandbox</strong>
                          </div>
                          <div>
                            <span>Risk classification</span>
                            <Badge kind="amber">Financial action</Badge>
                          </div>
                          <div>
                            <span>Per-customer limit</span>
                            <strong>{money(cap.policy.maxCredit)}</strong>
                          </div>
                          <div>
                            <span>Per-execution limit</span>
                            <strong>{money(cap.policy.maxTotal)}</strong>
                          </div>
                          <div>
                            <span>Adapter contract</span>
                            <strong>v{cap.contractVersion}</strong>
                          </div>
                        </div>
                        <div className="permission-list">
                          <div className="section-label">REQUIRED PERMISSIONS</div>
                          {cap.requiredScopes.map((s) => (
                            <span key={s}>
                              <Check size={12} />
                              {s}
                            </span>
                          ))}
                        </div>
                        <div className="trust-actions">
                          {active ? (
                            <button
                              className="button primary full"
                              disabled={busy || !healthy}
                              onClick={() => setModal('run')}
                            >
                              <Play size={15} />
                              Run capability
                            </button>
                          ) : cap.status === 'verified' ? (
                            <>
                              <button
                                className="button primary full"
                                disabled={busy || !healthy}
                                onClick={() => setModal('approve')}
                              >
                                <ShieldCheck size={16} />
                                Approve & deploy
                              </button>
                              <button
                                className="text-button full"
                                onClick={() => setModal('reject')}
                                disabled={busy}
                              >
                                Request changes
                              </button>
                            </>
                          ) : cap.status === 'approved' ? (
                            <button
                              className="button primary full"
                              disabled={busy || !healthy}
                              onClick={() =>
                                void act(
                                  () => api(`/capabilities/${cap.id}/deploy`, {}),
                                  'Approved version restored.',
                                )
                              }
                            >
                              <RotateCcw size={15} />
                              Restore this version
                            </button>
                          ) : (
                            <button
                              className="button primary full"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  () => api(`/capabilities/${cap.id}/verify`, {}),
                                  'Verification completed.',
                                  () => setDetailTab('Verification'),
                                )
                              }
                            >
                              <Play size={15} />
                              Run verification
                            </button>
                          )}
                          <button
                            className="button secondary full"
                            disabled={busy}
                            onClick={() => compileTrace(cap.trajectoryId, cap.policy)}
                          >
                            <GitBranch size={15} />
                            Compile new version
                          </button>
                        </div>
                        <p className="trust-footnote">
                          <Circle size={10} /> Local demo operator · no production access
                        </p>
                      </aside>
                    </div>
                  )}
                  <div className="bottom-note">
                    <Sparkles size={16} />
                    <p>
                      Explore once. Reuse with confidence.
                      <span> Your next agent starts where the last one left off.</span>
                    </p>
                  </div>
                </>
              )}
              {page === 'Trajectories' && (
                <section className="panel">
                  <div className="section-header">
                    <div>
                      <h2>Captured workflows</h2>
                      <p>Supported in v0.1: late-shipment service recovery.</p>
                    </div>
                    <button className="button secondary" onClick={() => void openCapture()}>
                      <FileJson size={16} />
                      Import trajectory
                    </button>
                  </div>
                  {state.trajectories.map((t) => (
                    <article className="trajectory" key={t.id}>
                      <div className="trajectory-header">
                        <span className="cap-icon">
                          <Radar size={21} />
                        </span>
                        <div>
                          <h3>{t.name}</h3>
                          <small>
                            {t.model} · {time(t.createdAt)}
                          </small>
                        </div>
                        <Badge kind="green">Successful {t.source}</Badge>
                        {t.branchAnalysis && (
                          <Badge kind="amber">
                            {t.branchAnalysis.discarded.length} branches pruned
                          </Badge>
                        )}
                        <button
                          className="button secondary small-button"
                          disabled={busy}
                          onClick={() => compileTrace(t.id)}
                        >
                          <Cpu size={15} />
                          Compile
                        </button>
                      </div>
                      <p className="task-quote">“{t.task}”</p>
                      <div className="trace-steps">
                        {t.steps.map((s, i) => (
                          <div key={s.operation}>
                            <span className="step-number">0{i + 1}</span>
                            <div>
                              <strong>{s.operation}</strong>
                              <p>{s.description}</p>
                            </div>
                            <code className="version-pill">{s.transport}</code>
                            <ArrowRight size={13} />
                            <code className="version-pill green-text">typed adapter</code>
                          </div>
                        ))}
                      </div>
                      {t.branchAnalysis && (
                        <details className="branch-details">
                          <summary>Filtered raw tool calls</summary>
                          <pre className="json-block">{pretty(t.branchAnalysis)}</pre>
                        </details>
                      )}
                      <div className="trajectory-footer">
                        <span>
                          Recorded duration: {(t.durationMs / 1000).toFixed(1)}s{' '}
                          {t.source === 'demo' ? '(illustrative)' : '(submitted)'}
                        </span>
                        <span>
                          Input: {t.inputs.delay_days} days · {money(t.inputs.credit_amount)} credit
                        </span>
                      </div>
                    </article>
                  ))}
                </section>
              )}
              {page === 'Executions' && (
                <div className="executions-layout">
                  <section className="panel">
                    <div className="section-header">
                      <div>
                        <h2>Execution history</h2>
                        <p>{money(state.metrics.totalCredit)} in active demo credits</p>
                      </div>
                      <Badge>Persistent ledger</Badge>
                    </div>
                    {!state.runs.length ? (
                      <Empty
                        title="Your first run starts here"
                        detail="Approve a verified capability, then run it to see its results and audit trail."
                      />
                    ) : (
                      state.runs.map((r) => (
                        <button
                          key={r.id}
                          className={`run-row ${currentRun?.id === r.id ? 'chosen' : ''}`}
                          onClick={() => setSelectedRun(r.id)}
                        >
                          <span className={`run-icon ${r.status}`}>
                            {r.status === 'success' ? (
                              <Check size={19} />
                            ) : r.status === 'compensated' ? (
                              <RotateCcw size={18} />
                            ) : (
                              <X size={18} />
                            )}
                          </span>
                          <span>
                            <strong>{r.name}</strong>
                            <small>
                              {time(r.createdAt)} · v{r.version} · {r.durationMs.toFixed(2)}ms
                            </small>
                          </span>
                          <Badge
                            kind={
                              r.status === 'success'
                                ? 'green'
                                : r.status === 'compensated'
                                  ? 'neutral'
                                  : 'red'
                            }
                          >
                            {r.status}
                          </Badge>
                        </button>
                      ))
                    )}
                  </section>
                  {currentRun && (
                    <section className="panel run-detail">
                      <div className="section-header">
                        <h2>Run receipt</h2>
                        <code>{currentRun.id.slice(0, 8)}</code>
                      </div>
                      <div className="receipt-metrics">
                        <div>
                          <strong>{currentRun.output?.customers ?? '—'}</strong>
                          <span>customers</span>
                        </div>
                        <div>
                          <strong>{money(currentRun.output?.totalCredit ?? 0)}</strong>
                          <span>
                            {currentRun.status === 'compensated'
                              ? 'reversed credit'
                              : 'demo credit'}
                          </span>
                        </div>
                      </div>
                      <div className="run-body">
                        <div className="section-label">EXECUTION LOG</div>
                        {currentRun.logs.map((l, i) => (
                          <div className="log-line" key={i}>
                            <span>{String(i + 1).padStart(2, '0')}</span>
                            <p>{l}</p>
                          </div>
                        ))}
                        {currentRun.output?.effects.map((e) => (
                          <div className="effect" key={e.id}>
                            <strong>
                              {e.customer}
                              <span>{money(e.amount)}</span>
                            </strong>
                            <p>{e.crmStatus}</p>
                            <small>{e.notification}</small>
                          </div>
                        ))}
                        <details>
                          <summary>Request and idempotency key</summary>
                          <pre className="json-block">
                            {pretty({
                              input: currentRun.input,
                              idempotencyKey: currentRun.idempotencyKey,
                            })}
                          </pre>
                        </details>
                        {currentRun.status === 'success' && (
                          <button
                            className="button secondary full"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () => api(`/runs/${currentRun.id}/compensate`, {}),
                                'Local demo effects reversed. Original run preserved in the audit log.',
                              )
                            }
                          >
                            <RotateCcw size={15} />
                            Reverse demo transaction
                          </button>
                        )}
                      </div>
                    </section>
                  )}
                </div>
              )}
              {page === 'Capability graph' && (
                <section className="panel graph-panel">
                  <div className="section-header">
                    <div>
                      <h2>The capability graph</h2>
                      <p>Approved capabilities, policy boundaries, and system dependencies.</p>
                    </div>
                    <Badge kind="green">Contract v{state.contractVersion}</Badge>
                  </div>
                  <div className="graph-canvas">
                    <div className="graph-column">
                      <span className="section-label">POLICY</span>
                      {state.graph.nodes
                        .filter((n) => n.kind === 'policy')
                        .map((n) => (
                          <div className="graph-node policy-node" key={n.id}>
                            <ShieldCheck size={23} />
                            <strong>{n.label}</strong>
                            <small>{n.status}</small>
                          </div>
                        ))}
                    </div>
                    <ArrowRight className="graph-arrow" />
                    <div className="graph-column">
                      <span className="section-label">CAPABILITY</span>
                      {state.graph.nodes
                        .filter((n) => n.kind === 'capability')
                        .map((n) => (
                          <div className="graph-node capability-node" key={n.id}>
                            <Braces size={25} />
                            <strong>{n.label}</strong>
                            <small>{n.status}</small>
                          </div>
                        ))}
                    </div>
                    <GitBranch className="graph-arrow" />
                    <div className="graph-column">
                      <span className="section-label">DEPENDENCIES</span>
                      {state.graph.nodes
                        .filter((n) => n.kind === 'system')
                        .map((n) => (
                          <div className="graph-node system-node" key={n.id}>
                            <Database size={17} />
                            <div>
                              <strong>{n.label}</strong>
                              <small>{n.status}</small>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                  <div className="graph-footer">
                    <div>
                      <strong>Dependency change simulation</strong>
                      <p>
                        Bump the adapter contract to test stale-version blocking and recompilation.
                      </p>
                    </div>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => api('/demo/drift', {}),
                          'Contract changed. Old capabilities are blocked until recompiled and approved.',
                        )
                      }
                    >
                      <GitBranch size={15} />
                      Simulate API change
                    </button>
                  </div>
                </section>
              )}
              {page === 'JIT compiler' && (
                <JitPanel notify={(text, error = false) => setNotice({ text, error })} />
              )}
              {page === 'Audit log' && (
                <section className="panel">
                  <div className="section-header">
                    <h2>Workspace events</h2>
                    <Badge>{state.audit.length} events</Badge>
                  </div>
                  <div className="table-scroll">
                    <table className="audit-table">
                      <thead>
                        <tr>
                          <th>EVENT</th>
                          <th>DETAIL</th>
                          <th>ACTOR</th>
                          <th>TIME</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.audit.map((a) => (
                          <tr key={a.id}>
                            <td>
                              <code>{a.action}</code>
                            </td>
                            <td>{a.detail}</td>
                            <td className="muted">{a.actor}</td>
                            <td className="muted">{time(a.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
          <footer className="footer">
            <span>
              FOUNDRY <span className="footer-slash">/</span> Enterprise capability infrastructure
            </span>
            <span>
              <Terminal size={13} /> localhost · persistent SQLite registry
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div
          className={`toast ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <XCircle size={19} /> : <CheckCircle2 size={19} />}
          <span>{notice.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal === 'capture' && (
        <Dialog title="Create a capability" close={() => !busy && setModal(null)}>
          <form onSubmit={captureWorkflow}>
            <div className="dialog-body">
              <p className="dialog-intro">
                Start with a successful agent trajectory. Foundry extracts a typed workflow and
                prepares it for verification.
              </p>
              <div className="segmented">
                {captureTabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={captureTab === t ? 'active' : ''}
                    onClick={() => {
                      setCaptureTab(t);
                      void loadCaptureTemplate(t).catch((e) =>
                        setNotice({ text: String(e), error: true }),
                      );
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {captureTab === 'Demo workflow' ? (
                <div className="demo-preview">
                  <span className="cap-icon">
                    <Braces size={23} />
                  </span>
                  <h3>Late-shipment recovery</h3>
                  <p>
                    Find delayed shipments, credit customers, update the CRM, and notify account
                    managers.
                  </p>
                  <div>
                    <Badge>4 observed steps</Badge>
                    <Badge>Recorded demo</Badge>
                  </div>
                </div>
              ) : (
                <label className="field">
                  {captureTab === 'Raw event log'
                    ? 'Raw agent event log JSON'
                    : 'Successful trajectory JSON'}
                  <textarea
                    required
                    rows={12}
                    value={json}
                    onChange={(e) => setJson(e.target.value)}
                    spellCheck={false}
                  />
                  <small>
                    {captureTab === 'Raw event log'
                      ? 'Accepts successful, failed, and abandoned tool calls. Failed branches are filtered into branchAnalysis.'
                      : 'Accepts the four supported operations in order. Only normalized metadata is stored.'}
                  </small>
                </label>
              )}
              <div className="form-grid">
                <label className="field">
                  Per-customer limit ($)
                  <input
                    required
                    type="number"
                    min="1"
                    max="1000"
                    value={maxCredit}
                    onChange={(e) => setMaxCredit(Number(e.target.value))}
                  />
                </label>
                <label className="field">
                  Per-execution limit ($)
                  <input
                    required
                    type="number"
                    min="1"
                    max="10000"
                    value={maxTotal}
                    onChange={(e) => setMaxTotal(Number(e.target.value))}
                  />
                </label>
              </div>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <Cpu size={16} />}Capture &
                compile
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {(modal === 'approve' || modal === 'reject') && cap && (
        <Dialog
          title={modal === 'approve' ? 'Approve this capability' : 'Request changes'}
          close={() => !busy && setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () => api(`/capabilities/${cap.id}/${modal}`, { note: reviewNote }),
                modal === 'approve'
                  ? 'Capability approved and deployed to the local registry.'
                  : 'Review recorded.',
                () => setModal(null),
              );
            }}
          >
            <div className="dialog-body">
              <div className="review-summary">
                <ShieldCheck size={24} />
                <div>
                  <strong>
                    {cap.name} · v{cap.version}
                  </strong>
                  <p>
                    {cap.checks.filter((c) => c.passed).length} checks passed ·{' '}
                    {money(cap.policy.maxCredit)} / customer
                  </p>
                </div>
              </div>
              <label className="field">
                Review note
                <textarea
                  required
                  minLength={5}
                  maxLength={500}
                  rows={4}
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                />
              </label>
              <p className="hint">
                This review is attributed to the local demo operator. Approval makes this version
                available through the tool API.
              </p>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {modal === 'approve' ? 'Approve & deploy' : 'Submit review'}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {modal === 'run' && cap && (
        <Dialog title="Run capability" close={() => !busy && setModal(null)}>
          <form onSubmit={runWorkflow}>
            <div className="dialog-body">
              <p className="dialog-intro">
                Execute <code>{cap.name}</code> v{cap.version} against the local demo systems.
              </p>
              <div className="form-grid">
                <label className="field">
                  Delay threshold (days)
                  <input
                    type="number"
                    required
                    min="1"
                    max="90"
                    value={delay}
                    onChange={(e) => setDelay(Number(e.target.value))}
                  />
                </label>
                <label className="field">
                  Customer credit ($)
                  <input
                    type="number"
                    required
                    min="0.01"
                    step="0.01"
                    max="1000"
                    value={credit}
                    onChange={(e) => setCredit(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="field">
                Failure simulation
                <select value={fault} onChange={(e) => setFault(e.target.value)}>
                  <option value="none">None — normal execution</option>
                  <option value="transient">Transient adapter failure (retry)</option>
                  <option value="partial">CRM failure (atomic rollback)</option>
                  <option value="timeout">Adapter timeout</option>
                  <option value="stale">Stale shipment data</option>
                </select>
              </label>
              <div className="info-box">
                <ShieldCheck size={19} />
                <span>
                  Only eligible, uncredited shipments are processed. The runtime enforces the
                  approved {money(cap.policy.maxTotal)} total budget.
                </span>
              </div>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                <Play size={15} />
                Execute workflow
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
function Metric({
  title,
  value,
  note,
  icon,
  suffix,
}: {
  title: string;
  value: string;
  note: string;
  icon: ReactNode;
  suffix?: string;
}) {
  return (
    <article className="metric">
      <div className="metric-title">
        {title}
        {icon}
      </div>
      <div className="metric-value">
        {value}
        <span>{suffix}</span>
      </div>
      <div className="metric-note">{note}</div>
    </article>
  );
}
function UsageCard({
  title,
  usage,
  note,
}: {
  title: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; estimated: boolean };
  note: string;
}) {
  return (
    <article className="usage-card">
      <span>{title}</span>
      <strong>{usage ? usage.totalTokens.toLocaleString() : '—'}</strong>
      <small>
        {usage
          ? `${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out${
              usage.estimated ? ' · estimated' : ''
            }`
          : note}
      </small>
      {usage && <p>{note}</p>}
    </article>
  );
}
