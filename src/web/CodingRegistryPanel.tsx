import { useState, type FormEvent } from 'react';
import type { CodingCapability, CodingPolicy, CodingAgentDeployment } from '../domain';

type Props = {
  capabilities: CodingCapability[];
  deployments: CodingAgentDeployment[];
  active: Record<string, string>;
  selectedId: string | null;
  select: (id: string) => void;
  busy: boolean;
  query: string;
  filter: string;
  action: (path: string, data: unknown, message: string) => void;
};

export function CodingRegistryPanel(props: Props) {
  const filtered = props.capabilities.filter(
    (cap) =>
      `${cap.name} ${cap.task}`.toLowerCase().includes(props.query.toLowerCase()) &&
      (props.filter === 'All capabilities' ||
        (props.filter === 'Needs review'
          ? cap.status === 'verified'
          : props.active[cap.name] === cap.id)),
  );
  const cap = filtered.find((entry) => entry.id === props.selectedId) ?? filtered[0];
  if (!props.capabilities.length) return null;
  return (
    <section className="panel coding-registry">
      <div className="section-header">
        <div>
          <h2>Coding task registry</h2>
          <p>Configure security and assertions, verify, approve, then deploy and measure.</p>
        </div>
      </div>
      <div className="coding-registry-grid">
        <div className="coding-task-list">
          {filtered.length === 0 ? (
            <p>No coding tasks match this filter.</p>
          ) : (
            filtered.map((entry) => (
              <button
                key={entry.id}
                className={`run-row ${entry.id === cap?.id ? 'chosen' : ''}`}
                onClick={() => props.select(entry.id)}
              >
                <span>
                  <strong>{entry.task.slice(0, 80)}</strong>
                  <small>
                    v{entry.version} · {entry.simulated ? 'Simulated' : 'Codex replay'} ·{' '}
                    {props.active[entry.name] === entry.id ? 'Deployed' : entry.status}
                  </small>
                </span>
              </button>
            ))
          )}
        </div>
        {cap ? <CodingTask key={cap.id} cap={cap} {...props} /> : null}
      </div>
    </section>
  );
}

