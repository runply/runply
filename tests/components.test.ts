import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import type { JSONSchema7, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Application, AppTool, Artifact, RunComponent, Workspace } from '../src/contracts.js';
import { FrameworkError, type ErrorCode } from '../src/errors.js';
import { createMcpComponent } from '../src/mcp.js';
import { runApplication, type RunResult } from '../src/runtime.js';
import { fakeModel, modelResponse, toolResponse } from '../src/testing/model.js';
import { MemoryRunStore } from '../src/testing/store.js';

type Resource = Awaited<ReturnType<RunComponent['open']>>;
const output = { sum: 42 };
const finalResponse = () => modelResponse(JSON.stringify(output));
const blockedNetwork = vi.fn((): never => { throw new Error('Network disabled in component tests.'); });
const roots: string[] = [];
const resources: Resource[] = [];

beforeEach(() => {
  blockedNetwork.mockClear();
  vi.stubGlobal('fetch', blockedNetwork);
  vi.stubGlobal('WebSocket', blockedNetwork);
  vi.spyOn(http, 'request').mockImplementation(blockedNetwork);
  vi.spyOn(http, 'get').mockImplementation(blockedNetwork);
  vi.spyOn(https, 'request').mockImplementation(blockedNetwork);
  vi.spyOn(https, 'get').mockImplementation(blockedNetwork);
  vi.spyOn(http2, 'connect').mockImplementation(blockedNetwork);
  // Spawned stdio uses existing pipe descriptors, not Socket.connect().
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blockedNetwork);
  vi.spyOn(tls, 'connect').mockImplementation(blockedNetwork);
  vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blockedNetwork);
});

