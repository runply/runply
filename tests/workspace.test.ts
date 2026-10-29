import { it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { LocalWorkspace } from '../src/workspace.js';

const roots: string[] = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'agent-artifacts-')); roots.push(root); return new LocalWorkspace(root); }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('publishes bytes with independently verified hashes', async () => {
  const ws = await workspace();
  const entries = await ws.publish('run', [{ name: 'report.md', mediaType: 'text/markdown', content: 'Résumé\n' }]);
  const bytes = await readFile(entries[0]!.path);
  expect(entries[0]!.bytes).toBe(bytes.length);
  expect(entries[0]!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(ws.capabilities.isolation).toBe(false);
  expect(ws.capabilities.execution).toBe(false);
  await ws.close();
});

it.each(['../escape', '/absolute', '.', '..', ''])('rejects invalid artifact name %j before writing anything', async name => {
  const ws = await workspace();
  await expect(ws.publish('run', [{ name, mediaType: 'text/plain', content: 'value' }])).rejects.toThrow(/filenames/);
  expect(await readdir(ws.root)).toEqual([]);
});

it('rejects duplicate names before publishing', async () => {
  const ws = await workspace();
  const artifact = { name: 'same', mediaType: 'text/plain', content: 'test' };
  await expect(ws.publish('run', [artifact, artifact])).rejects.toThrow(/distinct/);
  expect(await readdir(ws.root)).toEqual([]);
});

it('never overwrites an existing run, including an empty artifact set', async () => {
  const ws = await workspace();
  await ws.publish('empty', []);
  await expect(ws.publish('empty', [])).rejects.toThrow(/already exist/);
  await ws.publish('run', [{ name: 'result', mediaType: 'text/plain', content: 'first' }]);
  await expect(ws.publish('run', [{ name: 'result', mediaType: 'text/plain', content: 'second' }])).rejects.toThrow(/already exist/);
  expect(await readFile(join(ws.root, 'run', 'result'), 'utf8')).toBe('first');
});

it('allows one winner for concurrent publication to the same run', async () => {
  const ws = await workspace();
  const results = await Promise.allSettled([ws.publish('run', []), ws.publish('run', [])]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await readdir(ws.root)).toEqual(['run']);
});