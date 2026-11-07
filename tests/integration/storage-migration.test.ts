import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { Store } from '../../src/registry/store.js';
import { localIdentity, withIdentity } from '../../src/security/identity.js';

it('atomically migrates an existing database, retaining deployment/effect relationships and settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-migration-'));
  const path = join(directory, 'legacy.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,data TEXT);
      CREATE TABLE deployments(name TEXT PRIMARY KEY,capability_id TEXT REFERENCES records(id));
      CREATE TABLE effects(shipment_id TEXT PRIMARY KEY,run_id TEXT REFERENCES records(id),data TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO records VALUES ('cap','audit','{"id":"cap","actor":"legacy"}');
      INSERT INTO deployments VALUES ('cap','cap');
      INSERT INTO effects VALUES ('shipment','cap','{}');
      INSERT INTO settings VALUES ('contractVersion','9');`);
    db.close();
    const store = new Store(path);
    try {
      expect(store.contractVersion).toBe(9);
      expect(store.deployments()).toEqual({ cap: 'cap' });
      expect(store.credited().has('shipment')).toBe(true);
      expect(store.get('audit', 'cap')?.actor).toBe('legacy');
      withIdentity({ ...localIdentity, tenantId: 'other' }, () => {
        expect(store.get('audit', 'cap')).toBeUndefined();
        expect(store.deployments()).toEqual({});
      });
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      store.close();
    }
    const reopened = new Store(path);
    expect(reopened.contractVersion).toBe(9);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
