import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain.js';
import {
  contractId,
  json,
  type AccessContext,
  type ContractRegistry,
} from '../compiler/contracts.js';
import {
  guardTask,
  runTaskPlan,
  taskArtifactSchema,
  type TaskArtifact,
  type TaskOutcome,
} from '../runtime/task-runtime.js';

export const taskTicketSchema = z
  .object({
    format: z.literal('foundry-task-ticket-v1'),
    tenantId: z.string(),
    principalId: z.string(),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
    artifact: taskArtifactSchema,
  })
  .strict();
export type TaskTicket = z.infer<typeof taskTicketSchema>;
export const signedTaskTicketSchema = z
  .object({ payload: z.string().max(131072), signature: z.string().max(256) })
  .strict();

export function verifyTaskTicket(
  raw: unknown,
  publicKey: string,
  context: AccessContext,
  name: string,
  now = Date.now(),
): TaskArtifact {
  const signed = signedTaskTicketSchema.parse(raw);
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(signed.payload), key, Buffer.from(signed.signature, 'base64'))
  )
    throw new DomainError('Capability signature invalid.', 409);
  const ticket = taskTicketSchema.parse(json(JSON.parse(signed.payload)));
  if (
    ticket.tenantId !== context.tenantId ||
    ticket.principalId !== context.principalId ||
    ticket.artifact.plan.name !== name
  )
    throw new DomainError('Capability ticket identity mismatch.', 403);
  if (
    ticket.issuedAt > now ||
    ticket.expiresAt <= now ||
    ticket.expiresAt - ticket.issuedAt > 30000
  )
    throw new DomainError('Capability ticket expired.', 409);
  return ticket.artifact;
}

export type TaskClientOptions = {
  registry: ContractRegistry;
  context: () => AccessContext;
  endpoint: string;
  apiKey: string;
  trustedPublicKey: string;
  fetch?: typeof fetch;
  networkTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
};

const shadowReceiptSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string(),
    principalId: z.string(),
    artifactId: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    verificationId: z.string().uuid().optional(),
    inputDigest: z.string(),
    contextDigest: z.string(),
    status: z.enum(['match', 'mismatch', 'failed']),
  })
  .strict();
export type ShadowReceipt = z.infer<typeof shadowReceiptSchema>;

export class TaskClient {
  private readonly endpoint: string;
  constructor(private readonly options: TaskClientOptions) {
    const url = new URL(options.endpoint);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      throw new Error('Capability endpoint requires HTTPS or loopback.');
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Unsafe capability endpoint.');
    this.endpoint = url.toString().replace(/\/$/, '');
    if (!options.apiKey || !options.trustedPublicKey)
      throw new Error('Credential and pinned key required.');
  }
  private async request(
    path: string,
    body?: unknown,
    timeoutMs = this.options.networkTimeoutMs ?? 5000,
  ): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.endpoint}/api/v2/tasks${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(json(body)),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError('Task control plane unavailable.', response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DomainError('Missing capability response.', 503);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 262144) throw new DomainError('Capability response exceeds budget.', 413);
        chunks.push(part.value);
      }
      return json(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async observe(trace: unknown): Promise<{ id: string }> {
    return z
      .object({ id: z.string().uuid() })
      .strict()
      .parse(await this.request('/traces', trace));
  }
  async compile(name: string, traceIds: readonly string[]): Promise<TaskArtifact> {
    const body = z
      .object({ name: contractId, traceIds: z.array(z.string().uuid()).min(2).max(32) })
      .strict()
      .parse({ name, traceIds });
    return taskArtifactSchema.parse(
      await this.request('/compile', body, this.options.lifecycleTimeoutMs ?? 120000),
    );
  }
  async verify(id: string): Promise<TaskArtifact> {
    return taskArtifactSchema.parse(
      await this.request(
        `/capabilities/${z.string().uuid().parse(id)}/verify`,
        {},
        this.options.lifecycleTimeoutMs ?? 120000,
      ),
    );
  }
  async shadow(id: string, input: unknown): Promise<ShadowReceipt> {
    return shadowReceiptSchema.parse(
      await this.request(
        `/capabilities/${z.string().uuid().parse(id)}/shadow`,
        { input },
        this.options.lifecycleTimeoutMs ?? 120000,
      ),
    );
  }
  async approve(id: string): Promise<TaskArtifact> {
    return this.lifecycleAction(id, 'approve');
  }
  async deploy(id: string): Promise<TaskArtifact> {
    return this.lifecycleAction(id, 'deploy');
  }
  async revoke(id: string): Promise<TaskArtifact> {
    return this.lifecycleAction(id, 'revoke');
  }
  private async lifecycleAction(
    id: string,
    action: 'approve' | 'deploy' | 'revoke',
  ): Promise<TaskArtifact> {
    return taskArtifactSchema.parse(
      await this.request(`/capabilities/${z.string().uuid().parse(id)}/${action}`, {}),
    );
  }
  async capabilities(): Promise<TaskArtifact[]> {
    return z
      .array(taskArtifactSchema)
      .max(1000)
      .parse(await this.request('/capabilities'));
  }
  async capability(name: string): Promise<TaskArtifact> {
    const context = this.options.context();
    return verifyTaskTicket(
      await this.request(`/runtime/${encodeURIComponent(name)}`),
      this.options.trustedPublicKey,
      context,
      name,
    );
  }
  async execute(request: { name: string; kind: string; input: unknown }): Promise<TaskOutcome> {
    try {
      const context = this.options.context();
      this.options.registry.authorizeTask(request.kind, request.input, context);
      // Fresh offer on every invocation bounds remote revocation; no unsigned artifact cache.
      const artifact = await this.capability(request.name);
      return await runTaskPlan(
        artifact,
        request.kind,
        request.input,
        context,
        this.options.registry,
      );
    } catch (error) {
      const denied = error instanceof DomainError && [401, 403].includes(error.status);
      return {
        mode: denied ? 'denied' : 'fallback',
        outcome: denied ? 'denied' : 'unresolved',
        llmInvocations: 0,
        toolCalls: 0,
      };
    }
  }
}

export type TaskPlacement = 'normal' | 'compiled_tool' | 'compiled_prefetch' | 'denied';
export function selectTaskExecution(options: {
  registry: ContractRegistry;
  context: AccessContext;
  artifact?: TaskArtifact;
  kind: string;
  input: unknown;
  requirement: 'known' | 'agent_decides';
  // This function is called by application code. Never expose this contract as model arguments.
  requiredTools: readonly string[];
}): { mode: TaskPlacement; reason: string } {
  try {
    const task = options.registry.task(options.kind);
    options.registry.authorizeTask(options.kind, options.input, options.context);
    if (options.requiredTools.some((tool) => !task.tools.includes(tool)))
      throw new DomainError('Required tool not allowed.', 403);
    if (!options.artifact) return { mode: 'normal', reason: 'no_approved_artifact' };
    guardTask(options.artifact, options.kind, options.input, options.context, options.registry);
    const compiledTools = [...new Set(options.artifact.plan.nodes.map((node) => node.tool))].sort();
    if (
      JSON.stringify(compiledTools) !== JSON.stringify([...new Set(options.requiredTools)].sort())
    )
      return { mode: 'normal', reason: 'compiled_region_exceeds_or_misses_required_tools' };
    return {
      mode: options.requirement === 'known' ? 'compiled_prefetch' : 'compiled_tool',
      reason: 'application_contract_matches_approved_region',
    };
  } catch (error) {
    return error instanceof DomainError && error.status === 403
      ? { mode: 'denied', reason: 'access_denied' }
      : { mode: 'normal', reason: 'guard_miss' };
  }
}
