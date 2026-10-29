import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEvent, RunRecord, RunStatus, RunStore } from './contracts.js';
import { FrameworkError } from './errors.js';
import { initializeSQLite } from './sqlite-init.js';

const active = new Set<RunStatus>(['running', 'waiting_approval']);

export function nextRecord(run: RunRecord, owner: string, version: number, status?: RunStatus): RunRecord {
  if (run.owner !== owner || run.version !== version || !active.has(run.status)) {
    throw new FrameworkError('CONFLICT', `Run ${run.id} has another owner, a newer version, or is already terminal.`);
  }
  return { ...run, status: status ?? run.status, version: version + 1, updatedAt: new Date().toISOString() };
}

export class SQLiteRunStore implements RunStore {
  readonly capabilities = { persistent: true, continuation: false } as const;
  private db: DatabaseSync;

  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    this.db.exec('PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1 || (options.readOnly && version !== 1)) {
      this.db.close();
      throw new FrameworkError('CONFIGURATION_ERROR', `Run store schema ${version} is not supported; expected schema 1.`);
    }
    if (options.readOnly) return;
    initializeSQLite(() => this.db.exec('PRAGMA journal_mode=WAL;'));
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      PRAGMA user_version=1;
    `);
  }

  create(input: Omit<RunRecord, 'version' | 'status' | 'createdAt' | 'updatedAt'>): RunRecord {
    const now = new Date().toISOString();
    const run: RunRecord = { ...input, status: 'running', version: 0, createdAt: now, updatedAt: now };
    try {
      this.db.prepare('INSERT INTO runs (id, body) VALUES (?, ?)').run(run.id, JSON.stringify(run));
    } catch (error) {
      if (this.db.prepare('SELECT id FROM runs WHERE id=?').get(run.id)) throw new FrameworkError('CONFLICT', `Run ${run.id} already exists.`, { cause: error });
      throw error;
    }
    return run;
  }

  get(id: string): RunRecord {
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id) as { body: string } | undefined;
    if (!row) throw new FrameworkError('NOT_FOUND', `Run ${id} was not found.`);
    return JSON.parse(row.body) as RunRecord;
  }

  list(): RunRecord[] {
    return (this.db.prepare('SELECT body FROM runs ORDER BY rowid DESC').all() as Array<{ body: string }>).map(row => JSON.parse(row.body) as RunRecord);
  }

  events(id: string): RunEvent[] {
    this.get(id);
    return (this.db.prepare('SELECT body FROM events WHERE run_id=? ORDER BY sequence').all(id) as Array<{ body: string }>).map(row => JSON.parse(row.body) as RunEvent);
  }

  append(id: string, owner: string, version: number, event: Omit<RunEvent, 'schemaVersion' | 'runId' | 'sequence' | 'timestamp'>, status?: RunStatus): RunRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = nextRecord(this.get(id), owner, version, status);
      const entry: RunEvent = { ...event, schemaVersion: 1, runId: id, sequence: next.version, timestamp: next.updatedAt };
      this.db.prepare('INSERT INTO events (run_id, sequence, body) VALUES (?, ?, ?)').run(id, next.version, JSON.stringify(entry));
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  interrupt(id: string, expectedVersion: number, reason: string): RunRecord {
    const run = this.get(id);
    return this.append(id, run.owner, expectedVersion, {
      type: 'run.status', data: { status: 'interrupted', reason, outcome: 'unknown', reexecuted: false },
    }, 'interrupted');
  }

  close(): void { this.db.close(); }
}