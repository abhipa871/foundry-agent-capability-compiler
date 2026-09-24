import { z } from 'zod';

export const operations = [
  'shipments.list',
  'credits.issue',
  'crm.update',
  'notifications.send',
] as const;
export type Operation = (typeof operations)[number];
export const scopes = [
  'shipments:read',
  'credits:write',
  'crm:write',
  'notifications:send',
] as const;
export const inputSchema = z
  .object({
    delay_days: z.number().int().min(1).max(90),
    credit_amount: z
      .number()
      .min(0.01)
      .max(1000)
      .refine(
        (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-8,
        'Use at most two decimal places',
      ),
  })
  .strict();
export type WorkflowInput = z.infer<typeof inputSchema>;
export const policySchema = z
  .object({
    maxCredit: z.number().min(1).max(1000),
    maxTotal: z.number().min(1).max(10000),
    scopes: z.array(z.enum(scopes)),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export const defaultPolicy: Policy = { maxCredit: 50, maxTotal: 200, scopes: [...scopes] };
export const trajectorySchema = z
  .object({
    name: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    task: z.string().min(10).max(1000),
    model: z.string().min(1).max(80),
    success: z.literal(true),
    inputs: inputSchema,
    durationMs: z.number().positive().max(3600000),
    steps: z
      .array(
        z
          .object({
            operation: z.enum(operations),
            transport: z.enum(['browser', 'api']),
            description: z.string().min(1).max(250),
          })
          .strict(),
      )
      .length(4),
  })
  .strict();
export type TrajectoryDraft = z.infer<typeof trajectorySchema>;
export const rawAgentEventSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    parentId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
    operation: z.string().min(1).max(80),
    transport: z.enum(['browser', 'api', 'tool', 'sdk']).default('tool'),
    status: z.enum(['success', 'failed', 'skipped']),
    description: z.string().min(1).max(250),
    error: z.string().min(1).max(250).optional(),
  })
  .strict();
export const rawAgentTrajectorySchema = trajectorySchema
  .omit({ steps: true })
  .extend({
    finalEventId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
    events: z.array(rawAgentEventSchema).min(4).max(100),
  })
  .strict();
export type RawAgentEvent = z.infer<typeof rawAgentEventSchema>;
export type RawAgentTrajectory = z.infer<typeof rawAgentTrajectorySchema>;
export type DiscardedBranch = {
  eventId: string;
  operation: string;
  status: RawAgentEvent['status'];
  reason:
    | 'failed_tool'
    | 'skipped_tool'
    | 'abandoned_branch'
    | 'unsupported_success'
    | 'non_causal_success';
  description: string;
  error?: string;
};
export type BranchAnalysis = {
  rawEventCount: number;
  keptEventIds: string[];
  discarded: DiscardedBranch[];
  strategy: 'lineage' | 'ordered_success_scan';
};
export type Trajectory = TrajectoryDraft & {
  id: string;
  createdAt: string;
  source: 'demo' | 'import';
  branchAnalysis?: BranchAnalysis;
};
export type Check = {
  name: string;
  category: 'schema' | 'sandbox' | 'failure' | 'policy' | 'regression';
  passed: boolean;
  detail: string;
  durationMs: number;
};
export type Capability = {
  id: string;
  name: string;
  version: number;
  trajectoryId: string;
  createdAt: string;
  status: 'draft' | 'verified' | 'approved' | 'rejected';
  description: string;
  operations: Operation[];
  policy: Policy;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  implementation: string;
  digest: string;
  contractVersion: number;
  checks: Check[];
  verifiedAt?: string;
  approvedAt?: string;
  reviewNote?: string;
  requiredScopes: string[];
  sideEffects: string[];
  invariants: string[];
  sourceEventIds?: string[];
  discardedBranches?: DiscardedBranch[];
};
export type Shipment = {
  id: string;
  customer: string;
  daysLate: number;
  owner: string;
  eligible: boolean;
};
export type Effect = {
  id: string;
  shipmentId: string;
  customer: string;
  amount: number;
  crmStatus: string;
  notification: string;
};
export type WorkflowOutput = {
  customers: number;
  totalCredit: number;
  effects: Effect[];
  attempts: number;
};
export type Run = {
  id: string;
  capabilityId: string;
  name: string;
  version: number;
  input: WorkflowInput;
  status: 'success' | 'blocked' | 'failed' | 'compensated';
  createdAt: string;
  durationMs: number;
  output?: WorkflowOutput;
  error?: string;
  idempotencyKey: string;
  logs: string[];
};
export type Audit = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
};
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  estimated: boolean;
};
export type AgentProviderOption = {
  id: string;
  label: string;
  kind: 'codex-cli' | 'future';
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  enabled: boolean;
  note: string;
};
export type CodingAgentEvent = {
  id: string;
  parentId?: string;
  operation: string;
  status: 'success' | 'failed' | 'skipped';
  transport: 'cli' | 'tool' | 'api';
  description: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  usage?: TokenUsage;
};
export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
};
export type CodingAgentDeployment = {
  id: string;
  capabilityId?: string;
  checks?: Check[];
  simulated?: boolean;
  sessionId: string;
  createdAt: string;
  status: 'success' | 'failed';
  output: string;
  error?: string;
  usage: TokenUsage;
  tokenDelta: number;
  tokenReductionPercent: number;
};
export type CodingAgentSession = {
  id: string;
  registryCapabilityId?: string;
  createdAt: string;
  updatedAt: string;
  task: string;
  status: 'success' | 'failed';
  provider: AgentProviderOption;
  messages: AgentMessage[];
  events: CodingAgentEvent[];
  finalEventId?: string;
  branchAnalysis: BranchAnalysis;
  usageBefore: TokenUsage;
  deploymentId?: string;
  lastOutput: string;
  error?: string;
};
export type GraphNode = {
  id: string;
  label: string;
  kind: 'capability' | 'system' | 'policy';
  status: string;
};
export type State = {
  trajectories: Trajectory[];
  capabilities: Capability[];
  runs: Run[];
  agentSessions: CodingAgentSession[];
  agentDeployments: CodingAgentDeployment[];
  codingCapabilities: CodingCapability[];
  agentProviders: AgentProviderOption[];
  audit: Audit[];
  deployments: Record<string, string>;
  contractVersion: number;
  graph: { nodes: GraphNode[]; edges: { from: string; to: string }[] };
  metrics: { successful: number; total: number; avgLatencyMs: number; totalCredit: number };
};
export const codingAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file_exists'), path: z.string().trim().min(1).max(240) }).strict(),
  z
    .object({
      kind: z.literal('file_contains'),
      path: z.string().trim().min(1).max(240),
      text: z.string().min(1).max(1000),
    })
    .strict(),
  z.object({ kind: z.literal('output_contains'), text: z.string().min(1).max(1000) }).strict(),
]);
export const codingPolicySchema = z
  .object({
    sandbox: z.enum(['read-only', 'workspace-write']),
    timeoutMs: z.number().int().min(1000).max(600000),
    maxOutputBytes: z.number().int().min(4096).max(2000000),
    networkAccess: z.literal(false),
    maxAttempts: z.literal(1),
    assertions: z.array(codingAssertionSchema).max(20),
  })
  .strict();
export type CodingPolicy = z.infer<typeof codingPolicySchema>;
export const defaultCodingPolicy: CodingPolicy = {
  sandbox: 'read-only',
  timeoutMs: 120000,
  maxOutputBytes: 1000000,
  networkAccess: false,
  maxAttempts: 1,
  assertions: [],
};
export type CodingCapability = {
  id: string;
  name: string;
  version: number;
  sessionId: string;
  createdAt: string;
  status: 'draft' | 'verified' | 'approved' | 'revoked';
  executionMode: 'codex-replay';
  simulated: boolean;
  task: string;
  prompt: string;
  provider: AgentProviderOption;
  workspace: string;
  sourceEvents: CodingAgentEvent[];
  policy: CodingPolicy;
  digest: string;
  checks: Check[];
  verifiedDigest?: string;
  verifiedAt?: string;
  approvedDigest?: string;
  approvedAt?: string;
  reviewNote?: string;
  lastDeploymentId?: string;
  sideEffects: string[];
  rollback: string;
};
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
