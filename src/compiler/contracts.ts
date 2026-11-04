import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain.js';

export const contractId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Validate the JSON boundary before recursive schema parsing or traversing model/tool data.
export function json(value: unknown): Json {
  let entries = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++entries > 20000 || depth > 24)
      throw new DomainError('JSON complexity exceeds budget.', 400);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string' && item.length <= 131072) return;
    if (Array.isArray(item)) {
      item.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      for (const [key, entry] of Object.entries(item)) {
        if (forbidden.has(key)) throw new DomainError('Unsafe JSON property.', 400);
        visit(entry, depth + 1);
      }
      return;
    }
    throw new DomainError('Expected finite JSON data.', 400);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 262144)
    throw new DomainError('JSON exceeds size budget.', 413);
  return structuredClone(value) as Json;
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

export function replayJson(value: unknown): Json {
  const parsed = json(value);
  const visit = (entry: Json): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    for (const [key, child] of Object.entries(entry)) {
      if (
        /^(authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credentials?)$/i.test(
          key,
        )
      )
        throw new DomainError('Secret-bearing fields cannot enter replay evidence.', 400);
      visit(child);
    }
  };
  visit(parsed);
  return parsed;
}

export const accessSchema = z
  .object({
    tenantId: z.string().min(1).max(80),
    principalId: z.string().min(1).max(80),
    scopes: z.array(z.string().min(1).max(100)).max(256),
    policyVersion: z.string().min(1).max(80),
    snapshot: z.string().min(1).max(128),
    observedAt: z.number().int().nonnegative(),
  })
  .strict();
export type AccessContext = Readonly<z.infer<typeof accessSchema>>;

export type ToolContract = {
  name: string;
  version: string;
  description: string;
  effect: 'read' | 'pure';
  scopes: string[];
  input: z.ZodType;
  output: z.ZodType;
  timeoutMs: number;
  // Explicit application consent to retain replayable values. Off by default.
  replaySafe?: boolean;
  // All row/resource ownership checks are application-owned and run before AND after each read.
  authorize: (context: AccessContext, args: Json) => boolean;
  validateResult: (context: AccessContext, args: Json, result: Json) => boolean;
  run: (args: Json, context: AccessContext, signal: AbortSignal) => Promise<unknown>;
};
export type TaskContract = {
  kind: string;
  version: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  tools: string[];
  maxAgeMs: number;
  maxConcurrency: number;
  timeoutMs: number;
  authorize: (context: AccessContext, input: Json) => boolean;
};
export type ToolManifest = {
  name: string;
  version: string;
  description: string;
  effect: 'read' | 'pure';
  scopes: string[];
  inputSchema: Json;
  outputSchema: Json;
  timeoutMs: number;
  replaySafe: boolean;
};
export type TaskManifest = {
  kind: string;
  version: string;
  description: string;
  tools: string[];
  inputSchema: Json;
  outputSchema: Json;
  maxAgeMs: number;
  maxConcurrency: number;
  timeoutMs: number;
};

function schemaJson(schema: z.ZodType): Json {
  return json(z.toJSONSchema(schema));
}