afterEach(async () => {
  try {
    await Promise.all(resources.splice(0).map(resource => resource.close()));
    expect(blockedNetwork).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function component(id: string, tools: Record<string, AppTool> = {}) {
  const close = vi.fn<Resource['close']>(async () => {});
  const resource: Resource = { tools, close };
  const open = vi.fn<RunComponent['open']>(async () => resource);
  return { id, open, close, resource };
}

function addTool() {
  const invoke = vi.fn<AppTool['invoke']>(async value => {
    const input = z.object({ a: z.number(), b: z.number() }).parse(value);
    return { sum: input.a + input.b };
  });
  const definition: AppTool = {
    description: 'Add two numbers.',
    inputSchema: z.strictObject({ a: z.number(), b: z.number() }),
    permissions: [], approval: false, sideEffect: 'none', idempotent: true, invoke,
  };
  return { definition, invoke };
}

function harness(responses: LanguageModelV4GenerateResult[] = [finalResponse()]) {
  let index = 0;
  const respond = vi.fn<Parameters<typeof fakeModel>[0]>(() => {
    const response = responses[index++];
    if (!response) throw new Error('Unexpected model call; script exhausted.');
    return response;
  });
  const finalize = vi.fn<Application<Record<string, never>, typeof output>['finalize']>(value => [
    { name: 'sum.json', mediaType: 'application/json', content: JSON.stringify(value) },
  ]);
  const application: Application<Record<string, never>, typeof output> = {
    name: 'offline-component-lifecycle', inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ sum: z.number() }), tools: {},
    messages: () => [{ role: 'user', content: 'Add 17 and 25 using the available tool, then return JSON.' }],
    finalize,
  };
  const published = new Map<string, readonly Artifact[]>();
  const publish = vi.fn<Workspace['publish']>(async (runId, artifacts) => {
    if (published.has(runId)) throw new Error('Duplicate publication.');
    published.set(runId, structuredClone(artifacts));
    return artifacts.map(artifact => ({
      name: artifact.name, path: `memory://${runId}/${artifact.name}`,
      sha256: createHash('sha256').update(artifact.content).digest('hex'), bytes: Buffer.byteLength(artifact.content),
    }));
  });
  const workspace: Workspace = {
    capabilities: { files: false, artifacts: true, execution: false, isolation: false },
    publish, close: vi.fn(async () => {}),
  };
  const store = new MemoryRunStore();
  const storeClose = vi.spyOn(store, 'close');
  return { application, model: fakeModel(respond), respond, finalize, workspace, publish, published, store, storeClose };
}
type Harness = ReturnType<typeof harness>;

function expectTerminal(h: Harness, result: RunResult<typeof output>, code?: ErrorCode) {
  const events = h.store.events(result.runId);
  expect(events.at(-1)).toMatchObject({ type: 'run.status', data: {
    status: result.status, ...(code ? { code } : {}),
  } });
  expect(events.filter(event => event.type === 'run.status')).toHaveLength(1);
  expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(h.store.get(result.runId)).toMatchObject({ status: result.status, version: events.length });
  expect(h.workspace.close).not.toHaveBeenCalled();
  expect(h.storeClose).not.toHaveBeenCalled();
  return events;
}

function expectFailure(h: Harness, result: RunResult<typeof output>, code: ErrorCode, status = 'failed') {
  expect(result.status).toBe(status);
  expect(result.error?.code).toBe(code);
  expect(result.output).toBeUndefined();
  expect(result.artifacts).toEqual([]);
  expect(h.publish).not.toHaveBeenCalled();
  return expectTerminal(h, result, code);
}

describe('run-owned components', () => {
  it('connects in order, runs discovered tools, and awaits reverse-order closure before final status', async () => {
    const h = harness([toolResponse('calc__add', { a: 17, b: 25 }, 'add-1'), finalResponse()]);
    const add = addTool();
    const first = component('calc', { calc__add: add.definition });
    const second = component('auxiliary');
    const closing = deferred<void>();
    const release = deferred<void>();
    second.close.mockImplementation(async () => { closing.resolve(); await release.promise; });
    const pending = runApplication(h.application, {}, { ...h, components: [first, second], captureContent: true });
    try {
      await closing.promise;
      const run = h.store.list()[0]!;
      expect(run.status).toBe('running');
      expect(first.close).not.toHaveBeenCalled();
      expect(h.store.events(run.id).map(event => event.type)).toEqual([
        'run.started', 'component.connecting', 'component.ready', 'component.connecting', 'component.ready',
        'model.started', 'model.completed', 'tool.started', 'tool.completed',
        'model.started', 'model.completed', 'artifact.created',
      ]);
    } finally { release.resolve(); }
    const result = await pending;
    expect(result).toMatchObject({ status: 'succeeded', output });
    expect(result.error).toBeUndefined();
    expect(first.open).toHaveBeenCalledExactlyOnceWith({ runId: result.runId, signal: expect.any(AbortSignal) });
    expect(second.open).toHaveBeenCalledExactlyOnceWith(first.open.mock.calls[0]![0]);
    expect(first.open.mock.invocationCallOrder[0]!).toBeLessThan(second.open.mock.invocationCallOrder[0]!);
    expect(second.open.mock.invocationCallOrder[0]!).toBeLessThan(h.respond.mock.invocationCallOrder[0]!);
    expect(add.invoke).toHaveBeenCalledExactlyOnceWith({ a: 17, b: 25 }, expect.objectContaining({
      runId: result.runId, toolCallId: 'add-1', input: {}, signal: first.open.mock.calls[0]![0].signal,
    }));
    expect(h.respond).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(second.close.mock.invocationCallOrder[0]!).toBeLessThan(first.close.mock.invocationCallOrder[0]!);
    const events = expectTerminal(h, result);
    expect(events.filter(event => event.type.startsWith('component.')).map(event => [event.type, event.data])).toEqual([
      ['component.connecting', { component: 'calc' }], ['component.ready', { component: 'calc', tools: ['calc__add'] }],
      ['component.connecting', { component: 'auxiliary' }], ['component.ready', { component: 'auxiliary', tools: [] }],
      ['component.closed', { component: 'auxiliary' }], ['component.closed', { component: 'calc' }],
    ]);
    expect(events.slice(-3).map(event => event.type)).toEqual(['component.closed', 'component.closed', 'run.status']);
    expect(events.find(event => event.type === 'tool.completed')).toMatchObject({
      stepId: 'add-1', parentId: 'model-1', data: { tool: 'calc__add', output },
    });
  });

  it('closes the first acquisition when the second open fails, without opening the third or calling the model', async () => {
    const h = harness();
    const first = component('first');
    const second = component('second');
    const third = component('third');
    const failure = new FrameworkError('TOOL_UNAVAILABLE', 'Second acquisition failed.');
    second.open.mockRejectedValue(failure);
    const result = await runApplication(h.application, {}, { ...h, components: [first, second, third] });
    const events = expectFailure(h, result, 'TOOL_UNAVAILABLE');
    expect(result.error).toBe(failure);
    expect(first.open).toHaveBeenCalledTimes(1);
    expect(second.open).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(third.open).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
    expect(events.slice(-3)).toMatchObject([
      { type: 'component.failed', data: { component: 'second', phase: 'open', code: 'TOOL_UNAVAILABLE' } },
      { type: 'component.closed', data: { component: 'first' } }, { type: 'run.status' },
    ]);
  });

  it.each(['application', 'component'] as const)('rejects a tool collision with an existing %s and closes every acquired connection', async source => {
    const h = harness();
    const existing = addTool();
    const incoming = addTool();
    const first = component('first', { add: existing.definition });
    const colliding = component('colliding', { add: incoming.definition });
    const unopened = component('unopened');
    if (source === 'application') h.application.tools.add = existing.definition;
    const result = await runApplication(h.application, {}, {
      ...h, components: [...(source === 'component' ? [first] : []), colliding, unopened],
    });
    const events = expectFailure(h, result, 'CONFLICT');
    expect(result.error?.message).toContain('add');
    expect(colliding.close).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(source === 'component' ? 1 : 0);
    expect(unopened.open).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
    expect(existing.invoke).not.toHaveBeenCalled();
    expect(incoming.invoke).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'component.failed', data: {
      component: 'colliding', phase: 'open', code: 'CONFLICT',
    } }));
    expect(events.filter(event => event.type === 'component.closed').map(event => event.data)).toEqual([
      { component: 'colliding' }, ...(source === 'component' ? [{ component: 'first' }] : []),
    ]);
    expect(events.filter(event => event.type === 'component.ready')).toHaveLength(source === 'component' ? 1 : 0);
  });

  it('rejects duplicate component IDs even when their tools do not collide', async () => {
    const h = harness();
    const first = component('duplicate');
    const duplicate = component('duplicate', { distinct: addTool().definition });
    const result = await runApplication(h.application, {}, { ...h, components: [first, duplicate] });
    expectFailure(h, result, 'CONFLICT');
    expect(result.error?.message).toContain('duplicate');
    expect(first.open).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(duplicate.open).not.toHaveBeenCalled();
    expect(duplicate.close).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
  });

  it.each([true, false])('revalidates tool capability after discovery (discovered tools: %s)', async discovered => {
    const h = harness();
    h.model.capabilities.tools = false;
    const add = addTool();
    const connection = component('discovery', discovered ? { add: add.definition } : {});
    expect(h.application.tools).toEqual({});
    const result = await runApplication(h.application, {}, { ...h, components: [connection] });
    expect(connection.open).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(add.invoke).not.toHaveBeenCalled();
    if (discovered) {
      const events = expectFailure(h, result, 'CAPABILITY_MISMATCH');
      expect(h.respond).not.toHaveBeenCalled();
      expect(events.map(event => event.type)).toEqual([
        'run.started', 'component.connecting', 'component.ready', 'component.closed', 'run.status',
      ]);
    } else {
      expect(result.status).toBe('succeeded');
      expect(h.respond).toHaveBeenCalledTimes(1);
      expectTerminal(h, result);
    }
    expect(h.application.tools).toEqual({});
  });

  it.each(['abort', 'timeout'] as const)('handles %s during open, closes a late resource once, and writes no post-terminal events', async kind => {
    if (kind === 'timeout') vi.useFakeTimers();
    const h = harness();
    const append = vi.spyOn(h.store, 'append');
    const first = component('first');
    const late = component('late', { add: addTool().definition });
    const opening = deferred<Resource>();
    const entered = deferred<Parameters<RunComponent['open']>[0]>();
    const closed = deferred<void>();
    late.open.mockImplementation(context => { entered.resolve(context); return opening.promise; });
    late.close.mockImplementation(async () => { closed.resolve(); });
    const controller = new AbortController();
    const pending = runApplication(h.application, {}, {
      ...h, components: [first, late], signal: controller.signal, ...(kind === 'timeout' ? { timeoutMs: 50 } : {}),
    });
    const context = await entered.promise;
    expect(context.signal.aborted).toBe(false);
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(50);
    else controller.abort(new Error('Cancel while opening.'));
    const result = await pending;
    const code = kind === 'timeout' ? 'TIMED_OUT' : 'CANCELLED';
    const events = expectFailure(h, result, code, kind === 'timeout' ? 'failed' : 'cancelled');
    const record = h.store.get(result.runId);
    const appendCount = append.mock.calls.length;
    expect(context).toMatchObject({ runId: result.runId });
    expect(context.signal.aborted).toBe(true);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(late.close).not.toHaveBeenCalled();
    expect(events.slice(-3)).toMatchObject([
      { type: 'component.failed', data: { component: 'late', phase: 'open' } },
      { type: 'component.closed', data: { component: 'first' } }, { type: 'run.status' },
    ]);
    opening.resolve(late.resource);
    await closed.promise;
    vi.useRealTimers();
    await nextTurn();
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.store.events(result.runId)).toEqual(events);
    expect(h.store.get(result.runId)).toEqual(record);
    expect(append).toHaveBeenCalledTimes(appendCount);
  });

  it('reports a throwing close as a failed run, keeps published artifacts, and still closes the other component', async () => {
    const h = harness();
    const first = component('first');
    const broken = component('broken');
    const cause = new Error('Cleanup failed.');
    broken.close.mockRejectedValue(cause);
    const result = await runApplication(h.application, {}, { ...h, components: [first, broken] });
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'TOOL_ERROR', message: expect.stringMatching(/cleanup/i) });
    expect(result.error?.cause).toBeInstanceOf(AggregateError);
    expect((result.error?.cause as AggregateError).errors).toContain(cause);
    expect(result.output).toBeUndefined();
    expect(h.publish).toHaveBeenCalledTimes(1);
    const artifact = { name: 'sum.json', mediaType: 'application/json', content: JSON.stringify(output) };
    expect(h.published.get(result.runId)).toEqual([artifact]);
    expect(result.artifacts).toEqual([{
      name: artifact.name, path: `memory://${result.runId}/${artifact.name}`,
      sha256: createHash('sha256').update(artifact.content).digest('hex'), bytes: Buffer.byteLength(artifact.content),
    }]);
    expect(broken.close).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    const events = expectTerminal(h, result, 'TOOL_ERROR');
    expect(events.slice(-4)).toMatchObject([
      { type: 'artifact.created', data: result.artifacts[0] },
      { type: 'component.failed', data: { component: 'broken', phase: 'close' } },
      { type: 'component.closed', data: { component: 'first' } },
      { type: 'run.status', data: { status: 'failed', code: 'TOOL_ERROR', artifactPublication: 'settled' } },
    ]);
    expect(events.filter(event => event.type === 'component.closed')).toHaveLength(1);
  });

  it.each([
    ['model', 'MODEL_ERROR'], ['output', 'INVALID_OUTPUT'], ['tool', 'TOOL_ERROR'],
    ['finalize', 'INVALID_OUTPUT'], ['permission', 'PERMISSION_DENIED'],
  ] as const)('closes components on ordinary %s failure without retrying', async (phase, code) => {
    const h = harness(phase === 'tool' || phase === 'permission'
      ? [toolResponse('add', { a: 17, b: 25 }, 'failed-1'), finalResponse()] : [finalResponse()]);
    const add = addTool();
    const connection = component('calc', { add: add.definition });
    if (phase === 'model') h.respond.mockRejectedValue(new Error('Model failed.'));
    if (phase === 'output') h.respond.mockReturnValue(modelResponse('{invalid'));
    if (phase === 'tool') add.invoke.mockRejectedValue(new Error('Tool failed.'));
    if (phase === 'finalize') h.finalize.mockImplementation(() => { throw new FrameworkError('INVALID_OUTPUT', 'Cannot render.'); });
    if (phase === 'permission') add.definition.permissions = ['calculator.use'];
    const result = await runApplication(h.application, {}, { ...h, components: [connection] });
    const events = expectFailure(h, result, code);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(add.invoke).toHaveBeenCalledTimes(phase === 'tool' ? 1 : 0);
    expect(events.slice(-2)).toMatchObject([
      { type: 'component.closed', data: { component: 'calc' } }, { type: 'run.status' },
    ]);
  });
});

