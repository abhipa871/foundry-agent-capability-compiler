import { useEffect, useState } from 'react';
import type { BillingRun } from '../benchmarks/billing-workspace';
import type { BillingVariant } from '../benchmarks/billing-fixtures';

type Summary = {
  catalog: {
    instruction: string;
    model: string;
    variants: BillingVariant[];
    tools: { name: string; effect: string; compilable: boolean; description: string }[];
  };
  runs: Omit<BillingRun, 'exchanges' | 'transcript' | 'reads' | 'calls' | 'state'>[];
  compilation: {
    durationMs: number;
    deploymentStatus: string;
    limitations: string[];
    candidateReads: number;
    checks: { name: string; passed: boolean }[];
  };
  artifact?: { id: string; digest: string; plan: { compilerVersion: string } } | null;
};
async function api<T>(path = '', body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/benchmarks/billing${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Foundry-Client': 'local-ui' },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Billing operation failed.');
  return value;
}
export function BillingBenchmarkPanel() {
  const [state, setState] = useState<Summary>();
  const [variant, setVariant] = useState<BillingVariant>('normal');
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [trace, setTrace] = useState<unknown>();
  const refresh = async () => setState(await api<Summary>());
  useEffect(() => {
    let active = true;
    api<Summary>()
      .then((value) => {
        if (active) setState(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function act(action: string) {
    setBusy(true);
    setError('');
    try {
      const result = await api(
        `/${action}`,
        action === 'baseline' || action === 'optimized' ? { variant, seed } : {},
      );
      if (action === 'baseline' || action === 'optimized') setTrace(result);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Operation failed.');
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const runs = state?.runs ?? [];
  const last = (arm: 'baseline' | 'optimized') =>
    runs.findLast((run) => run.arm === arm && run.variant === variant && run.seed === seed);
  const baseline = last('baseline');
  const optimized = last('optimized');
  const metrics: {
    label: string;
    baseline: number | null | undefined;
    optimized: number | null | undefined;
  }[] = [
    {
      label: 'Input tokens',
      baseline: baseline?.usage.inputTokens,
      optimized: optimized?.usage.inputTokens,
    },
    {
      label: 'Output tokens',
      baseline: baseline?.usage.outputTokens,
      optimized: optimized?.usage.outputTokens,
    },
    {
      label: 'Cached input tokens',
      baseline: baseline?.usage.cachedInputTokens,
      optimized: optimized?.usage.cachedInputTokens,
    },
    {
      label: 'Total tokens',
      baseline: baseline?.usage.totalTokens,
      optimized: optimized?.usage.totalTokens,
    },
    {
      label: 'Model calls',
      baseline: baseline?.events.length,
      optimized: optimized?.events.length,
    },
    {
      label: 'Agent tool calls',
      baseline: baseline?.modelToolCalls,
      optimized: optimized?.modelToolCalls,
    },
    {
      label: 'Business API attempts',
      baseline: baseline?.businessCalls,
      optimized: optimized?.businessCalls,
    },
    {
      label: 'Complete latency (ms)',
      baseline: baseline?.durationMs,
      optimized: optimized?.durationMs,
    },
    {
      label: 'Estimated inference cost ($)',
      baseline: baseline?.estimatedCostUsd,
      optimized: optimized?.estimatedCostUsd,
    },
  ];
  return (
    <section
      className="bw-card bw-billing-panel"
      style={{ padding: 24 }}
      aria-label="Enterprise Billing Investigation"
    >
      <div className="bw-card-heading">
        <div>
          <h2>Enterprise Billing Investigation</h2>
          <p>Real Gemini inference · synthetic stateful APIs · authorized writes stay native</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="bw-error">
          {error}
        </p>
      )}
      <details>
        <summary>Exact agent task · {state?.catalog.model ?? 'gemini-3.8-flash'}</summary>
        <p>{state?.catalog.instruction}</p>
      </details>
      <p>
        Each button runs a live task and may consume provider inference. For the complete
        seven-variant, five-pair evaluation, use the documented CLI runner.
      </p>
      <div className="bw-billing-fields">
        <label>
          Stress condition
          <select
            value={variant}
            onChange={(event) => setVariant(event.target.value as BillingVariant)}
          >
            {state?.catalog.variants.map((variant) => (
              <option key={variant} value={variant}>
                {variant.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          Matched trial seed
          <input
            type="number"
            min={0}
            max={10000}
            value={seed}
            onChange={(event) => setSeed(Number(event.target.value))}
          />
        </label>
      </div>
      <p>
        Run two correct baselines with distinct seeds before compiling. Both arms reset to the same
        financial snapshot and use matched faults. Compilation discovers repeated observed reads; it
        does not implement refund decisions.
      </p>
      <div
        className="bw-actions"
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '16px 0' }}
      >
        <button
          className="bw-button bw-button-primary"
          disabled={busy}
          onClick={() => void act('baseline')}
        >
          1. Run baseline
        </button>
        <button
          className="bw-button bw-button-secondary"
          disabled={busy || runs.filter((run) => run.arm === 'baseline' && run.passed).length < 2}
          onClick={() => void act('compile')}
        >
          2. Compile & validate reads
        </button>
        <button
          className="bw-button bw-button-secondary"
          disabled={busy || state?.compilation.deploymentStatus !== 'verified_not_approved'}
          onClick={() => void act('deploy')}
        >
          3. Approve & deploy
        </button>
        <button
          className="bw-button bw-button-primary"
          disabled={busy || state?.compilation.deploymentStatus !== 'deployed'}
          onClick={() => void act('optimized')}
        >
          4. Run optimized
        </button>
      </div>
      {busy && (
        <p role="status">
          Working through the real service. No simulated deployment or benchmark measurements.
        </p>
      )}
      <p>
        Capability: <strong>{state?.compilation.deploymentStatus ?? 'not_compiled'}</strong> ·{' '}
        {state?.compilation.candidateReads ?? 0} observed read nodes · setup{' '}
        {((state?.compilation.durationMs ?? 0) / 1000).toFixed(2)}s
      </p>
      <details>
        <summary>Registered simulated APIs ({state?.catalog.tools.length ?? 0})</summary>
        <ul>
          {state?.catalog.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code> · {tool.effect} ·{' '}
              {tool.compilable ? 'eligible read' : 'native only'}
              <p>{tool.description}</p>
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Validation results and compiler limits</summary>
        {state?.artifact && (
          <p>
            Artifact <code>{state.artifact.id}</code> · {state.artifact.plan.compilerVersion}
            <br />
            Digest <code>{state.artifact.digest}</code>
          </p>
        )}
        <ul>
          {state?.compilation.checks.map((check) => (
            <li key={check.name}>
              {check.passed ? 'Pass' : 'Fail'} · {check.name}
            </li>
          ))}
        </ul>
        {state?.compilation.limitations.map((limitation, index) => (
          <p key={index}>{limitation}</p>
        ))}
      </details>
      <div style={{ overflowX: 'auto', marginTop: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Matched task metric</th>
              <th>Baseline</th>
              <th>Optimized</th>
              <th>Saving</th>
              <th>Saving %</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => {
              const saving =
                metric.baseline == null || metric.optimized == null
                  ? null
                  : metric.baseline - metric.optimized;
              const display = (value: number | null | undefined) =>
                value == null
                  ? 'Unknown / not run'
                  : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
              return (
                <tr key={metric.label}>
                  <td>{metric.label}</td>
                  <td>{display(metric.baseline)}</td>
                  <td>{display(metric.optimized)}</td>
                  <td>{display(saving)}</td>
                  <td>
                    {saving == null || !metric.baseline
                      ? '—'
                      : `${((100 * saving) / metric.baseline).toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        Correctness: baseline {baseline ? (baseline.passed ? 'PASS' : 'FAIL') : 'not run'} ·
        optimized {optimized ? (optimized.passed ? 'PASS' : 'FAIL') : 'not run'}. Failed and denied
        requests remain in the traces. No Gemini 3.8 Flash price is assumed.
      </p>
      <label>
        Inspect a saved task
        <select
          defaultValue=""
          onChange={(event) => {
            if (event.target.value)
              void api(`/runs/${event.target.value}`)
                .then(setTrace)
                .catch((error) => setError(error.message));
          }}
        >
          <option value="">Select execution trace</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.arm} · {run.variant} · seed {run.seed} · {run.passed ? 'pass' : 'fail'}
            </option>
          ))}
        </select>
      </label>
      {trace !== undefined && (
        <details open>
          <summary>
            Execution, API mutations, authorization, fallback and public model transcript
          </summary>
          <pre
            style={{
              maxHeight: 500,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {JSON.stringify(trace, null, 2)}
          </pre>
        </details>
      )}
      <a
        className="bw-button bw-button-secondary"
        href="/api/benchmarks/billing/report"
        target="_blank"
        rel="noreferrer"
      >
        Open complete JSON report
      </a>
    </section>
  );
}
