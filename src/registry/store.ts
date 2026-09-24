import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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

export type StoredDispatchRun = DispatchOutcome & { id: string };
type Records = {
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
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
      CREATE TABLE IF NOT EXISTS deployments (name TEXT PRIMARY KEY, capability_id TEXT NOT NULL REFERENCES records(id));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES ('contractVersion', '1');
      CREATE TABLE IF NOT EXISTS effects (shipment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES records(id), data TEXT NOT NULL);
    `);
  }
  all<K extends keyof Records>(kind: K): Records[K][] {
    return this.db
      .prepare('SELECT data FROM records WHERE kind = ? ORDER BY rowid DESC')
      .all(kind)
      .map((row) => JSON.parse(row.data as string) as Records[K]);
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind = ? AND id = ?').get(kind, id);
    return row ? (JSON.parse(row.data as string) as Records[K]) : undefined;
  }
  put<K extends keyof Records>(kind: K, value: Records[K]) {
    this.db
      .prepare(
        'INSERT INTO records(id,kind,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(value.id, kind, JSON.stringify(value));
  }
  deleteKind<K extends keyof Records>(kind: K) {
    this.db.prepare('DELETE FROM records WHERE kind = ?').run(kind);
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
        .prepare('SELECT name,capability_id FROM deployments')
        .all()
        .map((row) => [row.name, row.capability_id as string]),
    );
  }
  deploy(name: string, id: string) {
    this.db
      .prepare(
        'INSERT INTO deployments VALUES (?,?) ON CONFLICT(name) DO UPDATE SET capability_id=excluded.capability_id',
      )
      .run(name, id);
  }
  undeploy(name: string, id: string) {
    this.db.prepare('DELETE FROM deployments WHERE name = ? AND capability_id = ?').run(name, id);
  }
  get contractVersion() {
    return Number(
      this.db.prepare("SELECT value FROM settings WHERE key='contractVersion'").get()!.value,
    );
  }
  set contractVersion(value: number) {
    this.db.prepare("UPDATE settings SET value=? WHERE key='contractVersion'").run(String(value));
  }
  credited(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT shipment_id FROM effects')
        .all()
        .map((row) => row.shipment_id as string),
    );
  }
  writeEffects(runId: string, effects: Effect[]) {
    const insert = this.db.prepare('INSERT INTO effects VALUES (?,?,?)');
    for (const effect of effects) insert.run(effect.shipmentId, runId, JSON.stringify(effect));
  }
  compensate(runId: string) {
    this.db.prepare('DELETE FROM effects WHERE run_id=?').run(runId);
  }
  close() {
    this.db.close();
  }
}
