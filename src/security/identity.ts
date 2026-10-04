import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain.js';

export const tenantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const permissions = [
  'read',
  'observe',
  'compile',
  'verify',
  'approve',
  'deploy',
  'invoke',
  'admin',
] as const;
export const identitySchema = z
  .object({
    tenantId: tenantIdSchema,
    principalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
    agentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
    permissions: z.array(z.enum(permissions)).max(8),
    toolScopes: z.array(z.enum(['crm:read', 'orders:read', 'payments:read'])).max(3),
    customerIds: z.array(z.string().regex(/^C-\d{3}$/)).max(100),
  })
  .strict();
export type Identity = z.infer<typeof identitySchema>;
export const localIdentity: Identity = {
  tenantId: 'local-demo',
  principalId: 'local-operator',
  agentId: 'local-agent',
  permissions: [...permissions],
  toolScopes: ['crm:read', 'orders:read', 'payments:read'],
  customerIds: ['C-101', 'C-202', 'C-303', 'C-404'],
};
const identities = new AsyncLocalStorage<Identity>();
export const currentIdentity = () => identities.getStore() ?? localIdentity;
export function withIdentity<T>(identity: Identity, fn: () => T): T {
  return identities.run(identitySchema.parse(identity), fn);
}
export function requirePermission(permission: (typeof permissions)[number]) {
  if (!currentIdentity().permissions.includes(permission))
    throw new DomainError('Permission denied.', 403);
}

// The application supplies digests, never embedded credentials. Rotation/revocation replaces
// this configuration; hosted identity integration can implement the same authenticate contract.
export class ApiKeyAuthenticator {
  private readonly keys = new Map<string, Identity>();
  constructor(entries: { sha256: string; identity: Identity }[]) {
    for (const entry of entries) {
      const digest = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(entry.sha256);
      if (this.keys.has(digest)) throw new Error('Duplicate credential digest.');
      this.keys.set(digest, identitySchema.parse(entry.identity));
    }
  }
  authenticate(authorization: string | undefined): Identity {
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))
      throw new DomainError('Authentication required.', 401);
    const digest = createHash('sha256').update(authorization.slice(7)).digest('hex');
    const identity = this.keys.get(digest);
    if (!identity) throw new DomainError('Authentication required.', 401);
    return structuredClone(identity);
  }
}
