import type { RunEvent, RunRecord, RunStatus, RunStore } from '../contracts.js';
import { FrameworkError } from '../errors.js';
import { nextRecord } from '../store.js';

/** Independent in-memory storage implementation for tests, not persistent recovery. */
export class MemoryRunStore implements RunStore {
  readonly capabilities = { persistent: false, continuation: false } as const;
  private runs = new Map<string, RunRecord>();
  private entries = new Map<string, RunEvent[]>();
  create(input: Omit<RunRecord, 'version' | 'status' | 'createdAt' | 'updatedAt'>): RunRecord {
    if (this.runs.has(input.id)) throw new FrameworkError('CONFLICT', `Run ${input.id} already exists.`);
    const now = new Date().toISOString();
    const run: RunRecord = { ...input, status: 'running', version: 0, createdAt: now, updatedAt: now };
    this.runs.set(run.id, run);
    this.entries.set(run.id, []);
    return structuredClone(run);
  }
  get(id: string): RunRecord {
    const run = this.runs.get(id);
    if (!run) throw new FrameworkError('NOT_FOUND', `Run ${id} was not found.`);
    return structuredClone(run);
  }
  list() { return [...this.runs.values()].reverse().map(run => structuredClone(run)); }
  events(id: string) { this.get(id); return structuredClone(this.entries.get(id)!); }
  append(id: string, owner: string, version: number, event: Omit<RunEvent, 'schemaVersion' | 'runId' | 'sequence' | 'timestamp'>, status?: RunStatus): RunRecord {
    const next = nextRecord(this.get(id), owner, version, status);
    const entry: RunEvent = JSON.parse(JSON.stringify({ ...event, schemaVersion: 1, runId: id, sequence: next.version, timestamp: next.updatedAt })) as RunEvent;
    this.entries.get(id)!.push(entry);
    this.runs.set(id, next);
    return structuredClone(next);
  }
  interrupt(id: string, expectedVersion: number, reason: string) {
    const run = this.get(id);
    return this.append(id, run.owner, expectedVersion, { type: 'run.status', data: { status: 'interrupted', reason, outcome: 'unknown', reexecuted: false } }, 'interrupted');
  }
  close() { /* Memory remains readable until the test drops this instance. */ }
}