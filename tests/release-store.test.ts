import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseStore } from '../src/release-store.js';
import type { ReleasePayload, ReleaseRecord } from '../src/release-types.js';

const roots: string[] = [];
const stores: ReleaseStore[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), 'runply-release-store-'));
  roots.push(path);
  return path;
}
function open(path: string, readOnly = false) {
  const store = new ReleaseStore(path, readOnly);
  stores.push(store);
  return store;
}
function release(id: string, environment = 'review/eu-west', projectId = 'fixture-project'): ReleaseRecord {
  const payload: ReleasePayload = {
    schemaVersion: 1, project: 'fixture', projectId, environment, entry: 'src/app.ts', hostEntry: 'src/release-host.ts',
    bindings: {
      target: 'local-process', model: 'custom-model', state: { path: '/synthetic/state.sqlite' },
      artifacts: { path: '/synthetic/artifacts' }, variables: {}, secrets: {}, requirements: {},
    },
    node: { executable: process.execPath, version: process.version, platform: process.platform, arch: process.arch },
    packages: [], files: [], links: [],
  };
  return { id, createdAt: '2026-10-27T00:00:00.000Z', payload };
}
const empty = { revision: 0, releaseId: null, paused: false };
afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('ReleaseStore', () => {
  it('refuses a newer control schema without downgrading it', () => {
    const path = root(); const db = new DatabaseSync(join(path, 'releases.sqlite'));
    db.exec('PRAGMA user_version=2'); db.close();
    expect(() => new ReleaseStore(path)).toThrow(/schema 2/);
    const check = new DatabaseSync(join(path, 'releases.sqlite'), { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 }); check.close();
  });
  it.each([false, true])('read-only inspection creates nothing (root already exists: %s)', existing => {
    const parent = root();
    const path = existing ? parent : join(parent, 'missing/nested');
    const before = readdirSync(parent);
    const reader = open(path, true);
    expect(reader.active('project:review')).toEqual(empty);
    expect(() => reader.release('missing')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => reader.activate('project:review', 0, release('new'))).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    expect(() => reader.pause('project:review')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(readdirSync(parent)).toEqual(before);
    expect(existsSync(join(path, 'releases.sqlite'))).toBe(false);
    if (!existing) expect(existsSync(join(parent, 'missing'))).toBe(false);
  });

  it('enforces optimistic revisions across two connections without storing rejected releases', () => {
    const path = root();
    const first = open(path);
    const second = open(path);
    const base = second.active('project:review');
    expect(base).toEqual(empty);
    const original = release('original');
    expect(first.activate('project:review', 0, original)).toEqual({ revision: 1, releaseId: 'original', paused: false });
    expect(second.release('original')).toEqual(original);
    expect(() => second.activate('project:review', base.revision, release('stale'))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => first.release('stale')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(second.active('project:review')).toEqual({ revision: 1, releaseId: 'original', paused: false });
    expect(second.activate('project:review', 1, release('replacement'))).toEqual({ revision: 2, releaseId: 'replacement', paused: false });
    expect(first.active('project:review')).toEqual({ revision: 2, releaseId: 'replacement', paused: false });
    expect(() => first.activate('project:review', 1, release('also-stale'))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(first.release('original')).toEqual(original);
  });

  it('pause gates the environment and preserves the old release; repeated pause is idempotent', () => {
    const store = open(root());
    const original = release('original');
    store.activate('project:review', 0, original);
    const paused = { revision: 2, releaseId: 'original', paused: true };
    expect(store.pause('project:review')).toEqual(paused);
    expect(store.active('project:review')).toEqual(paused);
    expect(store.release('original')).toEqual(original);
    expect(store.pause('project:review')).toEqual(paused);
    expect(store.release('original')).toEqual(original);
  });

  it('rejects an activation planned before another connection paused the environment', () => {
    const path = root();
    const deployer = open(path);
    const operator = open(path);
    const original = release('original');
    deployer.activate('project:review', 0, original);
    const planned = deployer.active('project:review');
    operator.pause('project:review');
    expect(() => deployer.activate('project:review', planned.revision, release('stale-after-pause'))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(deployer.active('project:review')).toEqual({ revision: 2, releaseId: 'original', paused: true });
    expect(() => operator.release('stale-after-pause')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(operator.release('original')).toEqual(original);
    expect(deployer.activate('project:review', 2, release('fresh'))).toEqual({ revision: 3, releaseId: 'fresh', paused: false });
    expect(operator.active('project:review')).toEqual({ revision: 3, releaseId: 'fresh', paused: false });
  });

  it('isolates revisions and pause state between environments and projects', () => {
    const store = open(root());
    const scopes = ['project-a:review/eu-west', 'project-a:customer-demo.42', 'project-b:review/eu-west'];
    scopes.forEach((scope, index) => store.activate(scope, 0, release(`r${index}`, index === 1 ? 'customer-demo.42' : 'review/eu-west', index === 2 ? 'project-b' : 'project-a')));
    store.pause(scopes[0]!);
    store.activate(scopes[1]!, 1, release('demo-new', 'customer-demo.42', 'project-a'));
    expect(store.active(scopes[0]!)).toEqual({ revision: 2, releaseId: 'r0', paused: true });
    expect(store.active(scopes[1]!)).toEqual({ revision: 2, releaseId: 'demo-new', paused: false });
    expect(store.active(scopes[2]!)).toEqual({ revision: 1, releaseId: 'r2', paused: false });
    expect(store.active('project-c:review/eu-west')).toEqual(empty);
    expect(store.release('r0').payload.projectId).toBe('project-a');
    expect(store.release('r2').payload.projectId).toBe('project-b');
  });

  it('rolls back a release insertion when the activation update fails', () => {
    const path = root();
    const store = open(path);
    store.activate('project:review', 0, release('original'));
    store.pause('project:review');
    const observer = open(path);
    const db = new DatabaseSync(join(path, 'releases.sqlite'));
    try {
      db.exec(`CREATE TRIGGER reject_activation BEFORE UPDATE ON activations
        WHEN NEW.release_id = 'rejected'
        BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END;`);
      expect(() => store.activate('project:review', 2, release('rejected'))).toThrow(/injected activation failure/);
      expect(observer.active('project:review')).toEqual({ revision: 2, releaseId: 'original', paused: true });
      expect(() => observer.release('rejected')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(observer.release('original')).toEqual(release('original'));
      expect(store.activate('project:review', 2, release('recovered'))).toEqual({ revision: 3, releaseId: 'recovered', paused: false });
      expect(observer.release('recovered')).toEqual(release('recovered'));
    } finally { db.close(); }
  });

  it('rolls back serialization failure and leaves the connection usable', () => {
    const store = open(root());
    const broken = Object.assign(release('broken'), { toJSON(): never { throw new Error('injected serialization failure'); } });
    expect(() => store.activate('project:review', 0, broken)).toThrow(/injected serialization failure/);
    expect(store.active('project:review')).toEqual(empty);
    expect(() => store.release('broken')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(store.activate('project:review', 0, release('valid'))).toEqual({ revision: 1, releaseId: 'valid', paused: false });
  });

  it('rolls back a failed pause without creating a scope or blocking later activation', () => {
    const store = open(root());
    expect(() => store.pause('missing')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(store.active('missing')).toEqual(empty);
    expect(store.activate('missing', 0, release('later'))).toEqual({ revision: 1, releaseId: 'later', paused: false });
  });

  it('reads durable release and pause state through a new read-only connection and refuses writes', () => {
    const path = root();
    const writer = new ReleaseStore(path);
    const original = release('durable');
    try {
      writer.activate('project:review', 0, original);
      writer.pause('project:review');
    } finally { writer.close(); }
    const reader = open(path, true);
    expect(reader.active('project:review')).toEqual({ revision: 2, releaseId: 'durable', paused: true });
    expect(reader.release('durable')).toEqual(original);
    expect(() => reader.activate('project:review', 2, release('forbidden'))).toThrow(/readonly/i);
    expect(reader.active('project:review')).toEqual({ revision: 2, releaseId: 'durable', paused: true });
    expect(() => reader.release('forbidden')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const detached = reader.release('durable');
    detached.payload.bindings.variables.MUTATED = 'yes';
    expect(reader.release('durable')).toEqual(original);
  });
});