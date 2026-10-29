import { it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Application, Workspace } from '../src/contracts.js';
import { runApplication } from '../src/runtime.js';
import { fakeModel, modelResponse } from '../src/testing/model.js';
import { MemoryRunStore } from '../src/testing/store.js';

function setup() {
  const respond = vi.fn(() => modelResponse('{}'));
  const model = fakeModel(respond);
  const store = new MemoryRunStore();
  const publish = vi.fn<Workspace['publish']>(async () => []);
  const workspace: Workspace = { capabilities: { artifacts: true, files: false, execution: false, isolation: false }, publish, close: async () => {} };
  const app: Application = { name: 'finalize', inputSchema: z.object({}), outputSchema: z.object({}), tools: {}, messages: () => [{ role: 'user', content: 'JSON' }], finalize: () => [] };
  return { app, model, respond, store, workspace, publish };
}

it('does not confuse model capabilities with implemented harness capabilities', async () => {
  for (const capability of ['streaming', 'structuredOutput'] as const) {
    const h = setup(); h.model.capabilities[capability] = true; h.app.requirements = { [capability]: true };
    const result = await runApplication(h.app, {}, h);
    expect(result.error?.code).toBe('CAPABILITY_MISMATCH');
    expect(h.respond).not.toHaveBeenCalled();
  }
});

it('rejects option-dropping adapter schemas before dispatch', async () => {
  const h = setup();
  h.model.providerOptionsSchema = z.object({ vendor: z.object({}) });
  const result = await runApplication(h.app, {}, { ...h, providerOptions: { vendor: { ignoredSetting: true } } });
  expect(result.error?.code).toBe('UNSUPPORTED_OPTIONS');
  expect(result.error?.message).toContain('vendor.ignoredSetting');
  expect(h.respond).not.toHaveBeenCalled();
});

it('records a controlled failure if application message construction throws', async () => {
  const h = setup(); h.app.messages = () => { throw new Error('bad application messages'); };
  const result = await runApplication(h.app, {}, h);
  expect(result.status).toBe('failed');
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.store.events(result.runId).at(-1)!.type).toBe('run.status');
});

it('does not publish artifacts when finalization throws', async () => {
  const h = setup(); h.app.finalize = () => { throw new Error('render failed'); };
  const result = await runApplication(h.app, {}, h);
  expect(result.status).toBe('failed'); expect(h.publish).not.toHaveBeenCalled();
});

it('times out non-cooperative finalization without publishing', async () => {
  const h = setup(); h.app.finalize = () => new Promise(() => {});
  const result = await runApplication(h.app, {}, { ...h, timeoutMs: 10 });
  expect(result.status).toBe('failed'); expect(result.error?.code).toBe('TIMED_OUT');
  expect(h.publish).not.toHaveBeenCalled();
});

it('marks an unfinished artifact publication uncertain instead of hanging', async () => {
  const h = setup(); h.publish.mockImplementation(() => new Promise(() => {}));
  const result = await runApplication(h.app, {}, { ...h, timeoutMs: 10 });
  expect(result.status).toBe('interrupted'); expect(result.error?.code).toBe('TIMED_OUT');
  expect(h.store.events(result.runId).at(-1)!.data).toMatchObject({ artifactPublication: 'unknown' });
});

it('records published artifacts even if cancellation occurs while events are being emitted', async () => {
  const h = setup(); const cancel = new AbortController();
  h.publish.mockResolvedValue([{ name: 'report', path: 'memory:report', sha256: 'fixture', bytes: 1 }]);
  const append = h.store.append.bind(h.store);
  vi.spyOn(h.store, 'append').mockImplementation((...args) => {
    const run = append(...args);
    if (args[3].type === 'artifact.created') cancel.abort();
    return run;
  });
  const result = await runApplication(h.app, {}, { ...h, signal: cancel.signal });
  expect(result.status).toBe('cancelled');
  expect(result.artifacts).toHaveLength(1);
  expect(h.store.events(result.runId).filter(event => event.type === 'artifact.created')).toHaveLength(1);
});