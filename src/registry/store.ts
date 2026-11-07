import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { currentIdentity } from '../security/identity.js';
import { migrate } from './migrations.js';
import { DomainError } from '../domain.js';
import type { CapabilityHealth } from '../telemetry/health.js';
import type { StoredTelemetry } from '../integration/protocol.js';
import type { ShadowRun } from '../runtime/shadow.js';
import type { OptimizationPattern } from '../compiler/analyze.js';
import type { IRArtifact } from '../compiler/ir.js';
import type { StoredToolTrace } from '../exploration/tool-events.js';
import type { ExecutionCheckpoint } from '../runtime/checkpoint.js';
import type { DispatchOutcome } from '../runtime/dispatcher.js';
import type {
  Audit,
  Capability,
  CodingAgentDeployment,
  CodingAgentSession,
  CodingCapability,
  Effect,
  Run,
  Trajectory,
} from '../domain.js';

export type StoredDispatchRun = DispatchOutcome & { id: string; expiresAt?: string };
type Records = {
  health: CapabilityHealth;
  telemetry: StoredTelemetry;
  shadowRun: ShadowRun;
  pattern: OptimizationPattern;
  trajectory: Trajectory;
  toolTrace: StoredToolTrace;
  irArtifact: IRArtifact;
  dispatchRun: StoredDispatchRun;
  checkpoint: ExecutionCheckpoint;
  capability: Capability;
  run: Run;
  audit: Audit;
  agentSession: CodingAgentSession;
  agentDeployment: CodingAgentDeployment;
  codingCapability: CodingCapability;
};
export class Store {
  readonly db: DatabaseSync;
  constructor(path = 'data/foundry.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    migrate(this.db);
    if (path !== ':memory:')
      for (const file of [path, `${path}-wal`, `${path}-shm`])
        if (existsSync(file)) chmodSync(file, 0o600);
  }
  get tenantId() {
    return currentIdentity().tenantId;
  }

  all<K extends keyof Records>(kind: K): Records[K][] {
    return this.db
      .prepare('SELECT data FROM records WHERE tenant_id = ? AND kind = ? ORDER BY rowid DESC')
      .all(this.tenantId, kind)
      .map((row) => JSON.parse(row.data as string) as Records[K]);
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] | undefined {
    const row = this.db
      .prepare('SELECT data FROM records WHERE tenant_id = ? AND kind = ? AND id = ?')
      .get(this.tenantId, kind, id);
    return row ? (JSON.parse(row.data as string) as Records[K]) : undefined;
  }
  put<K extends keyof Records>(kind: K, value: Records[K]) {
    const embedded = value as { tenantId?: string; ir?: { guards: { tenantId: string } } };
    if (
      (embedded.tenantId && embedded.tenantId !== this.tenantId) ||
      (embedded.ir && embedded.ir.guards.tenantId !== this.tenantId)
    )
      throw new DomainError('Tenant mismatch.', 403);
    const result = this.db
      .prepare(
        'INSERT INTO records(tenant_id,id,kind,data) VALUES (?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data WHERE records.kind=excluded.kind',
      )
      .run(this.tenantId, value.id, kind, JSON.stringify(value));
    if (!result.changes) throw new DomainError('Record identity belongs to another kind.', 409);
  }

  deleteKind<K extends keyof Records>(kind: K) {
    this.db
      .prepare('DELETE FROM records WHERE tenant_id = ? AND kind = ?')
      .run(this.tenantId, kind);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  deployments(): Record<string, string> {
    return Object.fromEntries(
      this.db
        .prepare('SELECT name,capability_id FROM deployments WHERE tenant_id = ?')
        .all(this.tenantId)
        .map((row) => [row.name, row.capability_id as string]),
    );
  }
  deploy(name: string, id: string) {
    this.db
      .prepare(
        'INSERT INTO deployments VALUES (?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET capability_id=excluded.capability_id',
      )
      .run(this.tenantId, name, id);
  }
  undeploy(name: string, id: string) {
    this.db
      .prepare('DELETE FROM deployments WHERE tenant_id = ? AND name = ? AND capability_id = ?')
      .run(this.tenantId, name, id);
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE tenant_id=? AND key=?')
      .get(this.tenantId, key);
    return row ? (JSON.parse(row.value as string) as T) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value',
      )
      .run(this.tenantId, key, JSON.stringify(value));
  }
  get contractVersion() {
    this.db
      .prepare("INSERT OR IGNORE INTO settings VALUES (?, 'contractVersion', '1')")
      .run(this.tenantId);
    return Number(
      this.db
        .prepare("SELECT value FROM settings WHERE tenant_id=? AND key='contractVersion'")
        .get(this.tenantId)!.value,
    );
  }
  set contractVersion(value: number) {
    this.db
      .prepare("UPDATE settings SET value=? WHERE tenant_id=? AND key='contractVersion'")
      .run(String(value), this.tenantId);
  }
  credited(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT shipment_id FROM effects WHERE tenant_id = ?')
        .all(this.tenantId)
        .map((row) => row.shipment_id as string),
    );
  }
  writeEffects(runId: string, effects: Effect[]) {
    const insert = this.db.prepare('INSERT INTO effects VALUES (?,?,?,?)');
    for (const effect of effects)
      insert.run(this.tenantId, effect.shipmentId, runId, JSON.stringify(effect));
  }
  compensate(runId: string) {
    this.db.prepare('DELETE FROM effects WHERE tenant_id=? AND run_id=?').run(this.tenantId, runId);
  }
  deleteRecord(kind: keyof Records, id: string) {
    this.db
      .prepare('DELETE FROM records WHERE tenant_id=? AND kind=? AND id=?')
      .run(this.tenantId, kind, id);
  }
  consumeQuota(bucket: string, limit: number, now = Date.now()) {
    const window = Math.floor(now / 60000);
    this.db.prepare('DELETE FROM quotas WHERE window < ?').run(window - 1);
    const result = this.db
      .prepare(
        'INSERT INTO quotas VALUES (?,?,?,1) ON CONFLICT(tenant_id,bucket,window) DO UPDATE SET count=count+1 WHERE count < ?',
      )
      .run(this.tenantId, bucket, window, limit);
    if (!result.changes) throw new DomainError('Tenant request quota exceeded.', 429);
  }
  purgeExpired(now = Date.now()): number {
    const expired = this.db
      .prepare('SELECT kind,id,data FROM records WHERE tenant_id=? AND kind IN (?,?,?,?,?)')
      .all(this.tenantId, 'toolTrace', 'telemetry', 'shadowRun', 'dispatchRun', 'checkpoint')
      .filter((row) => {
        const expiry = (JSON.parse(row.data as string) as { expiresAt?: string }).expiresAt;
        return expiry && Date.parse(expiry) <= now;
      });
    this.transaction(() => {
      for (const row of expired) this.deleteRecord(row.kind as keyof Records, row.id as string);
    });
    return expired.length;
  }
  exportData() {
    return this.db
      .prepare('SELECT kind,data FROM records WHERE tenant_id=? AND kind != ?')
      .all(this.tenantId, 'audit')
      .map((row) => ({ kind: row.kind, data: JSON.parse(row.data as string) as unknown }));
  }
  deleteData() {
    this.transaction(() => {
      for (const table of ['effects', 'deployments', 'records', 'settings', 'quotas'])
        this.db.prepare(`DELETE FROM ${table} WHERE tenant_id=?`).run(this.tenantId);
    });
  }
  close() {
    this.db.close();
  }
}
