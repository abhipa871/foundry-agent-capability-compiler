import { customerInput, type ReadOperation } from '../compiler/ir.js';
import { DomainError } from '../domain.js';
import {
  authorizeReads,
  contracts,
  type AdapterRunner,
  type RuntimeContext,
} from '../runtime/adapters/registry.js';

const fingerprint = (context: RuntimeContext) =>
  JSON.stringify([
    context.tenantId,
    context.principalId,
    context.policyVersion,
    context.snapshot,
    Object.entries(context.adapterVersions).sort(),
    [...context.scopes].sort(),
    context.allowedCustomerIds ? [...context.allowedCustomerIds].sort() : null,
  ]);
// One request only, read-only, no persistence. The caller must declare a valid adapter freshness
// window; reuse never crosses identity, authorization, snapshot, policy or adapter versions.
export class RequestReadCache {
  private readonly entries = new Map<
    ReadOperation,
    { at: number; binding: string; value: unknown }
  >();
  readonly customerId: string;
  hits = 0;
  constructor(
    private readonly options: {
      adapters: AdapterRunner;
      input: { customerId: string };
      freshnessMs: number;
      now?: () => number;
    },
  ) {
    this.customerId = customerInput.parse(options.input).customerId;
    if (
      !Number.isFinite(options.freshnessMs) ||
      options.freshnessMs < 1 ||
      options.freshnessMs > 60000
    )
      throw new Error('Read reuse needs an explicit 1–60000ms freshness contract.');
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private valid(operation: ReadOperation, context: RuntimeContext) {
    const entry = this.entries.get(operation);
    const age = entry ? this.now() - entry.at : -1;
    const contextAge = this.now() - context.observedAt;
    return entry &&
      age >= 0 &&
      age <= this.options.freshnessMs &&
      contextAge >= 0 &&
      contextAge <= this.options.freshnessMs &&
      entry.binding === fingerprint(context)
      ? entry
      : undefined;
  }
  readonly adapters: AdapterRunner = async (operation, args, context, signal) => {
    if (args.customerId !== this.customerId || !Object.hasOwn(contracts, operation))
      throw new DomainError('Read outside bound request.', 403);
    authorizeReads(context, args, [operation]);
    signal.throwIfAborted();
    const cached = this.valid(operation, context);
    if (cached) {
      this.hits++;
      return structuredClone(cached.value);
    }
    const raw = await this.options.adapters(operation, args, context, signal);
    signal.throwIfAborted();
    const value = contracts[operation].output.parse(raw);
    if (
      value.customerId !== args.customerId ||
      value.tenantId !== context.tenantId ||
      value.snapshot !== context.snapshot
    )
      throw new DomainError('Read result identity mismatch.', 409);
    this.entries.set(operation, {
      at: this.now(),
      binding: fingerprint(context),
      value: structuredClone(value),
    });
    return value;
  };
  available(context: RuntimeContext): Partial<Record<ReadOperation, unknown>> {
    const result: Partial<Record<ReadOperation, unknown>> = {};
    for (const operation of this.entries.keys()) {
      try {
        authorizeReads(context, { customerId: this.customerId }, [operation]);
      } catch {
        continue;
      }
      const cached = this.valid(operation, context);
      if (cached) result[operation] = structuredClone(cached.value);
    }
    return result;
  }
}
