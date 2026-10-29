import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FrameworkError } from './errors.js';
import { initializeSQLite } from './sqlite-init.js';
import type { Activation, ReleaseRecord } from './release-types.js';

export class ReleaseStore {
  private db: DatabaseSync | undefined;
  constructor(readonly root: string, readOnly = false) {
    const path = join(root, 'releases.sqlite');
    if (readOnly && !existsSync(path)) return;
    if (!readOnly) mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec('PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1 || (readOnly && version !== 1)) {
      this.db.close();
      throw new FrameworkError('CONFIGURATION_ERROR', `Release store schema ${version} is unsupported; expected schema 1.`);
    }
    if (!readOnly) {
      initializeSQLite(() => this.db!.exec('PRAGMA journal_mode=WAL;'));
      this.db.exec(`
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS activations (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, release_id TEXT, paused INTEGER NOT NULL);
        PRAGMA user_version=1;
      `);
    }
  }
  active(scope: string): Activation {
    const row = this.db?.prepare('SELECT revision, release_id, paused FROM activations WHERE scope=?').get(scope) as { revision: number; release_id: string | null; paused: number } | undefined;
    return row ? { revision: row.revision, releaseId: row.release_id, paused: Boolean(row.paused) } : { revision: 0, releaseId: null, paused: false };
  }
  release(id: string): ReleaseRecord {
    const row = this.db?.prepare('SELECT body FROM releases WHERE id=?').get(id) as { body: string } | undefined;
    if (!row) throw new FrameworkError('NOT_FOUND', `Release ${id} was not found.`);
    return JSON.parse(row.body) as ReleaseRecord;
  }
  activate(scope: string, expectedRevision: number, release: ReleaseRecord): Activation {
    if (!this.db) throw new FrameworkError('CONFIGURATION_ERROR', 'Release store is not writable.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.active(scope).revision !== expectedRevision) throw new FrameworkError('CONFLICT', 'Environment changed after planning; generate a new plan.');
      this.db.prepare('INSERT OR IGNORE INTO releases (id, body) VALUES (?, ?)').run(release.id, JSON.stringify(release));
      this.db.prepare('INSERT INTO activations (scope, revision, release_id, paused) VALUES (?, ?, ?, 0) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, release_id=excluded.release_id, paused=0').run(scope, expectedRevision + 1, release.id);
      this.db.exec('COMMIT');
      return { revision: expectedRevision + 1, releaseId: release.id, paused: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pause(scope: string): Activation {
    if (!this.db) throw new FrameworkError('NOT_FOUND', 'No local deployment exists.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.active(scope);
      if (!current.releaseId) throw new FrameworkError('NOT_FOUND', 'No active release exists for this environment.');
      if (!current.paused) this.db.prepare('UPDATE activations SET paused=1, revision=revision+1 WHERE scope=?').run(scope);
      this.db.exec('COMMIT');
      return { ...current, paused: true, revision: current.paused ? current.revision : current.revision + 1 };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db?.close(); }
}