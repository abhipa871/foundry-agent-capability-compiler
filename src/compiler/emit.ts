import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain.js';
import {
  irDigest,
  validateIR,
  type CapabilityIR,
  type CompileReport,
  type IRArtifact,
} from './ir.js';

// The artifact is the unit of trust: IR, pinned adapter contract versions, required scopes,
// guards, invariants, provenance and a content digest over all of it. Nothing else is executable.
export function emitArtifact(
  ir: CapabilityIR,
  report: CompileReport,
  options: { version: number; id?: string },
): IRArtifact {
  const validated = validateIR(ir);
  return {
    id: options.id ?? randomUUID(),
    name: validated.name,
    taskKind: validated.taskKind,
    version: options.version,
    createdAt: new Date().toISOString(),
    status: 'draft',
    ir: validated,
    digest: irDigest(validated),
    report,
    checks: [],
  };
}

export function assertDigest(artifact: IRArtifact): IRArtifact {
  if (irDigest(artifact.ir) !== artifact.digest)
    throw new DomainError('Artifact digest does not match its IR; refusing to execute.', 409);
  return artifact;
}
