import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRunStore } from '../src/store.js';
import { MemoryRunStore } from '../src/testing/store.js';
import type { RunStore } from '../src/contracts.js';

const roots: string[] = [];
const stores: RunStore[] = [];
function path() { const root = mkdtempSync(join(tmpdir(), 'agent-store-')); roots.push(root); return join(root, 'runs.sqlite'); }
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** Shared contract tests: new store adapters can supply another factory here. */
describe.each([
  ['memory', () => new MemoryRunStore()],
  ['sqlite', () => new SQLiteRunStore(path())],
] as const)('%s run store conformance', (_name, factory) => {
  function make() { const store = factory(); stores.push(store); store.create({ id: 'run', owner: 'owner', application: 'test', model: 'fake' }); return store; }
  it('records ordered events and status atomically', () => {
    const store = make();
    const run = store.append('run', 'owner', 0, { type: 'run.started', data: {} });
    store.append('run', 'owner', run.version, { type: 'run.status', data: { status: 'succeeded' } }, 'succeeded');
    expect(store.events('run').map(event => [event.schemaVersion, event.sequence])).toEqual([[1, 1], [1, 2]]);
    expect(store.get('run')).toMatchObject({ status: 'succeeded', version: 2 });
  });
  it('rejects stale updates and another owner without adding an event', () => {
    const store = make();
    store.append('run', 'owner', 0, { type: 'run.started', data: {} });
    expect(() => store.append('run', 'owner', 0, { type: 'run.status', data: {} })).toThrow(/newer version/);
    expect(() => store.append('run', 'other', 1, { type: 'run.status', data: {} })).toThrow(/another owner/);
    expect(store.events('run')).toHaveLength(1);
  });
  it('does not append after a terminal state', () => {
    const store = make();
    store.append('run', 'owner', 0, { type: 'run.status', data: {} }, 'cancelled');
    expect(() => store.append('run', 'owner', 1, { type: 'state.changed', data: {} })).toThrow(/terminal/);
  });
  it('isolates run identity and returns detached records', () => {
    const store = make();
    store.create({ id: 'other', owner: 'owner', application: 'test', model: 'fake' });
    store.get('run').status = 'succeeded';
    store.append('run', 'owner', 0, { type: 'state.changed', data: { value: 7 } });
    store.events('run')[0]!.data = 'changed';
    expect(store.get('run').status).toBe('running');
    expect(store.events('run')[0]!.data).toEqual({ value: 7 });
    expect(store.events('other')).toEqual([]);
    expect(store.list()).toHaveLength(2);
  });
  it('rejects duplicate and missing run IDs', () => {
    const store = make();
    expect(() => store.create({ id: 'run', owner: 'owner', application: 'test', model: 'fake' })).toThrow(/already exists/);
    expect(() => store.events('missing')).toThrow(/not found/);
  });
  it('marks interruption explicitly without claiming resume', () => {
    const store = make();
    store.interrupt('run', 0, 'process exited');
    expect(store.get('run').status).toBe('interrupted');
    expect(store.events('run')[0]!.data).toMatchObject({ outcome: 'unknown', reexecuted: false });
    expect(store.capabilities.continuation).toBe(false);
  });
  it('rolls back an unserializable event', () => {
    const store = make();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => store.append('run', 'owner', 0, { type: 'state.changed', data: cyclic })).toThrow();
    expect(store.get('run').version).toBe(0);
    expect(store.events('run')).toEqual([]);
  });
});

it('SQLite survives reopen and rejects concurrent stale writes from another connection', () => {
  const database = path();
  const first = new SQLiteRunStore(database);
  first.create({ id: 'durable', owner: 'owner', application: 'test', model: 'fake' });
  const second = new SQLiteRunStore(database); stores.push(second);
  const oldVersion = second.get('durable').version;
  first.append('durable', 'owner', 0, { type: 'run.started', data: {} });
  first.close();
  expect(second.events('durable')).toHaveLength(1);
  expect(() => second.append('durable', 'owner', oldVersion, { type: 'run.status', data: {} })).toThrow(/newer version/);
});

it('SQLite read-only inspection cannot write run state', () => {
  const database = path();
  const writer = new SQLiteRunStore(database);
  writer.create({ id: 'run', owner: 'owner', application: 'test', model: 'fake' }); writer.close();
  const reader = new SQLiteRunStore(database, { readOnly: true }); stores.push(reader);
  expect(reader.get('run').version).toBe(0);
  expect(() => reader.append('run', 'owner', 0, { type: 'run.status', data: {} })).toThrow(/readonly/i);
  expect(reader.get('run').version).toBe(0);
});

it('refuses newer schemas instead of downgrading them', () => {
  const database = path();
  const db = new DatabaseSync(database); db.exec('PRAGMA user_version=2'); db.close();
  expect(() => new SQLiteRunStore(database)).toThrow(/schema 2/);
  const reader = new DatabaseSync(database); expect(reader.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 }); reader.close();
});