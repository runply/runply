import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpComponent, mcpConnectionSchema, openMcpConnection, type McpConnectionOptions } from '../src/mcp.js';
import { FrameworkError } from '../src/errors.js';
import type { ToolContext } from '../src/contracts.js';

const fixturePath = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const roots: string[] = [];
const connections: Array<{ close(): Promise<void> }> = [];
type Entry = { event: string; pid: number; name?: string; cursor?: string; cwd?: string; inherited?: string; override?: string; signalAborted?: boolean };

function fixture(mode = 'normal', overrides: Partial<Extract<McpConnectionOptions, { transport: 'stdio' }>> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runply-mcp-')));
  roots.push(root);
  const log = join(root, 'events.jsonl');
  const options: McpConnectionOptions = { transport: 'stdio', command: process.execPath, args: [fixturePath], cwd: root,
    env: { MCP_FIXTURE_LOG: log, MCP_FIXTURE_MODE: mode }, ...overrides };
  const events = (): Entry[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry) : [];
  return { root, options, events };
}

function context(signal = new AbortController().signal): ToolContext {
  return { runId: 'test-run', toolCallId: 'test-call', signal, input: {}, state: { get: () => undefined, set: () => {} } };
}

async function open(options: McpConnectionOptions, signal = new AbortController().signal) {
  const connection = await openMcpConnection('calc', options, { signal });
  connections.push(connection);
  return connection;
}

function assertExited(events: Entry[]) {
  const pid = events.find(entry => entry.event === 'started')?.pid;
  expect(pid).toBeTypeOf('number');
  expect(() => process.kill(pid!, 0)).toThrow();
  expect(events.some(entry => entry.event === 'exit')).toBe(true);
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('MCP options', () => {
  it('applies explicit local policy defaults and accepts arbitrary HTTP hosts', () => {
    expect(mcpConnectionSchema.parse({ transport: 'stdio', command: 'anything' })).toEqual({
      transport: 'stdio', command: 'anything', permissions: [], approval: false, sideEffect: 'external', idempotent: false,
    });
    for (const url of ['https://any-vendor.example/mcp', 'http://localhost:3001/mcp']) {
      expect(mcpConnectionSchema.safeParse({ transport: 'http', url }).success).toBe(true);
    }
  });

  it.each([
    { transport: 'http', url: 'file:///tmp/mcp' },
    { transport: 'http', url: 'ftp://example.com' },
    { transport: 'http', url: 'httpx://example.com' },
    { transport: 'http', url: 'https://' },
    { transport: 'http', url: 'https://example.com', headers: { Authorization: 'literal secret' } },
    { transport: 'http', url: 'https://example.com', headers: { Authorization: { env: 'KEY', value: 'secret' } } },
    { transport: 'stdio', command: '' }, { transport: 'stdio', command: 'node', cwd: 'relative' },
    { transport: 'stdio', command: 'node', timeoutMs: 0 },
    { transport: 'stdio', command: 'node', timeoutMs: 1.5 },
    { transport: 'stdio', command: 'node', args: ['\0'] },
    { transport: 'stdio', command: 'node', url: 'https://example.com' },
  ])('rejects invalid configuration %# without opening anything', options => {
    expect(mcpConnectionSchema.safeParse(options).success).toBe(false);
    expect(() => createMcpComponent('invalid', options as McpConnectionOptions)).toThrow(FrameworkError);
  });

  it('does no I/O when constructing a component', () => {
    const f = fixture();
    const start = vi.spyOn(StdioClientTransport.prototype, 'start');
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    expect(createMcpComponent('calc', f.options).id).toBe('calc');
    createMcpComponent('web', { transport: 'http', url: 'https://example.invalid', headers: { Authorization: { env: 'MCP_MISSING' } } });
    expect(start).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.events()).toEqual([]);
  });

  it('resolves missing header references before starting HTTP or making a request', async () => {
    vi.stubEnv('MCP_TEST_MISSING_HEADER', undefined);
    const start = vi.spyOn(StreamableHTTPClientTransport.prototype, 'start');
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    await expect(open({ transport: 'http', url: 'https://example.invalid', headers: { Authorization: { env: 'MCP_TEST_MISSING_HEADER' } } }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('MCP_TEST_MISSING_HEADER') });
    expect(start).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses env-backed HTTP headers without retrying or falling back to stdio on failure', async () => {
    vi.stubEnv('MCP_TEST_HTTP_AUTH', 'Bearer test-only-value');
    const stdio = vi.spyOn(StdioClientTransport.prototype, 'start');
    const httpClose = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-only-value');
      expect(init?.method).toBe('POST');
      throw new Error('Synthetic HTTP failure; no network request was made');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(open({ transport: 'http', url: 'https://example.invalid/mcp',
      headers: { Authorization: { env: 'MCP_TEST_HTTP_AUTH' } } })).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' });
    // The SDK sends a cancellation notification on shutdown, not a retried initialize.
    expect(fetch.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { method: string }).method))
      .toEqual(['initialize', 'notifications/cancelled']);
    expect(stdio).not.toHaveBeenCalled();
    expect(httpClose).toHaveBeenCalledTimes(1);
  });
});

