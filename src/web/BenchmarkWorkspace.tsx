import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { generalSdkExample } from './sdk-example';
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Cpu,
  Database,
  FileJson,
  FlaskConical,
  GitBranch,
  Layers3,
  LoaderCircle,
  MessageSquareText,
  Play,
  Plus,
  ShieldCheck,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import type {
  BenchmarkArm,
  BenchmarkConfig,
  BenchmarkEvidence,
  BenchmarkRequest,
  BenchmarkRun,
  RetainedSummary,
} from '../benchmarks/contracts';
import type { BenchmarkView } from './WorkspaceShell';

type MetricKey =
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'totalTokens'
  | 'modelCalls'
  | 'toolCalls'
  | 'durationMs';
const number = (value: number | null | undefined, digits = 0) =>
  value == null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
const percent = (before: number | null | undefined, after: number | null | undefined) =>
  before == null || after == null || before <= 0 ? null : (100 * (before - after)) / before;
const duration = (value: number | null | undefined) =>
  value == null ? '—' : `${(value / 1000).toFixed(2)}s`;
const dollars = (value: number | null | undefined) =>
  value == null ? '—' : `$${value.toFixed(5)}`;
const date = (value: string) =>
  new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    `/api/benchmarks/${path}`,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Foundry-Client': 'local-ui' },
          body: JSON.stringify(data),
        },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'The benchmark could not be completed.');
  return body as T;
}
function summarize(run: BenchmarkRun, arm: 'normal' | 'foundry'): RetainedSummary {
  const arms = run.pairs.map((pair) => pair[arm]);
  const mean = (key: MetricKey) =>
    arms.some((item) => item.measurement[key] === null)
      ? null
      : arms.reduce((sum, item) => sum + item.measurement[key]!, 0) / arms.length;
  const times = arms.map((item) => item.measurement.durationMs).sort((a, b) => a - b);
  return {
    requests: arms.length,
    mean: {
      inputTokens: mean('inputTokens'),
      outputTokens: mean('outputTokens'),
      cachedInputTokens: mean('cachedInputTokens'),
      totalTokens: mean('totalTokens'),
      modelCalls: mean('modelCalls'),
      toolCalls: mean('toolCalls'),
      durationMs: mean('durationMs')!,
    },
    latency: {
      p50: times[Math.floor(times.length / 2)],
      p95: times[Math.ceil(times.length * 0.95) - 1],
    },
    apiEquivalentCostUsd: arms.some((item) => item.estimatedCostUsd === null)
      ? null
      : arms.reduce((sum, item) => sum + item.estimatedCostUsd!, 0) / arms.length,
    correctnessRate:
      arms.filter((item) => Object.values(item.checks).every(Boolean)).length / arms.length,
    successRate: arms.filter((item) => item.measurement.outcome === 'success').length / arms.length,
    fallbackRate: arms.filter((item) => item.fallback).length / arms.length,
  };
}
function Pill({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span className={`bw-pill ${muted ? 'bw-pill-muted' : ''}`}>{children}</span>;
}
function Saving({
  before,
  after,
}: {
  before: number | null | undefined;
  after: number | null | undefined;
}) {
  const value = percent(before, after);
  return (
    <span className={`bw-saving ${value !== null && value < 0 ? 'bw-regression' : ''}`}>
      {value === null ? (
        'Not measured'
      ) : (
        <>
          <ArrowDown size={12} style={value < 0 ? { transform: 'rotate(180deg)' } : undefined} />
          {Math.abs(value).toFixed(1)}% {value < 0 ? 'increase' : 'less'}
        </>
      )}
    </span>
  );
}
function Comparison({
  baseline,
  optimized,
  preview = false,
}: {
  baseline?: RetainedSummary;
  optimized?: RetainedSummary;
  preview?: boolean;
}) {
  const metrics = [
    {
      title: 'Total tokens',
      icon: Layers3,
      before: baseline?.mean.totalTokens,
      after: optimized?.mean.totalTokens,
      format: number,
      detail: 'Input + output · cache included',
    },
    {
      title: 'Model calls',
      icon: Cpu,
      before: baseline?.mean.modelCalls,
      after: optimized?.mean.modelCalls,
      format: (n: number | null | undefined) => number(n, 2),
      detail: 'Complete task, including fallback',
    },
    {
      title: 'Wall-clock latency',
      icon: Clock3,
      before: baseline?.mean.durationMs,
      after: optimized?.mean.durationMs,
      format: duration,
      detail: 'All request orchestration included',
    },
    {
      title: 'Est. inference cost',
      icon: BarChart3,
      before: baseline?.apiEquivalentCostUsd,
      after: optimized?.apiEquivalentCostUsd,
      format: dollars,
      detail: 'API equivalent · not billed cost',
    },
  ];
  return (
    <div className="bw-metrics">
      {metrics.map(({ title, icon: Icon, before, after, format, detail }) => (
        <article className="bw-metric" key={title}>
          <div className="bw-metric-label">
            <span>{title}</span>
            <Icon size={16} />
          </div>
          <div className="bw-metric-value">
            {format(after)}
            <Saving before={preview ? null : before} after={after} />
          </div>
          <div className="bw-metric-baseline">
            {before == null ? (
              preview ? (
                'Preview: no model inference'
              ) : title === 'Est. inference cost' ? (
                'Matching pricing unavailable'
              ) : (
                'Provider usage unavailable'
              )
            ) : (
              <>
                Normal execution <strong>{format(before)}</strong>
              </>
            )}
          </div>
          <div className="bw-metric-note">{detail}</div>
        </article>
      ))}
    </div>
  );
}

export function BenchmarkWorkspace({
  view,
  setView,
  onOpenConsole,
  onRunCountChange,
}: {
  view: BenchmarkView;
  setView: (view: BenchmarkView) => void;
  onOpenConsole: () => void;
  onRunCountChange: (count: number) => void;
}) {
  const [config, setConfig] = useState<BenchmarkConfig>();
  const [evidence, setEvidence] = useState<BenchmarkEvidence>();
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState(
    'My delivery is late. Can you investigate my account, orders and refund history, explain the appropriate next step, and draft a helpful reply?',
  );
  const [scope, setScope] = useState<BenchmarkRequest['scope']>('agent_decides');
  const [customerId, setCustomerId] = useState<BenchmarkRequest['customerId']>('C-101');
  const [execution, setExecution] = useState<BenchmarkRequest['execution']>('preview');
  const [repeats, setRepeats] = useState(1);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    onRunCountChange(runs.length);
  }, [runs.length, onRunCountChange]);
  const [detail, setDetail] = useState<'responses' | 'metrics' | 'trace'>('responses');
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    Promise.allSettled([api<BenchmarkConfig>('config'), api<BenchmarkEvidence>('evidence')]).then(
      ([settings, retained]) => {
        if (!mounted.current) return;
        if (settings.status === 'fulfilled') setConfig(settings.value);
        else setError('Cannot reach the benchmark API. Start the workspace with npm run dev.');
        if (retained.status === 'fulfilled') setEvidence(retained.value);
        else
          setError(
            (current) =>
              current || 'Retained benchmark evidence is unavailable. New runs remain available.',
          );
      },
    );
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const current = runs.find((run) => run.id === selected);
  const baseline = current ? summarize(current, 'normal') : evidence?.arms.normal;
  const optimized = current ? summarize(current, 'foundry') : evidence?.arms.selective_direct;
  const sample = config?.scenarios.find((item) => item.scope === current?.request.scope);
  function changeScope(value: BenchmarkRequest['scope']) {
    setScope(value);
    const example = config?.scenarios.find((item) => item.scope === value);
    if (example) setPrompt(example.prompt);
  }
  async function run(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setElapsed(0);
    try {
      const result = await api<BenchmarkRun>('runs', {
        prompt,
        scope,
        customerId,
        execution,
        repeats,
      });
      if (!mounted.current) return;
      setRuns((previous) => [result, ...previous].slice(0, 20));
      setSelected(result.id);
      setDetail('responses');
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function download(value: unknown, filename: string) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  const integration = generalSdkExample;
  async function copy() {
    try {
      await navigator.clipboard.writeText(integration);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Clipboard unavailable. Select and copy the code directly.');
    }
  }
  return (
    <main className="bw-content">
      <div className="bw-page-heading">
        <div>
          <div className="bw-eyebrow">
            <span />
            THE AGENT EFFICIENCY WORKSPACE
          </div>
          <h1>
            {view === 'integrate'
              ? 'Your agent. Powered by Foundry.'
              : view === 'results'
                ? 'Evidence behind the efficiency.'
                : view === 'history'
                  ? 'Every run, accounted for.'
                  : 'Make every token count.'}
          </h1>
          <p>
            {view === 'integrate'
              ? 'Keep your agent, tools, and permissions. Add a trusted execution layer.'
              : view === 'results'
                ? 'Real provider usage. Paired tasks. Every failure and fallback included.'
                : view === 'history'
                  ? 'Revisit comparisons and export the complete measurements.'
                  : 'One prompt. Two execution paths. See exactly where Foundry makes a difference.'}
          </p>
        </div>
        <button
          className="bw-button bw-button-white"
          onClick={() => (view === 'integrate' ? onOpenConsole() : setView('integrate'))}
        >
          <BookOpen size={15} />
          {view === 'integrate' ? 'Open developer console' : 'Integration guide'}
          <ArrowUpRight size={14} />
        </button>
      </div>
      {error && (
        <div className="bw-error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {view === 'playground' && (
        <>
          <div className="bw-section-kicker">
            <span>
              {current
                ? current.request.execution === 'live'
                  ? 'YOUR LIVE COMPARISON'
                  : 'YOUR PREVIEW COMPARISON'
                : 'FROM OUR LATEST HELD-OUT BENCHMARK'}
            </span>
            <span>
              {current
                ? `${current.request.repeats} paired ${current.request.repeats === 1 ? 'repeat' : 'repeats'} · ${date(current.createdAt)}`
                : evidence
                  ? `${evidence.requests} requests · ${date(evidence.capturedAt)}`
                  : 'Loading retained evidence…'}
              <span className="bw-small-dot" />
              {current?.request.execution === 'preview'
                ? 'No inference performed'
                : 'Provider-reported tokens'}
            </span>
          </div>
          <Comparison
            baseline={baseline}
            optimized={optimized}
            preview={current?.request.execution === 'preview'}
          />
          <div className="bw-play-grid">
            <section className="bw-card bw-composer">
              <div className="bw-card-heading">
                <div className="bw-heading-icon">
                  <MessageSquareText size={17} />
                </div>
                <div>
                  <h2>Put Foundry to the test</h2>
                  <p>Run the same task with and without optimization.</p>
                </div>
                <Pill muted>
                  <ShieldCheck size={12} />
                  Read-only
                </Pill>
              </div>
              <form onSubmit={(event) => void run(event)}>
                <div className="bw-form-options">
                  <label>
                    Customer
                    <select
                      value={customerId}
                      onChange={(event) =>
                        setCustomerId(event.target.value as BenchmarkRequest['customerId'])
                      }
                    >
                      <option value="C-101">C-101 · Eligible, no refund</option>
                      <option value="C-202">C-202 · Prior refund</option>
                      <option value="C-303">C-303 · Not eligible</option>
                    </select>
                  </label>
                  <label>
                    Task contract
                    <select
                      value={scope}
                      onChange={(event) =>
                        changeScope(event.target.value as BenchmarkRequest['scope'])
                      }
                    >
                      {(
                        config?.scenarios ?? [
                          { scope: 'agent_decides', label: 'Let the agent decide' },
                        ]
                      ).map((item) => (
                        <option key={item.scope} value={item.scope}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="bw-prompt-label" htmlFor="benchmark-prompt">
                  Your prompt<span>Customer support sandbox</span>
                </label>
                <div className="bw-prompt-box">
                  <textarea
                    id="benchmark-prompt"
                    value={prompt}
                    maxLength={2000}
                    minLength={5}
                    required
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Ask about a customer’s orders, eligibility, or refund history…"
                  />
                  <div>
                    <span>
                      <Database size={12} />
                      Same data. Same authorization.
                    </span>
                    <span>{prompt.length}/2,000</span>
                  </div>
                </div>
                <div className="bw-suggestions">
                  <span>TRY A TASK</span>
                  {(['complete', 'orders', 'policy'] as const).map((value) => (
                    <button type="button" onClick={() => changeScope(value)} key={value}>
                      {value === 'complete'
                        ? 'Full review'
                        : value === 'orders'
                          ? 'Order status'
                          : 'No customer context'}
                      <ArrowUpRight size={11} />
                    </button>
                  ))}
                </div>
                <div className="bw-run-controls">
                  <div>
                    <label className="bw-execution-label">
                      <select
                        aria-label="Execution mode"
                        value={execution}
                        onChange={(event) =>
                          setExecution(event.target.value as BenchmarkRequest['execution'])
                        }
                      >
                        <option value="preview">Local preview</option>
                        <option value="live" disabled={!config?.liveEnabled}>
                          Live · {config?.model ?? 'model'}
                          {!config?.liveEnabled ? ' · not enabled' : ''}
                        </option>
                      </select>
                    </label>
                    <label>
                      <select
                        aria-label="Paired repeats"
                        value={repeats}
                        onChange={(event) => setRepeats(Number(event.target.value))}
                      >
                        <option value={1}>1 pair</option>
                        <option value={2}>2 pairs</option>
                        <option value={3}>3 pairs</option>
                      </select>
                    </label>
                  </div>
                  <button
                    className="bw-button bw-button-primary"
                    disabled={busy || !config || prompt.trim().length < 5}
                    type="submit"
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="bw-spin" />
                    ) : (
                      <Play size={14} fill="currentColor" />
                    )}
                    {busy ? `Comparing · ${elapsed}s` : 'Run comparison'}
                    {!busy && <ArrowRight size={15} />}
                  </button>
                </div>
                <p className="bw-run-note">
                  {execution === 'preview'
                    ? 'Preview follows the task preset, not free-form prompt meaning. No model runs; token savings stay unmeasured.'
                    : `${repeats * 2} provider-backed tasks · ${repeats * 12}-response budget, checked as usage arrives. Uses your local CLI account.`}
                </p>
                {execution === 'preview' && !config?.liveEnabled && (
                  <details className="bw-live-setup">
                    <summary>
                      Enable real token measurements <ChevronDown size={12} />
                    </summary>
                    <code>
                      FOUNDRY_BENCHMARK_LIVE=true FOUNDRY_BENCHMARK_MODEL=gpt-6.1-sol npm run dev
                    </code>
                    <p>
                      Requires an authenticated Codex CLI. Live runs consume your account’s
                      inference allowance. Pin a model available to your account. Each task has a
                      6-response abort threshold, a 10-tool-call cap and a 60-second turn timeout.
                      Usage can arrive after inference starts; this is not a hard billing cap.
                    </p>
                  </details>
                )}
              </form>
            </section>
            <aside className="bw-card bw-flow-card">
              <div className="bw-card-title">
                <GitBranch size={16} />
                <h2>Same task. A smarter path.</h2>
              </div>
              <p>Foundry moves repeatable work out of the model’s reasoning loop.</p>
              <div className="bw-flow-label">NORMAL EXECUTION</div>
              <div className="bw-flow-path">
                <span>
                  <Cpu size={15} />
                  Model
                </span>
                <ArrowRight size={13} />
                <span>
                  <Database size={15} />
                  Tools
                </span>
                <ArrowRight size={13} />
                <span>
                  <Cpu size={15} />
                  Model
                </span>
              </div>
              <div className="bw-flow-label bw-green-text">
                WITH FOUNDRY · WHEN PREFETCH APPLIES
              </div>
              <div className="bw-flow-path bw-flow-optimized">
                <span>
                  <Zap size={15} />
                  Compiled reads
                </span>
                <ArrowRight size={13} />
                <span>
                  <Cpu size={15} />
                  Model
                </span>
              </div>
              <div className="bw-flow-explanation">
                <ShieldCheck size={16} />
                <p>
                  When the agent must choose its tools, Foundry offers a compiled loader instead. A
                  model turn may still be needed.
                </p>
              </div>
              <div className="bw-adapter-row">
                <span className="bw-adapter">CRM</span>
                <span className="bw-adapter">Orders</span>
                <span className="bw-adapter">Refund history</span>
              </div>
              <button className="bw-text-link" onClick={() => setView('integrate')}>
                See how it fits your stack
                <ArrowUpRight size={13} />
              </button>
            </aside>
          </div>
          {current ? (
            <section className="bw-card bw-output">
              <div className="bw-output-heading">
                <div>
                  <h2>Execution comparison</h2>
                  <p>
                    {current.request.execution === 'preview'
                      ? 'Deterministic preview responses · not generated by a model'
                      : `${current.model} · same prompt and snapshot · mean metrics across all repeats`}
                  </p>
                  <p className="bw-equivalence">
                    <CheckCircle2 size={12} />
                    Structured results match in{' '}
                    {current.pairs.filter((pair) => pair.equivalence === 'match').length} of{' '}
                    {current.pairs.length} pairs
                  </p>
                </div>
                <button
                  className="bw-button bw-button-white"
                  onClick={() => download(current, `foundry-${current.id}.json`)}
                >
                  <ArrowDownToLine size={14} />
                  Export run
                </button>
              </div>
              <div className="bw-submitted-prompt">
                <span>
                  COMPARED PROMPT · {current.request.customerId} ·{' '}
                  {current.request.scope.replaceAll('_', ' ')}
                </span>
                <p>{current.request.prompt}</p>
              </div>
              <div className="bw-tabs" role="tablist" aria-label="Comparison details">
                {(['responses', 'metrics', 'trace'] as const).map((tab) => (
                  <button
                    role="tab"
                    aria-selected={detail === tab}
                    className={detail === tab ? 'active' : ''}
                    onClick={() => setDetail(tab)}
                    key={tab}
                  >
                    {tab === 'responses'
                      ? 'Agent responses'
                      : tab === 'metrics'
                        ? 'Token breakdown'
                        : 'Execution trace'}
                  </button>
                ))}
              </div>
              {detail === 'responses' ? (
                <div className="bw-responses">
                  {(['normal', 'foundry'] as const).map((arm) => (
                    <ResponseCard key={arm} result={current.pairs[0][arm]} />
                  ))}
                </div>
              ) : detail === 'metrics' ? (
                <MetricTable baseline={baseline} optimized={optimized} />
              ) : (
                <div className="bw-trace">
                  {current.pairs.map((pair, index) => (
                    <div key={index}>
                      <h3>
                        Pair {index + 1}
                        <span>Execution order: {pair.order.join(' → ')}</span>
                      </h3>
                      <div className="bw-responses">
                        {(['normal', 'foundry'] as const).map((arm) => (
                          <div key={arm}>
                            <strong>{arm === 'normal' ? 'Normal execution' : 'Foundry'}</strong>
                            <p className="bw-mono">{pair[arm].mode}</p>
                            <p>{pair[arm].reason.replaceAll('_', ' ')}</p>
                            {pair[arm].reads.map((read, readIndex) => (
                              <div className="bw-read" key={readIndex}>
                                <Database size={13} />
                                <code>{read.operation}</code>
                                <span>
                                  {read.status} · {read.durationMs.toFixed(1)}ms
                                </span>
                              </div>
                            ))}
                            {pair[arm].reads.length === 0 && <p>No business reads.</p>}
                            <p>
                              Selector: {pair[arm].selectorMs.toFixed(3)}ms · Fallback:{' '}
                              {pair[arm].fallback ? 'yes' : 'no'}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="bw-output-footer">
                <ShieldCheck size={13} />
                <span>
                  {current.request.scope === 'agent_decides'
                    ? 'Checks cover factual evidence and policy; arbitrary prompt intent is not independently verified.'
                    : `Checks cover the selected ${sample?.label.toLowerCase() ?? current.request.scope} contract; keep the prompt within that scope.`}
                </span>
              </div>
              <div className="bw-output-footer">
                <Clock3 size={13} />
                <span>
                  Separate fixture compilation, validation and shadow checks:{' '}
                  {current.setup.durationMs.toFixed(0)}ms · {current.setup.checks} checks · 0 model
                  calls. Setup time is not per-request latency.{' '}
                  {current.pricing.applicable
                    ? `Cost estimates use the ${current.pricing.model} rate card checked ${current.pricing.checkedAt}; actual billing is unknown.`
                    : `No matching rate card for ${current.model}; monetary savings are unknown.`}{' '}
                  Small samples do not establish tail latency.
                </span>
              </div>
            </section>
          ) : (
            <section className="bw-card bw-ready">
              <div className="bw-ready-icon">
                <FlaskConical size={23} />
              </div>
              <div>
                <h2>Your next prompt is an experiment.</h2>
                <p>Compare responses, inspect the execution trace, and export every measurement.</p>
              </div>
              <Pill muted>Ready when you are</Pill>
            </section>
          )}
          <div className="bw-integration-banner">
            <div className="bw-integration-icon">
              <Braces size={22} />
            </div>
            <div>
              <h3>Same intelligence. Inside your own agent.</h3>
              <p>
                Use the SDK to bring guarded execution and usage observation to your application.
              </p>
            </div>
            <button className="bw-button bw-button-white" onClick={() => setView('integrate')}>
              Build with Foundry
              <ArrowRight size={14} />
            </button>
          </div>
        </>
      )}
      {view === 'results' && (
        <>
          <div className="bw-study-banner">
            <div>
              <Pill>
                <span className="bw-live-dot" />
                RETAINED LIVE EVIDENCE
              </Pill>
              <h2>Selective context · held-out evaluation</h2>
              <p>
                {evidence
                  ? `${evidence.cases} case categories × 4 execution arms × ${evidence.repeats} repeats · ${date(evidence.capturedAt)}`
                  : 'Loading the retained study…'}
              </p>
            </div>
            <button
              className="bw-button bw-button-white"
              disabled={!evidence}
              onClick={() => download(evidence, 'foundry-retained-summary.json')}
            >
              <FileJson size={15} />
              Export summary
            </button>
          </div>
          <Comparison
            baseline={evidence?.arms.normal}
            optimized={evidence?.arms.selective_direct}
          />
          <section className="bw-card bw-study">
            <div className="bw-output-heading">
              <div>
                <h2>Four ways to run the same work</h2>
                <p>Mean tokens per request · failures and denials retained</p>
              </div>
              <Pill muted>{evidence?.requests ?? '—'} measured requests</Pill>
            </div>
            <div className="bw-study-bars">
              {[
                {
                  id: 'normal',
                  label: 'Normal agent',
                  description: 'Original authorized tools',
                },
                {
                  id: 'existing_selector_direct',
                  label: 'Existing Foundry',
                  description: 'Complete-context routing',
                },
                {
                  id: 'selective_direct',
                  label: 'Selective Foundry',
                  description: 'Only the required context',
                },
                {
                  id: 'handwritten_selective',
                  label: 'Handwritten prefetch',
                  description: 'Deterministic comparison',
                },
              ].map((arm) => (
                <div className="bw-study-bar-row" key={arm.id}>
                  <div>
                    <strong>{arm.label}</strong>
                    <small>{arm.description}</small>
                  </div>
                  <div className="bw-bar-track">
                    <div
                      className={arm.id === 'selective_direct' ? 'bw-bar-foundry' : ''}
                      style={{
                        width: `${evidence?.arms[arm.id]?.mean.totalTokens && evidence.arms.normal.mean.totalTokens ? (evidence.arms[arm.id].mean.totalTokens! / evidence.arms.normal.mean.totalTokens) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <strong>{number(evidence?.arms[arm.id]?.mean.totalTokens)}</strong>
                </div>
              ))}
            </div>
            <div className="bw-evidence-notes">
              <p>
                <CheckCircle2 size={15} />
                All 128 outputs passed the study’s oracle checks. Business success was 87.5%;
                correct denials and unavailable outcomes account for the remainder.
              </p>
              <p>
                <Database size={15} />
                Real model inference over synthetic, read-only customer records. This is one support
                workflow family.
              </p>
              <p>
                <BarChart3 size={15} />
                Handwritten prefetch used fewer tokens overall. Foundry adds artifact verification,
                guards and fallback governance.
              </p>
            </div>
            <MetricTable
              baseline={evidence?.arms.normal}
              optimized={evidence?.arms.selective_direct}
            />
            <div className="bw-output-footer">
              Request metrics include optimization overhead. One-time setup is excluded from these
              steady-state means. Historical API-equivalent costs use the October 3, 2026 rate card,
              not an actual bill. The small sample does not establish production p95.
            </div>
          </section>
        </>
      )}
      {view === 'integrate' && (
        <>
          <div className="bw-integration-intro">
            <Pill>
              <Code2 size={12} />
              NODE.JS SDK · LOCAL BUILD
            </Pill>
            <h2>
              An execution layer.
              <br />
              Your agent stays in control.
            </h2>
            <p>
              Foundry compiles eligible, repeated read workflows into validated plans. Your
              application decides when to prefetch, when to offer a tool, and when to run the
              original agent.
            </p>
          </div>
          <section className="bw-card bw-architecture" aria-label="SDK architecture">
            <div className="bw-architecture-node">
              <span>
                <MessageSquareText size={23} />
              </span>
              <strong>Your application</strong>
              <small>Prompt + trusted identity</small>
            </div>
            <ArrowRight className="bw-architecture-arrow" size={23} />
            <div className="bw-architecture-node bw-architecture-highlight">
              <span>
                <Layers3 size={23} />
              </span>
              <strong>Foundry SDK</strong>
              <small>Select · verify · execute</small>
            </div>
            <ArrowRight className="bw-architecture-arrow" size={23} />
            <div className="bw-architecture-branches">
              <div>
                <Database size={18} />
                <span>
                  <strong>Your authorized tools</strong>
                  <small>Validated read-only plan</small>
                </span>
                <Pill>Compiled</Pill>
              </div>
              <div>
                <Cpu size={18} />
                <span>
                  <strong>Your original agent</strong>
                  <small>Reasoning + safe fallback</small>
                </span>
                <Pill muted>Native</Pill>
              </div>
            </div>
          </section>
          <div className="bw-sdk-grid">
            <section className="bw-card bw-code-card">
              <div className="bw-code-header">
                <span>
                  <Terminal size={15} />
                  your-agent.ts
                </span>
                <button onClick={() => void copy()}>
                  <span aria-live="polite">
                    {copied ? (
                      <>
                        <Check size={14} />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy size={14} />
                        Copy example
                      </>
                    )}
                  </span>
                </button>
              </div>
              <pre>
                <code>{integration}</code>
              </pre>
            </section>
            <div className="bw-sdk-steps">
              <h2>Integrate in three steps</h2>
              <div>
                <span>01</span>
                <section>
                  <h3>Connect your existing tools</h3>
                  <p>
                    Register task schemas, authorized read or pure tools, and explicit provenance.
                    Tool credentials stay in your application.
                  </p>
                </section>
              </div>
              <div>
                <span>02</span>
                <section>
                  <h3>Validate before routing</h3>
                  <p>
                    Observe, compile, verify and shadow the exact artifact. Approval and deployment
                    remain explicit. Native comparisons gate activation.
                  </p>
                </section>
              </div>
              <div>
                <span>03</span>
                <section>
                  <h3>Choose the right execution path</h3>
                  <p>
                    Prefetch when your app knows the requirements. Otherwise offer a compiled tool
                    or retain the original agent. Denials never become fallback access.
                  </p>
                </section>
              </div>
              <div className="bw-sdk-command">
                <small>BUILD THE PRIVATE SDK</small>
                <code>npm run build:sdk</code>
                <p>Node.js 24+ · not published to npm</p>
              </div>
              <button className="bw-button bw-button-primary" onClick={onOpenConsole}>
                Open compiler console
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
          <div className="bw-security-grid">
            {[
              {
                icon: ShieldCheck,
                title: 'Your authorization',
                text: 'Tenant, principal and resource scopes are checked before reads.',
              },
              {
                icon: GitBranch,
                title: 'Your fallback',
                text: 'Unsafe or incompatible plans hand off to the original authorized agent.',
              },
              {
                icon: Activity,
                title: 'Honest observation',
                text: 'Record provider usage without capturing private chain-of-thought.',
              },
            ].map(({ icon: Icon, title, text }) => (
              <div className="bw-card" key={title}>
                <Icon size={20} />
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <p className="bw-sdk-limit">
            Task contracts define the workflow, schemas, tools and authorization. The local console
            includes synthetic travel and departure examples. Production connectors require trusted
            operator registration and validation. Supply your own identity, registry, pinned public
            key and agent functions for the integration example.
          </p>
        </>
      )}
      {view === 'history' && (
        <section className="bw-card bw-history">
          <div className="bw-output-heading">
            <div>
              <h2>Session runs</h2>
              <p>Held in memory for this page session. Export results before leaving.</p>
            </div>
            <button
              className="bw-button bw-button-white"
              onClick={() => {
                setSelected(undefined);
                setView('playground');
              }}
            >
              <Plus size={14} />
              New comparison
            </button>
          </div>
          {runs.length ? (
            <div className="bw-history-list">
              {runs.map((run) => (
                <button
                  key={run.id}
                  onClick={() => {
                    setSelected(run.id);
                    setView('playground');
                  }}
                >
                  <span className="bw-history-icon">
                    <FlaskConical size={18} />
                  </span>
                  <span>
                    <strong>{run.request.prompt}</strong>
                    <small>
                      {run.request.customerId} · {run.request.repeats} paired repeats ·{' '}
                      {new Date(run.createdAt).toLocaleTimeString()}
                    </small>
                  </span>
                  <Pill muted>{run.request.execution}</Pill>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="bw-history-empty">
              <Clock3 size={30} />
              <h3>A clean slate.</h3>
              <p>Your comparisons will appear here after you run a prompt.</p>
              <button className="bw-button bw-button-primary" onClick={() => setView('playground')}>
                Run your first comparison
                <ArrowRight size={14} />
              </button>
            </div>
          )}
        </section>
      )}
      <footer className="bw-footer">
        <span>
          <Layers3 size={13} />
          Built on evidence. Executed with trust.
        </span>
        <span>
          Read-only customer context<span>·</span>No guaranteed savings
        </span>
      </footer>
    </main>
  );
}

function ResponseCard({ result }: { result: BenchmarkArm }) {
  const passed = Object.values(result.checks).every(Boolean);
  return (
    <article className={`bw-response ${result.arm === 'foundry' ? 'bw-response-foundry' : ''}`}>
      <div className="bw-response-title">
        <span>
          {result.arm === 'foundry' ? <Zap size={16} /> : <Cpu size={16} />}
          {result.arm === 'foundry' ? 'With Foundry' : 'Normal execution'}
        </span>
        <Pill muted={!passed}>
          {passed ? <CheckCircle2 size={12} /> : <X size={12} />}
          {passed
            ? result.verification === 'contract'
              ? 'Contract checks pass'
              : 'Evidence checks pass'
            : 'Check failed'}
        </Pill>
      </div>
      <p>{result.response?.reply ?? result.failure ?? 'No completed response.'}</p>
      <div className="bw-response-meta">
        <span>{result.mode.replaceAll('_', ' ')}</span>
        <span>{result.reads.length} business reads</span>
        <span>{duration(result.measurement.durationMs)}</span>
      </div>
    </article>
  );
}
function MetricTable({
  baseline,
  optimized,
}: {
  baseline?: RetainedSummary;
  optimized?: RetainedSummary;
}) {
  const rows: {
    label: string;
    before: number | null | undefined;
    after: number | null | undefined;
    format?: (value: number | null | undefined) => string;
  }[] = [
    {
      label: 'Input tokens (includes cached)',
      before: baseline?.mean.inputTokens,
      after: optimized?.mean.inputTokens,
    },
    {
      label: 'Cached input tokens',
      before: baseline?.mean.cachedInputTokens,
      after: optimized?.mean.cachedInputTokens,
    },
    {
      label: 'Output tokens',
      before: baseline?.mean.outputTokens,
      after: optimized?.mean.outputTokens,
    },
    {
      label: 'Total tokens',
      before: baseline?.mean.totalTokens,
      after: optimized?.mean.totalTokens,
    },
    { label: 'Model calls', before: baseline?.mean.modelCalls, after: optimized?.mean.modelCalls },
    { label: 'Business reads', before: baseline?.mean.toolCalls, after: optimized?.mean.toolCalls },
    {
      label: 'Complete request latency',
      before: baseline?.mean.durationMs,
      after: optimized?.mean.durationMs,
      format: duration,
    },
    {
      label: 'Estimated API-equivalent cost',
      before: baseline?.apiEquivalentCostUsd,
      after: optimized?.apiEquivalentCostUsd,
      format: dollars,
    },
    {
      label: 'Task success rate',
      before: baseline?.successRate,
      after: optimized?.successRate,
      format: (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`),
    },
    {
      label: 'Fallback rate',
      before: baseline?.fallbackRate,
      after: optimized?.fallbackRate,
      format: (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`),
    },
  ];
  return (
    <div className="bw-table-wrap">
      <table className="bw-table">
        <thead>
          <tr>
            <th>Metric · mean per request</th>
            <th>Normal execution</th>
            <th>With Foundry</th>
            <th>Difference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.format ? row.format(row.before) : number(row.before, 2)}</td>
              <td>{row.format ? row.format(row.after) : number(row.after, 2)}</td>
              <td>
                {row.label.endsWith('rate') ? (
                  row.before == null || row.after == null ? (
                    '—'
                  ) : (
                    `${((row.after - row.before) * 100).toFixed(1)} pp`
                  )
                ) : (
                  <Saving before={row.before} after={row.after} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
