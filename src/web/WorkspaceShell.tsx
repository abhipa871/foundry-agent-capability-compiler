import type { ReactNode } from 'react';
import {
  ArrowRight,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Cpu,
  Layers3,
  MessageSquareText,
} from 'lucide-react';
import './benchmark.css';
import './workspace.css';

export type BenchmarkView = 'playground' | 'results' | 'history' | 'integrate';
export type DeveloperPage =
  | 'Agent chat'
  | 'Registry'
  | 'Task registry'
  | 'JIT compiler'
  | 'Trajectories'
  | 'Executions'
  | 'Capability graph'
  | 'Audit log';
export type WorkspacePage = BenchmarkView | DeveloperPage;
export const isBenchmarkView = (page: WorkspacePage): page is BenchmarkView =>
  ['playground', 'results', 'history', 'integrate'].includes(page);
const titles: Record<WorkspacePage, string> = {
  playground: 'Agent playground',
  results: 'Benchmark results',
  history: 'Run history',
  integrate: 'API & SDK',
  'Agent chat': 'Coding-agent chat',
  Registry: 'Capabilities',
  'Task registry': 'Capabilities',
  'JIT compiler': 'Developer console',
  Trajectories: 'Shipping trajectories',
  Executions: 'Activity',
  'Capability graph': 'Dependency graph',
  'Audit log': 'Audit log',
};
const groups: {
  label: string;
  items: { page: WorkspacePage; icon: typeof Cpu; label?: string }[];
}[] = [
  {
    label: 'BENCHMARKS',
    items: [
      { page: 'playground', icon: MessageSquareText },
      { page: 'results', icon: BarChart3 },
      { page: 'history', icon: Clock3 },
    ],
  },
  {
    label: 'BUILD WITH FOUNDRY',
    items: [
      { page: 'JIT compiler', icon: Cpu, label: 'Developer console' },
      { page: 'integrate', icon: Code2 },
    ],
  },
];

export function WorkspaceShell({
  page,
  navigate,
  runCount,
  children,
}: {
  page: WorkspacePage;
  navigate: (page: WorkspacePage) => void;
  runCount: number;
  children: ReactNode;
}) {
  return (
    <div className="bench-app workspace-app">
      <aside className="bw-sidebar" aria-label="Workspace sidebar">
        <a
          className="bw-brand"
          href="#playground"
          onClick={(event) => {
            event.preventDefault();
            navigate('playground');
          }}
        >
          <span className="bw-brand-symbol">
            <Layers3 size={23} strokeWidth={2.3} />
          </span>
          foundry<span className="bw-brand-period">.</span>
        </a>
        <div className="bw-workspace">
          <span className="bw-workspace-avatar">F</span>
          <div>
            <strong>Foundry workspace</strong>
            <small>Local development</small>
          </div>
          <ChevronDown size={13} />
        </div>
        <nav aria-label="Main navigation" className="workspace-navigation">
          {groups.map((group) => (
            <div className="workspace-nav-group" key={group.label}>
              <div className="bw-nav-label">{group.label}</div>
              {group.items.map(({ page: destination, icon: Icon, label }) => (
                <button
                  key={destination}
                  className={
                    page === destination ||
                    (destination === 'JIT compiler' && !isBenchmarkView(page))
                      ? 'active'
                      : ''
                  }
                  aria-current={
                    page === destination ||
                    (destination === 'JIT compiler' && !isBenchmarkView(page))
                      ? 'page'
                      : undefined
                  }
                  aria-label={label ?? titles[destination]}
                  title={label ?? titles[destination]}
                  onClick={() => navigate(destination)}
                >
                  <Icon size={17} />
                  <span className="workspace-nav-text">{label ?? titles[destination]}</span>
                  {destination === 'history' && runCount > 0 && (
                    <span className="bw-nav-count">{runCount}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="bw-sidebar-bottom">
          <div className="bw-sidebar-card">
            <span className="bw-live-dot" /> ONE CONNECTED WORKSPACE
            <h3>Measure. Compile. Improve.</h3>
            <p>Compare agent work, then inspect the trusted execution behind it.</p>
            <button
              onClick={() => navigate(page === 'JIT compiler' ? 'playground' : 'JIT compiler')}
            >
              {page === 'JIT compiler' ? 'Open playground' : 'Inspect the compiler'}
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="bw-profile">
            <div>F</div>
            <span>
              <strong>Local workspace</strong>
              <small>Development environment</small>
            </span>
            <ChevronDown size={13} />
          </div>
        </div>
      </aside>
      <div className="bw-main">
        <header className="bw-topbar">
          <div>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <span className="workspace-breadcrumb-section">
              {isBenchmarkView(page)
                ? page === 'integrate'
                  ? 'Build'
                  : 'Benchmarks'
                : 'Developer tools'}
            </span>
            <ChevronRight size={13} />
            <strong>{titles[page]}</strong>
          </div>
          <div>
            <span className="bw-local">
              <span />
              Local environment
            </span>
            <span className="bw-top-divider" />
            <span className="bw-top-avatar">F</span>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
