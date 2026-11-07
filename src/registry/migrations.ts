import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync) {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version >= 2) return;
  const legacy = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get(),
  );
  // Schema changes and the local-demo backfill are atomic. Old installations had only this
  // tenant; never infer ownership from untrusted JSON stored before authentication existed.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE records_v2 (tenant_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(tenant_id,id));
      CREATE TABLE deployments_v2 (tenant_id TEXT NOT NULL, name TEXT NOT NULL, capability_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id,name), FOREIGN KEY(tenant_id,capability_id) REFERENCES records_v2(tenant_id,id));
      CREATE TABLE settings_v2 (tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(tenant_id,key));
      CREATE TABLE effects_v2 (tenant_id TEXT NOT NULL, shipment_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(tenant_id,shipment_id), FOREIGN KEY(tenant_id,run_id) REFERENCES records_v2(tenant_id,id));
    `);
    if (legacy)
      db.exec(`
      INSERT INTO records_v2 SELECT 'local-demo',id,kind,data FROM records;
      INSERT INTO deployments_v2 SELECT 'local-demo',name,capability_id FROM deployments;
      INSERT INTO settings_v2 SELECT 'local-demo',key,value FROM settings;
      INSERT INTO effects_v2 SELECT 'local-demo',shipment_id,run_id,data FROM effects;
      DROP TABLE effects; DROP TABLE deployments; DROP TABLE settings; DROP TABLE records;
    `);
    db.exec(`
      ALTER TABLE records_v2 RENAME TO records;
      ALTER TABLE deployments_v2 RENAME TO deployments;
      ALTER TABLE settings_v2 RENAME TO settings;
      ALTER TABLE effects_v2 RENAME TO effects;
      CREATE INDEX records_tenant_kind ON records(tenant_id,kind);
      CREATE TABLE quotas (tenant_id TEXT NOT NULL, bucket TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,bucket,window));
      INSERT OR IGNORE INTO settings VALUES ('local-demo','contractVersion','1');
      PRAGMA user_version=2;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