describe('discovered tool schemas at the LanguageModelV4 boundary', () => {
  const originalSchema: JSONSchema7 = {
    type: 'object', properties: { a: { type: 'number' }, b: { type: 'number', default: 10 } },
    required: ['a', 'b'], additionalProperties: false,
    'x-test-schema': { retained: true },
  };

  it.each([
    { label: 'valid', input: { a: 17, b: 25 }, valid: true },
    { label: 'Zod-only refinement', input: { a: -1, b: 43 }, valid: false },
    { label: 'missing required value despite JSON default', input: { a: 32 }, valid: false },
    { label: 'wrong type', input: { a: '17', b: 25 }, valid: false },
    { label: 'extra property', input: { a: 17, b: 25, extra: true }, valid: false },
  ])('preserves original JSON schema in actual model options with $label input', async ({ input, valid }) => {
    const h = harness([toolResponse('calc__add', input, 'schema-1'), finalResponse()]);
    const add = addTool();
    add.definition.inputJsonSchema = structuredClone(originalSchema);
    // The provider-facing schema deliberately has no minimum: local Zod must still run.
    add.definition.inputSchema = z.strictObject({ a: z.number().nonnegative(), b: z.number() });
    const connection = component('calc', { calc__add: add.definition });
    const result = await runApplication(h.application, {}, { ...h, components: [connection] });
    expect(h.model.model.specificationVersion).toBe('v4');
    expect(h.respond.mock.calls[0]![0].tools).toEqual([{
      type: 'function', name: 'calc__add', description: 'Add two numbers.', inputSchema: originalSchema,
    }]);
    expect(add.definition.inputJsonSchema).toEqual(originalSchema);
    expect(connection.close).toHaveBeenCalledTimes(1);
    if (valid) {
      expect(result).toMatchObject({ status: 'succeeded', output });
      expect(add.invoke).toHaveBeenCalledExactlyOnceWith(input, expect.any(Object));
      expect(h.respond).toHaveBeenCalledTimes(2);
      expect(h.respond.mock.calls[1]![0].tools).toEqual(h.respond.mock.calls[0]![0].tools);
      expectTerminal(h, result);
    } else {
      const events = expectFailure(h, result, 'INVALID_INPUT');
      expect(add.invoke).not.toHaveBeenCalled();
      expect(h.respond).toHaveBeenCalledTimes(1);
      expect(events.some(event => event.type === 'tool.started')).toBe(false);
    }
  });

  it('runs the real default-mode stdio add tool through MCP discovery, generation, and owned closure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runply-components-'));
    roots.push(root);
    const log = join(root, 'events.jsonl');
    type Entry = { event: string; pid: number; name?: string; cursor?: string; input?: unknown; signalAborted?: boolean };
    const entries = (): Entry[] => existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry) : [];
    vi.stubEnv('MCP_FIXTURE_MODE', undefined);
    const component = createMcpComponent('calc', {
      transport: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))],
      env: { MCP_FIXTURE_LOG: log }, permissions: ['calculator.use'],
    });
    const open = component.open.bind(component);
    let connection: Resource | undefined;
    vi.spyOn(component, 'open').mockImplementation(async context => {
      connection = await open(context);
      resources.push(connection);
      vi.spyOn(connection, 'close');
      return connection;
    });
    const h = harness([toolResponse('calc__add', { a: 17, b: 25 }, 'mcp-add-1'), finalResponse()]);
    const envelope = { content: [{ type: 'text', text: '42' }], structuredContent: { sum: 42 }, _meta: { fixture: true } };
    const result = await runApplication(h.application, {}, {
      ...h, components: [component], permissions: ['calculator.use'], captureContent: true,
    });
    expect(result).toMatchObject({ status: 'succeeded', output });
    expect(result.error).toBeUndefined();
    expect(component.open).toHaveBeenCalledTimes(1);
    expect(connection).toBeDefined();
    expect(connection!.close).toHaveBeenCalledTimes(1);
    const names = ['calc__add', 'calc__echo', 'calc__fail', 'calc__slow', 'calc__bad-output', 'calc__modern'];
    expect(Object.keys(connection!.tools)).toEqual(names);
    expect(connection!.tools.calc__add).toMatchObject({
      inputJsonSchema: originalSchema, permissions: ['calculator.use'], approval: false,
      sideEffect: 'external', idempotent: false,
    });
    expect(connection!.tools.calc__add!.inputSchema.safeParse({ a: 17, b: 25 }).success).toBe(true);
    expect(connection!.tools.calc__add!.inputSchema.safeParse({ a: '17', b: 25 }).success).toBe(false);
    expect(connection!.tools.calc__add!.inputSchema.safeParse({ a: 17 }).success).toBe(false);
    expect(h.respond).toHaveBeenCalledTimes(2);
    for (const [call] of h.respond.mock.calls) {
      expect(call.tools?.map(tool => tool.name)).toEqual(names);
      expect(call.tools?.find(tool => tool.name === 'calc__add')).toEqual({
        type: 'function', name: 'calc__add', description: 'Add two numbers.', inputSchema: originalSchema,
      });
    }
    expect(h.respond.mock.calls[0]![0].prompt.some(message => message.role === 'tool')).toBe(false);
    const secondPrompt = h.respond.mock.calls[1]![0].prompt;
    expect(secondPrompt).toContainEqual(expect.objectContaining({ role: 'assistant', content: [expect.objectContaining({
      type: 'tool-call', toolName: 'calc__add', toolCallId: 'mcp-add-1', input: { a: 17, b: 25 },
    })] }));
    expect(secondPrompt).toContainEqual(expect.objectContaining({ role: 'tool', content: [expect.objectContaining({
      type: 'tool-result', toolName: 'calc__add', toolCallId: 'mcp-add-1', output: { type: 'json', value: envelope },
    })] }));
    const events = expectTerminal(h, result);
    expect(events.map(event => event.type)).toEqual([
      'run.started', 'component.connecting', 'component.ready', 'model.started', 'model.completed',
      'tool.started', 'tool.completed', 'model.started', 'model.completed', 'artifact.created', 'component.closed', 'run.status',
    ]);
    expect(events.find(event => event.type === 'component.ready')?.data).toEqual({ component: 'calc', tools: names });
    expect(events.find(event => event.type === 'tool.started')).toMatchObject({ data: {
      tool: 'calc__add', input: { a: 17, b: 25 }, sideEffect: 'external', idempotent: false,
    } });
    expect(events.find(event => event.type === 'tool.completed')).toMatchObject({
      stepId: 'mcp-add-1', parentId: 'model-1', data: { tool: 'calc__add', output: envelope },
    });
    const logged = entries();
    expect(logged.filter(entry => entry.event === 'tools/list').map(entry => entry.cursor)).toEqual([undefined, 'page-two']);
    expect(logged.filter(entry => entry.event === 'tools/call')).toMatchObject([
      { name: 'add', input: { a: 17, b: 25 }, signalAborted: false },
    ]);
    expect(logged.filter(entry => entry.event === 'tools/call')).toHaveLength(1);
    expect(logged.some(entry => entry.event === 'exit')).toBe(true);
    const pid = logged.find(entry => entry.event === 'started')?.pid;
    expect(pid).toBeTypeOf('number');
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});