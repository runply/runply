import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApplication, LocalWorkspace } from '__PACKAGE__';
import { MemoryRunStore } from '__PACKAGE__/testing';
import config from './app.js';

test('reads documents, checks requirements, and publishes verified artifacts offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-app-'));
  const store = new MemoryRunStore();
  const workspace = new LocalWorkspace(root);
  try {
    const result = await runApplication(config.application, config.input, { ...config, store, workspace });
    assert.equal(result.status, 'succeeded', result.error?.message);
    assert.deepEqual(result.output?.checks.map(check => check.found), [true, false, true]);
    assert.equal(result.artifacts.length, 2);
    assert.match(await readFile(join(root, result.runId, 'report.md'), 'utf8'), /data retention[\s\S]*Not found/);
    assert.equal(store.events(result.runId).filter(event => event.type === 'tool.completed').length, 2);
  } finally {
    store.close();
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});