export class ContractRegistry {
  private readonly tools = new Map<string, { contract: ToolContract; manifest: ToolManifest }>();
  private readonly tasks = new Map<string, { contract: TaskContract; manifest: TaskManifest }>();
  registerTool(contract: ToolContract): this {
    const name = contractId.parse(contract.name);
    if (this.tools.has(name)) throw new DomainError('Tool already registered.', 409);
    if (!['read', 'pure'].includes(contract.effect))
      throw new DomainError('Unsupported effect class.', 409);
    z.number().int().min(1).max(60000).parse(contract.timeoutMs);
    z.string().min(1).max(80).parse(contract.version);
    z.array(z.string().min(1).max(100)).max(64).parse(contract.scopes);
    if (typeof contract.authorize !== 'function' || typeof contract.validateResult !== 'function')
      throw new DomainError('Explicit tool authorization and result isolation required.', 409);
    const manifest: ToolManifest = {
      name,
      version: contract.version,
      description: contract.description,
      effect: contract.effect,
      scopes: [...new Set(contract.scopes)].sort(),
      inputSchema: schemaJson(contract.input),
      outputSchema: schemaJson(contract.output),
      timeoutMs: contract.timeoutMs,
      replaySafe: contract.replaySafe === true,
    };
    this.tools.set(name, {
      contract: Object.freeze({ ...contract, scopes: [...manifest.scopes] }),
      manifest,
    });
    return this;
  }
  registerTask(contract: TaskContract): this {
    const kind = contractId.parse(contract.kind);
    if (this.tasks.has(kind)) throw new DomainError('Task already registered.', 409);
    if (
      !contract.tools.length ||
      contract.tools.length > 64 ||
      new Set(contract.tools).size !== contract.tools.length
    )
      throw new DomainError('Task requires unique registered tools.', 409);
    contract.tools.forEach((name) => this.tool(name));
    z.number().int().min(1).max(3600000).parse(contract.maxAgeMs);
    z.number().int().min(1).max(32).parse(contract.maxConcurrency);
    z.number().int().min(1).max(120000).parse(contract.timeoutMs);
    z.string().min(1).max(80).parse(contract.version);
    const manifest: TaskManifest = {
      kind,
      version: contract.version,
      description: contract.description,
      tools: [...contract.tools].sort(),
      inputSchema: schemaJson(contract.input),
      outputSchema: schemaJson(contract.output),
      maxAgeMs: contract.maxAgeMs,
      maxConcurrency: contract.maxConcurrency,
      timeoutMs: contract.timeoutMs,
    };
    this.tasks.set(kind, {
      contract: Object.freeze({ ...contract, tools: [...manifest.tools] }),
      manifest,
    });
    return this;
  }
  tool(name: string): ToolContract {
    const entry = this.tools.get(name);
    if (!entry) throw new DomainError('Tool is not registered.', 409);
    return { ...entry.contract, scopes: [...entry.contract.scopes] };
  }
  task(kind: string): TaskContract {
    const entry = this.tasks.get(kind);
    if (!entry) throw new DomainError('Task is not registered.', 409);
    return { ...entry.contract, tools: [...entry.contract.tools] };
  }
  toolManifest(name: string): ToolManifest {
    this.tool(name);
    return structuredClone(this.tools.get(name)!.manifest);
  }
  taskManifest(kind: string): TaskManifest {
    this.task(kind);
    return structuredClone(this.tasks.get(kind)!.manifest);
  }
  catalog() {
    return {
      tasks: [...this.tasks.keys()].sort().map((kind) => this.taskManifest(kind)),
      tools: [...this.tools.keys()].sort().map((name) => this.toolManifest(name)),
    };
  }
  authorizeTask(kind: string, rawInput: unknown, rawContext: AccessContext): Json {
    const context = accessSchema.parse(rawContext);
    const task = this.task(kind);
    const input = json(task.input.parse(json(rawInput)));
    if (!task.authorize(context, input)) throw new DomainError('Task access denied.', 403);
    return input;
  }
  async invoke(
    kind: string,
    name: string,
    rawArgs: unknown,
    context: AccessContext,
    signal: AbortSignal,
  ): Promise<Json> {
    context = accessSchema.parse(json(context));
    const tool = this.tool(name);
    if (!this.task(kind).tools.includes(name))
      throw new DomainError('Tool is outside task contract.', 403);
    const args = json(tool.input.parse(json(rawArgs)));
    if (
      tool.scopes.some((scope) => !context.scopes.includes(scope)) ||
      !tool.authorize(context, args)
    )
      throw new DomainError('Tool access denied.', 403);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(), tool.timeoutMs);
    let onAbort: () => void = () => {};
    try {
      combined.throwIfAborted();
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DomainError('Tool deadline exceeded.', 504));
        combined.addEventListener('abort', onAbort, { once: true });
      });
      const raw = await Promise.race([
        tool.run(json(args), structuredClone(context), combined),
        interrupted,
      ]);
      combined.throwIfAborted();
      const result = json(tool.output.parse(json(raw)));
      if (!tool.validateResult(context, args, result))
        throw new DomainError('Tool result isolation failed.', 403);
      return result;
    } finally {
      clearTimeout(timeout);
      combined.removeEventListener('abort', onAbort);
    }
  }
}
