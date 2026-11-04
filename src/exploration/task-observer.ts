import { randomUUID } from 'node:crypto';
import {
  contractId,
  digest,
  json,
  replayJson,
  type AccessContext,
  type ContractRegistry,
  type Json,
} from '../compiler/contracts.js';
import {
  bindingSchema,
  materialize,
  taskTraceSchema,
  type Binding,
  type TaskTrace,
} from '../compiler/task-ir.js';
import { DomainError } from '../domain.js';

export class TaskObserver {
  private readonly values = new Map<string, Json>();
  private readonly events: TaskTrace['events'] = [];
  private readonly pending = new Set<string>();
  private readonly input: Json;
  private readonly context: AccessContext;
  constructor(
    private readonly registry: ContractRegistry,
    private readonly kind: string,
    input: unknown,
    context: AccessContext,
  ) {
    this.context = structuredClone(context);
    this.input = replayJson(registry.authorizeTask(kind, input, this.context));
  }
  async call(id: string, tool: string, bindings: Record<string, Binding>): Promise<Json> {
    contractId.parse(id);
    if (!this.registry.toolManifest(tool).replaySafe)
      throw new DomainError('Tool has not opted into replay evidence capture.', 403);
    if (this.pending.has(id) || this.values.has(id) || this.events.length + this.pending.size >= 64)
      throw new DomainError('Duplicate node or trajectory budget exceeded.', 409);
    this.pending.add(id);
    try {
      const args = Object.fromEntries(
        Object.entries(json(bindings) as Record<string, unknown>).map(([key, binding]) => [
          key,
          bindingSchema.parse(binding),
        ]),
      );
      const argsValue = materialize(args, this.input, this.values);
      const result = replayJson(
        await this.registry.invoke(
          this.kind,
          tool,
          argsValue,
          this.context,
          AbortSignal.timeout(this.registry.task(this.kind).timeoutMs),
        ),
      );
      this.values.set(id, result);
      this.events.push({
        id,
        tool,
        args,
        argsValue,
        result,
        contractDigest: digest(this.registry.toolManifest(tool)),
      });
      return json(result);
    } finally {
      this.pending.delete(id);
    }
  }
  finish(output: Record<string, Binding>): TaskTrace {
    if (this.pending.size) throw new DomainError('Trajectory still has pending tools.', 409);
    const result = json(
      this.registry.task(this.kind).output.parse(materialize(output, this.input, this.values)),
    );
    return taskTraceSchema.parse({
      id: randomUUID(),
      kind: this.kind,
      taskDigest: digest(this.registry.taskManifest(this.kind)),
      tenantId: this.context.tenantId,
      principalId: this.context.principalId,
      policyVersion: this.context.policyVersion,
      snapshot: this.context.snapshot,
      input: this.input,
      events: this.events,
      output,
      result,
    });
  }
}