function CodingTask({ cap, busy, action, deployments, active }: Props & { cap: CodingCapability }) {
  const [policy, setPolicy] = useState<CodingPolicy>(() => structuredClone(cap.policy));
  const [reviewNote, setReviewNote] = useState(
    'Reviewed task, sandbox permissions, assertions and side effects.',
  );
  const dirty = JSON.stringify(policy) !== JSON.stringify(cap.policy);
  const last =
    deployments.find((d) => d.id === cap.lastDeploymentId) ??
    deployments.find((d) => d.capabilityId === cap.id);
  const prefix = `/coding-capabilities/${cap.id}`;
  const changeAssertion = (index: number, next: CodingPolicy['assertions'][number]) =>
    setPolicy((current) => ({
      ...current,
      assertions: current.assertions.map((assertion, i) => (i === index ? next : assertion)),
    }));
  function save(event: FormEvent) {
    event.preventDefault();
    action(`${prefix}/policy`, policy, 'New version saved. Verify its checks before approval.');
  }
  return (
    <div className="coding-task-detail">
      <h3>{cap.task}</h3>
      <p>
        Version {cap.version} · {active[cap.name] === cap.id ? 'Deployed' : cap.status} ·{' '}
        {cap.simulated
          ? 'Simulation — no real task execution'
          : 'Agent replay — model usage continues'}
      </p>
      <p className="muted">
        {cap.sideEffects.join(' ')} {cap.rollback}
      </p>
      <form onSubmit={save} className="agent-form">
        <label className="field">
          Sandbox access
          <select
            value={policy.sandbox}
            onChange={(e) =>
              setPolicy({ ...policy, sandbox: e.target.value as CodingPolicy['sandbox'] })
            }
          >
            <option value="read-only">Read only</option>
            <option value="workspace-write">Allow workspace writes</option>
          </select>
        </label>
        <div className="coding-limits">
          <label className="field">
            Timeout (seconds)
            <input
              type="number"
              min={1}
              max={600}
              required
              value={policy.timeoutMs / 1000}
              onChange={(e) => setPolicy({ ...policy, timeoutMs: Number(e.target.value) * 1000 })}
            />
          </label>
          <label className="field">
            Output limit (bytes)
            <input
              type="number"
              min={4096}
              max={2000000}
              required
              value={policy.maxOutputBytes}
              onChange={(e) => setPolicy({ ...policy, maxOutputBytes: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="muted">
          Shell network disabled · one attempt · CLI approval prompts off. Verification expires
          after one hour. Assertions run before and after replay; file changes are not automatically
          undone.
        </p>
        <h4>Task assertions</h4>
        <p>
          Add at least one assertion that checks the task result. File paths must be relative to
          this workspace. Secret files and symbolic links are rejected.
        </p>
        {policy.assertions.map((assertion, index) => (
          <div className="coding-assertion" key={index}>
            <label className="field">
              Assertion {index + 1}
              <select
                value={assertion.kind}
                onChange={(e) => {
                  const kind = e.target.value as CodingPolicy['assertions'][number]['kind'];
                  changeAssertion(
                    index,
                    kind === 'file_exists'
                      ? { kind, path: '' }
                      : kind === 'file_contains'
                        ? { kind, path: '', text: '' }
                        : { kind, text: '' },
                  );
                }}
              >
                <option value="file_exists">File exists</option>
                <option value="file_contains">File contains text</option>
                <option value="output_contains">Output contains text</option>
              </select>
            </label>
            {'path' in assertion ? (
              <label className="field">
                Relative file path
                <input
                  required
                  maxLength={240}
                  placeholder="src/example.ts"
                  value={assertion.path}
                  onChange={(e) => changeAssertion(index, { ...assertion, path: e.target.value })}
                />
              </label>
            ) : null}
            {'text' in assertion ? (
              <label className="field">
                Expected text
                <input
                  required
                  maxLength={1000}
                  value={assertion.text}
                  onChange={(e) => changeAssertion(index, { ...assertion, text: e.target.value })}
                />
              </label>
            ) : null}
            <button
              type="button"
              className="button"
              onClick={() =>
                setPolicy({
                  ...policy,
                  assertions: policy.assertions.filter((_, i) => i !== index),
                })
              }
            >
              Remove assertion {index + 1}
            </button>
          </div>
        ))}
        <div className="coding-actions">
          <button
            type="button"
            className="button"
            disabled={policy.assertions.length >= 20 || busy}
            onClick={() =>
              setPolicy({
                ...policy,
                assertions: [...policy.assertions, { kind: 'file_exists', path: '' }],
              })
            }
          >
            Add assertion
          </button>
          <button className="button primary" disabled={busy || !dirty}>
            Save as new version
          </button>
        </div>
      </form>
      {dirty ? <p role="status">Save changes before verifying or deploying.</p> : null}
      <div className="coding-actions">
        <button
          className="button"
          disabled={busy || dirty || cap.status === 'revoked'}
          onClick={() =>
            action(`${prefix}/verify`, {}, 'Verification finished. Review the check results below.')
          }
        >
          Run security checks
        </button>
        <button
          className="button primary"
          disabled={busy || dirty || cap.status !== 'approved'}
          onClick={() =>
            action(
              `${prefix}/deploy`,
              {},
              'Deployment finished. Review its result and token usage.',
            )
          }
        >
          Deploy and measure
        </button>
        <button
          className="button"
          disabled={busy || cap.status === 'revoked'}
          onClick={() =>
            action(`${prefix}/revoke`, {}, 'Version revoked; future execution disabled.')
          }
        >
          Revoke version
        </button>
        <a className="button" href={`/api/coding-capabilities/${cap.id}/artifact`}>
          Export artifact
        </a>
      </div>
      {cap.status === 'verified' ? (
        <div className="agent-form">
          <label className="field">
            Review note
            <textarea
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              minLength={5}
              maxLength={500}
            />
          </label>
          <button
            className="button"
            disabled={busy || dirty || reviewNote.trim().length < 5}
            onClick={() =>
              action(
                `${prefix}/approve`,
                { note: reviewNote },
                'Version approved. Deploy to execute and measure it.',
              )
            }
          >
            Approve verified version
          </button>
        </div>
      ) : null}
      <ul className="coding-checks" aria-label="Security check results">
        {cap.checks.map((check, index) => (
          <li key={index}>
            <strong>
              {check.passed ? 'PASS' : 'FAIL'} · {check.name}
            </strong>
            <span>{check.detail}</span>
          </li>
        ))}
      </ul>
      {last ? (
        <div className="agent-message">
          <h4>
            Latest deployment: {last.status}
            {last.simulated ? ' (simulated)' : ''}
          </h4>
          <p>
            {last.usage.totalTokens} tokens after replay · {last.tokenDelta} tokens saved (
            {last.tokenReductionPercent}%){last.usage.estimated ? ' · estimated usage' : ''}
          </p>
          {last.error ? <p role="alert">{last.error}</p> : null}
          {last.checks?.map((check, index) => (
            <p key={index}>
              {check.passed ? 'PASS' : 'FAIL'} · {check.name}
            </p>
          ))}
          <pre className="json-block">{last.output}</pre>
        </div>
      ) : null}
    </div>
  );
}