describe('real stdio MCP', () => {
  it('discovers all pages without invoking tools, then invokes the sum through a component', async () => {
    const f = fixture();
    const connection = await createMcpComponent('calc', f.options).open({ runId: 'run', signal: new AbortController().signal });
    connections.push(connection);
    expect(Object.keys(connection.tools)).toEqual(['calc__add', 'calc__echo', 'calc__fail', 'calc__slow', 'calc__bad-output', 'calc__modern']);
    expect(f.events().filter(entry => entry.event === 'tools/list').map(entry => entry.cursor)).toEqual([undefined, 'page-two']);
    expect(f.events().filter(entry => entry.event === 'tools/call')).toEqual([]);
    const tool = connection.tools.calc__add!;
    expect(tool.inputJsonSchema).toMatchObject({ required: ['a', 'b'], additionalProperties: false, 'x-test-schema': { retained: true } });
    expect(await tool.invoke({ a: 17, b: 25 }, context())).toEqual({ content: [{ type: 'text', text: '42' }], structuredContent: { sum: 42 }, _meta: { fixture: true } });
    expect(f.events().filter(entry => entry.event === 'tools/call')).toMatchObject([{ name: 'add', signalAborted: false }]);
    await Promise.all([connection.close(), connection.close()]);
    assertExited(f.events());
    await expect(tool.invoke({ a: 1, b: 2 }, context())).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' });
  });

  it('inherits the process environment, applies explicit overrides, and binds absolute cwd', async () => {
    vi.stubEnv('MCP_FIXTURE_INHERITED', 'inherited-value');
    vi.stubEnv('MCP_FIXTURE_OVERRIDE', 'parent');
    const f = fixture();
    f.options.env = { ...f.options.env, MCP_FIXTURE_OVERRIDE: 'child' };
    const connection = await open(f.options);
    expect(f.events()[0]).toMatchObject({ cwd: f.root, inherited: 'inherited-value', override: 'child' });
    await connection.close();
    assertExited(f.events());
  });

  it('keeps remote annotations informational and configured policy authoritative', async () => {
    const defaults = await open(fixture().options);
    expect(defaults.tools.calc__add).toMatchObject({ permissions: [], approval: false, sideEffect: 'external', idempotent: false,
      mcp: { annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } } });
    const configured = await open(fixture('normal', { permissions: ['finance.write'], approval: true, sideEffect: 'external', idempotent: false }).options);
    for (const tool of Object.values(configured.tools)) expect(tool).toMatchObject({ permissions: ['finance.write'], approval: true, sideEffect: 'external', idempotent: false });
    const localRead = await open(fixture('normal', { sideEffect: 'none', idempotent: true }).options);
    expect(localRead.tools.calc__fail).toMatchObject({ sideEffect: 'none', idempotent: true });
  });

  it.each([{ a: '1', b: 2 }, { a: 1 }, { a: 1, b: 2, extra: true }, null, [1, 2]])('validates input without coercion, defaults, or stripping: %j', async input => {
    const f = fixture();
    const connection = await open(f.options);
    const original = structuredClone(input);
    expect(connection.tools.calc__add!.inputSchema.safeParse(input).success).toBe(false);
    await expect(connection.tools.calc__add!.invoke(input, context())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(input).toEqual(original);
    expect(f.events().filter(entry => entry.event === 'tools/call')).toEqual([]);
    assertExited(f.events());
  });

  it('retains allowed unknown fields and nested input unchanged', async () => {
    const connection = await open(fixture().options);
    const input = { arbitrary: { nested: [1, 'two', null] } };
    expect(connection.tools.calc__echo!.inputSchema.parse(input)).toEqual(input);
    expect(await connection.tools.calc__echo!.invoke(input, context())).toEqual({ content: [], structuredContent: input });
  });

  it('validates 2020-12 input semantics without replacing the advertised schema', async () => {
    const connection = await open(fixture().options);
    const tool = connection.tools.calc__modern!;
    expect(tool.inputJsonSchema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema' });
    expect(tool.inputSchema.safeParse({ tuple: [7] }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ tuple: ['7'] }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ tuple: [7, 8] }).success).toBe(false);
    expect(await tool.invoke({ tuple: [7] }, context())).toMatchObject({ structuredContent: { tuple: [7] } });
  });

  it('preserves resources and prompts using native paginated APIs', async () => {
    const connection = await open(fixture().options);
    const resources = await connection.listResources();
    expect(resources).toMatchObject({ resources: [{ uri: 'fixture:///readme', mimeType: 'text/plain' }], nextCursor: 'next-resource' });
    expect(await connection.listResources({ cursor: resources.nextCursor })).toEqual({ resources: [{ uri: 'fixture:///second', name: 'Second' }] });
    expect(await connection.readResource({ uri: 'fixture:///readme' })).toEqual({ contents: [{ uri: 'fixture:///readme', mimeType: 'text/plain', text: 'fixture resource' }] });
    expect(await connection.listPrompts()).toEqual({ prompts: [{ name: 'greet', arguments: [{ name: 'name', required: true }] }] });
    expect(await connection.getPrompt({ name: 'greet', arguments: { name: 'Ada' } })).toEqual({ description: 'Fixture prompt', messages: [{ role: 'user', content: { type: 'text', text: 'Hello Ada' } }] });
  });

  it('opens resources/prompts-only servers without requiring tool capability', async () => {
    const connection = await open(fixture('no-tools').options);
    expect(Object.keys(connection.tools)).toEqual([]);
    expect((await connection.listPrompts()).prompts[0]?.name).toBe('greet');
  });

  it('turns remote isError into TOOL_ERROR with the original envelope as cause, without retry', async () => {
    const f = fixture();
    const connection = await open(f.options);
    await expect(connection.tools.calc__fail!.invoke({}, context())).rejects.toMatchObject({ code: 'TOOL_ERROR', cause: {
      isError: true, content: [{ type: 'text', text: 'synthetic failure' }], structuredContent: { reason: 'test' },
    } });
    expect(f.events().filter(entry => entry.event === 'tools/call')).toHaveLength(1);
    assertExited(f.events());
  });

  it.each(['normal', 'bad-first-output'])('validates output even across SDK page cache resets: %s', async mode => {
    const f = fixture(mode);
    const connection = await open(f.options);
    const tool = mode === 'normal' ? connection.tools['calc__bad-output']! : connection.tools.calc__add!;
    await expect(tool.invoke(mode === 'normal' ? {} : { a: 1, b: 2 }, context())).rejects.toMatchObject({ code: 'TOOL_ERROR' });
    assertExited(f.events());
  });

  it('reports a missing executable precisely without retrying spawn', async () => {
    const start = vi.spyOn(StdioClientTransport.prototype, 'start');
    const f = fixture('normal', { command: '/nonexistent/runply-mcp-test-command' });
    await expect(open(f.options)).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE', message: expect.stringContaining('ENOENT') });
    expect(start).toHaveBeenCalledTimes(1);
    expect(f.events()).toEqual([]);
  });

  it.each(['exit', 'invalid-schema', 'compile-error', 'cycle', 'duplicate'])('cleans up failed acquisition: %s', async mode => {
    const f = fixture(mode);
    await expect(open(f.options)).rejects.toBeInstanceOf(FrameworkError);
    assertExited(f.events());
  });

  it('does not spawn for an already-aborted open', async () => {
    const f = fixture();
    const signal = AbortSignal.abort(new Error('stop'));
    await expect(open(f.options, signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.events()).toEqual([]);
  });

  it.each(['hang-connect', 'hang-list'])('cancels acquisition and closes the child: %s', async mode => {
    const f = fixture(mode);
    const controller = new AbortController();
    const result = open(f.options, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.events().some(entry => entry.event === (mode === 'hang-list' ? 'list-waiting' : 'started'))).toBe(true));
    controller.abort();
    await rejected;
    assertExited(f.events());
  });

  it.each(['hang-connect', 'hang-list'])('times out acquisition with a precise error and cleanup: %s', async mode => {
    const f = fixture(mode, { timeoutMs: 1200 });
    await expect(open(f.options)).rejects.toMatchObject({ code: 'TIMED_OUT', message: expect.stringContaining('timed out') });
    assertExited(f.events());
  });

  it('cancels an in-flight tool through the SDK signal, closes, and never re-executes', async () => {
    const f = fixture();
    const connection = await open(f.options);
    const controller = new AbortController();
    const rejected = expect(connection.tools.calc__slow!.invoke({}, context(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.events().some(entry => entry.event === 'call-waiting')).toBe(true));
    controller.abort();
    await rejected;
    expect(f.events().some(entry => entry.event === 'call-aborted')).toBe(true);
    expect(f.events().filter(entry => entry.event === 'tools/call')).toHaveLength(1);
    assertExited(f.events());
  });

  it('times out a tool call and terminates its connection', async () => {
    const f = fixture('normal', { timeoutMs: 1200 });
    const connection = await open(f.options);
    await expect(connection.tools.calc__slow!.invoke({}, context())).rejects.toMatchObject({ code: 'TIMED_OUT' });
    expect(f.events().filter(entry => entry.event === 'tools/call')).toHaveLength(1);
    assertExited(f.events());
  });

  it('closes idle connections when the owning run is cancelled', async () => {
    const f = fixture();
    const controller = new AbortController();
    const connection = await open(f.options, controller.signal);
    controller.abort();
    await connection.close();
    assertExited(f.events());
  });

  it('respects already-aborted native resource operations before dispatch', async () => {
    const f = fixture();
    const connection = await open(f.options);
    await expect(connection.readResource({ uri: 'fixture:///readme' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.events().some(entry => entry.event === 'resources/read')).toBe(false);
    assertExited(f.events());
  });
});