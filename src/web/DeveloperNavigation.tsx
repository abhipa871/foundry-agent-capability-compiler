import { Activity, Cpu, LayoutGrid, SlidersHorizontal } from 'lucide-react';
import type { DeveloperPage } from './WorkspaceShell';
import './developer-console.css';

export function DeveloperNavigation({
  page,
  navigate,
}: {
  page: DeveloperPage;
  navigate: (page: DeveloperPage) => void;
}) {
  const advanced = ['Agent chat', 'Trajectories', 'Capability graph', 'Audit log'].includes(page);
  return (
    <div className="console-section-bar">
      <nav aria-label="Developer sections">
        {[
          {
            page: 'JIT compiler' as const,
            label: 'Workflow',
            icon: Cpu,
            active: page === 'JIT compiler',
          },
          {
            page: 'Registry' as const,
            label: 'Capabilities',
            icon: LayoutGrid,
            active: page === 'Registry',
          },
          {
            page: 'Executions' as const,
            label: 'Activity',
            icon: Activity,
            active: ['Executions', 'Audit log'].includes(page),
          },
        ].map(({ page: destination, label, icon: Icon, active }) => (
          <button
            key={destination}
            className={active ? 'active' : ''}
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(destination)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>
      <label className="console-more-tools">
        <SlidersHorizontal size={14} />
        <select
          aria-label="More developer tools"
          value={advanced ? page : ''}
          onChange={(event) => {
            if (event.target.value) navigate(event.target.value as DeveloperPage);
          }}
        >
          <option value="" disabled>
            More tools
          </option>
          <optgroup label="Inspect">
            <option value="Audit log">Audit log</option>
            <option value="Capability graph">Dependency graph</option>
          </optgroup>
          <optgroup label="Legacy workflows">
            <option value="Trajectories">Shipping trajectories</option>
            <option value="Agent chat">Coding-agent chat</option>
          </optgroup>
        </select>
      </label>
    </div>
  );
}
