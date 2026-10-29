import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import tls from 'node:tls';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Application, Artifact, RuntimeOptions, ToolContext, Workspace } from '../src/contracts.js';
import type { ErrorCode } from '../src/errors.js';
import { runApplication } from '../src/runtime.js';
import type { RunResult } from '../src/runtime.js';
import { fakeModel, modelResponse, toolResponse } from '../src/testing/model.js';
import { MemoryRunStore } from '../src/testing/store.js';
import { defineTool } from '../src/tools.js';

const inputSchema = z.strictObject({ quantity: z.number().int().positive(), apiKey: z.string().optional() });
const outputSchema = z.strictObject({ totalCents: z.number().int().nonnegative(), currency: z.literal('USD') });
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
const input: Input = { quantity: 3 };
const output: Output = { totalCents: 3750, currency: 'USD' };
const finalResponse = () => modelResponse(JSON.stringify(output));
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const blockedNetwork = vi.fn((): never => { throw new Error('Network disabled in runtime tests.'); });
beforeEach(() => {
  blockedNetwork.mockClear();
  vi.stubGlobal('fetch', blockedNetwork);
  vi.stubGlobal('WebSocket', blockedNetwork);
  vi.spyOn(http, 'request').mockImplementation(blockedNetwork);
  vi.spyOn(http, 'get').mockImplementation(blockedNetwork);
  vi.spyOn(https, 'request').mockImplementation(blockedNetwork);
  vi.spyOn(https, 'get').mockImplementation(blockedNetwork);
  vi.spyOn(http2, 'connect').mockImplementation(blockedNetwork);
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blockedNetwork);
  vi.spyOn(tls, 'connect').mockImplementation(blockedNetwork);
  vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blockedNetwork);
});
afterEach(() => {
  try { expect(blockedNetwork).not.toHaveBeenCalled(); }
  finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function harness(responses = [toolResponse('quote', input, 'quote-1'), finalResponse()]) {
  let index = 0;
  const respond = vi.fn<Parameters<typeof fakeModel>[0]>(() => {
    const response = responses[index++];
    if (!response) throw new Error('Unexpected model call; scripted responses exhausted.');
    return response;
  });
  const execute = vi.fn((value: Input, context: ToolContext): unknown | Promise<unknown> => {
    const quote: Output = { totalCents: value.quantity * 1250, currency: 'USD' };
    context.state.set('quote', quote);
    return quote;
  });
  // unknown permits deliberately invalid tool returns without lying to TypeScript.
  const quote = defineTool<Input, unknown>({
    description: 'Calculate a quote in integer cents.', inputSchema, outputSchema,
    sideEffect: 'none', idempotent: true, execute,
  });
  const finalize = vi.fn((value: Output, _context: { input: Input; state: ToolContext['state'] }): Artifact[] => [
    { name: 'quote.json', mediaType: 'application/json', content: JSON.stringify(value) },
  ]);
  const application: Application<Input, Output> = {
    name: 'offline-runtime-quote', inputSchema, outputSchema, tools: { quote },
    messages: value => [{ role: 'user', content: `Quote quantity ${value.quantity}, then return JSON.` }],
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
  const model = fakeModel(respond);
  return { application, quote, execute, finalize, respond, model, store, workspace, publish, published };
}
type Harness = ReturnType<typeof harness>;

function expectFailure(h: Harness, result: RunResult<Output>, code: ErrorCode, status = 'failed') {
  expect(result.status).toBe(status);
  expect(result.error?.code).toBe(code);
  expect(result.output).toBeUndefined();
  expect(result.artifacts).toEqual([]);
  expect(h.finalize).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  const events = h.store.events(result.runId);
  expect(events.some(event => event.type === 'artifact.created')).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: 'run.status', data: { status, code } });
  expect(h.store.get(result.runId)).toMatchObject({ status, version: events.length });
}

describe('offline runtime contracts', () => {
  it('executes a real tool, snapshots state on write/read, and publishes the validated final output', async () => {
    const h = harness();
    h.execute.mockImplementation((value, context) => {
      const calculated: Output = { totalCents: value.quantity * 1250, currency: 'USD' };
      context.state.set('quote', calculated);
      calculated.totalCents = 1;
      const read = outputSchema.parse(context.state.get('quote'));
      read.totalCents = 2;
      // Mutate the actual retrieved object too: Zod itself clones parsed objects.
      const retrieved = context.state.get('quote') as Output;
      retrieved.totalCents = 3;
      return context.state.get('quote');
    });
    h.finalize.mockImplementation((value, context) => {
      expect(context.state.get('quote')).toEqual(output);
      expect(context.input).toEqual(input);
      expect(value).toEqual(output);
      return [{ name: 'quote.json', mediaType: 'application/json', content: JSON.stringify(value) }];
    });
    const result = await runApplication(h.application, input, { ...h, captureContent: true });

    expect(result).toMatchObject({ status: 'succeeded', output });
    expect(result.error).toBeUndefined();
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(input, expect.objectContaining({
      runId: result.runId, toolCallId: 'quote-1', input, signal: expect.any(AbortSignal),
    }));
    expect(h.respond).toHaveBeenCalledTimes(2);
    expect(h.respond.mock.calls[1]![0].prompt).toContainEqual(expect.objectContaining({ role: 'tool', content: [
      expect.objectContaining({ toolName: 'quote', toolCallId: 'quote-1', output: { type: 'json', value: output } }),
    ] }));
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
    const artifact = { name: 'quote.json', mediaType: 'application/json', content: JSON.stringify(output) };
    expect(h.published.get(result.runId)).toEqual([artifact]);
    expect(result.artifacts).toEqual([{
      name: artifact.name, path: `memory://${result.runId}/${artifact.name}`,
      sha256: createHash('sha256').update(artifact.content).digest('hex'), bytes: Buffer.byteLength(artifact.content),
    }]);
    const events = h.store.events(result.runId);
    expect(events.map(event => event.type)).toEqual([
      'run.started', 'model.started', 'model.completed', 'tool.started', 'state.changed', 'tool.completed',
      'model.started', 'model.completed', 'artifact.created', 'run.status',
    ]);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.find(event => event.type === 'state.changed')).toMatchObject({ data: { key: 'quote', value: output } });
    expect(events.find(event => event.type === 'tool.completed')).toMatchObject({ stepId: 'quote-1', parentId: 'model-1', data: { output } });
    expect(events.at(-1)?.data).toEqual({ status: 'succeeded', output, artifactCount: 1 });
    expect(h.store.get(result.runId)).toMatchObject({ status: 'succeeded', version: events.length });
    expect(h.workspace.close).not.toHaveBeenCalled();
  });

  it.each([null, { quantity: 0 }, { quantity: '3' }])('rejects invalid application input %j before model dispatch', async value => {
    const h = harness();
    const result = await runApplication(h.application, value, h);
    expectFailure(h, result, 'INVALID_INPUT');
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(['tools', 'streaming', 'structuredOutput'] as const)('rejects missing model capability %s before dispatch', async capability => {
    const h = harness();
    h.model.capabilities[capability] = false;
    // Tools must be inferred from application.tools without an explicit requirement.
    if (capability !== 'tools') h.application.requirements = { [capability]: true };
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'CAPABILITY_MISMATCH');
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects workspace isolation mismatch before calling the model', async () => {
    const h = harness();
    h.application.workspaceRequirements = { isolation: true };
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'CAPABILITY_MISMATCH');
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(['{broken', '{"totalCents":"3750","currency":"USD"}', 'null'])('does not finalize or publish malformed final output %s', async text => {
    const h = harness([toolResponse('quote', input, 'quote-1'), modelResponse(text)]);
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'INVALID_OUTPUT');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed tool JSON without invoking tools or asking the model to repair it', async () => {
    const h = harness([modelResponse([{ type: 'tool-call', toolName: 'quote', toolCallId: 'bad-json', input: '{broken' }], 'tool-calls')]);
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'INVALID_INPUT');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('rejects an unavailable tool before executing any call in that response', async () => {
    const h = harness([modelResponse([
      { type: 'tool-call', toolName: 'quote', toolCallId: 'valid', input: JSON.stringify(input) },
      { type: 'tool-call', toolName: 'missing', toolCallId: 'missing', input: '{}' },
    ], 'tool-calls')]);
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'TOOL_UNAVAILABLE');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it.each([{ quantity: '3' }, { quantity: -1 }, {}])('validates tool input %j before any execution', async value => {
    const h = harness([toolResponse('quote', value, 'invalid-input')]);
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'INVALID_INPUT');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('fails a tool output schema error without completing the tool or continuing generation', async () => {
    const h = harness();
    h.execute.mockReturnValue({ totalCents: '3750', currency: 'USD' });
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'INVALID_OUTPUT');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.store.events(result.runId).filter(event => event.type === 'tool.completed')).toEqual([]);
  });

  it('does not retry a throwing tool or request model recovery', async () => {
    const h = harness();
    const cause = new Error('Local tool failed.');
    h.execute.mockImplementation(() => { throw cause; });
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'TOOL_ERROR');
    expect(result.error?.cause).toBe(cause);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('does not retry a throwing model', async () => {
    const h = harness();
    const cause = new Error('Local model failed.');
    h.respond.mockRejectedValue(cause);
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'MODEL_ERROR');
    expect(result.error?.cause).toBe(cause);
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('does not implicitly invoke available tools when the model returns final output', async () => {
    const h = harness([finalResponse()]);
    const result = await runApplication(h.application, input, h);
    expect(result.status).toBe('succeeded');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('denies missing permissions before asking for approval or executing a tool', async () => {
    const h = harness();
    h.quote.permissions = ['billing:write'];
    h.quote.approval = true;
    const approve = vi.fn<NonNullable<RuntimeOptions['approve']>>(async () => true);
    const result = await runApplication(h.application, input, { ...h, approve });
    expectFailure(h, result, 'PERMISSION_DENIED');
    expect(approve).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit approval handler instead of implicitly approving', async () => {
    const h = harness();
    h.quote.approval = true;
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'APPROVAL_REQUIRED');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.store.events(result.runId).filter(event => event.type === 'approval.requested')).toHaveLength(1);
  });

  it('honors approval denial without executing or retrying', async () => {
    const h = harness();
    h.quote.approval = true;
    const approve = vi.fn<NonNullable<RuntimeOptions['approve']>>(async () => false);
    const result = await runApplication(h.application, input, { ...h, approve });
    expectFailure(h, result, 'PERMISSION_DENIED');
    expect(approve).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('waits for explicit approval, then executes once with granted permissions', async () => {
    const h = harness();
    h.quote.permissions = ['billing:write'];
    h.quote.approval = true;
    const requested = deferred<Parameters<NonNullable<RuntimeOptions['approve']>>[0]>();
    const decision = deferred<boolean>();
    const approve = vi.fn<NonNullable<RuntimeOptions['approve']>>(request => { requested.resolve(request); return decision.promise; });
    const pending = runApplication(h.application, input, { ...h, approve, permissions: ['billing:write'] });
    const request = await requested.promise;
    try {
      expect(request).toMatchObject({ toolCallId: 'quote-1', tool: 'quote', input });
      expect(request.signal.aborted).toBe(false);
      expect(h.store.get(request.runId).status).toBe('waiting_approval');
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
    } finally { decision.resolve(true); }
    const result = await pending;
    expect(result.status).toBe('succeeded');
    expect(approve).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.store.events(result.runId).filter(event => event.type === 'run.status').map(event => event.data)).toEqual([
      { status: 'running', approvedToolCallId: 'quote-1' },
      { status: 'succeeded', output: { omitted: true }, artifactCount: 1 },
    ]);
  });

  it('cancels while waiting for approval and ignores a late approval', async () => {
    const h = harness();
    h.quote.approval = true;
    const controller = new AbortController();
    const requested = deferred<void>();
    const decision = deferred<boolean>();
    const approve = vi.fn<NonNullable<RuntimeOptions['approve']>>(() => { requested.resolve(); return decision.promise; });
    const pending = runApplication(h.application, input, { ...h, approve, signal: controller.signal });
    await requested.promise;
    expect(h.store.list()[0]?.status).toBe('waiting_approval');
    controller.abort();
    const result = await pending;
    const events = h.store.events(result.runId);
    decision.resolve(true);
    await nextTurn();
    expectFailure(h, result, 'CANCELLED', 'cancelled');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.store.events(result.runId)).toEqual(events);
    expect(events.at(-1)?.data).toMatchObject({ uncertainToolCalls: [] });
  });

  it('times out a non-cooperative model whose promise never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    const started = deferred<void>();
    h.respond.mockImplementation(() => { started.resolve(); return new Promise<LanguageModelV4GenerateResult>(() => {}); });
    const pending = runApplication(h.application, input, { ...h, timeoutMs: 100 });
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expectFailure(h, result, 'TIMED_OUT');
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.respond.mock.calls[0]![0].abortSignal?.aborted).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors user cancellation before dispatch', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await runApplication(h.application, input, { ...h, signal: controller.signal });
    expectFailure(h, result, 'CANCELLED', 'cancelled');
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(['none', 'external'] as const)('cancels an in-flight %s tool and ignores its late completion', async sideEffect => {
    const h = harness();
    h.quote.sideEffect = sideEffect;
    const controller = new AbortController();
    const started = deferred<ToolContext>();
    const completion = deferred<Output>();
    h.execute.mockImplementation((_value, context) => { started.resolve(context); return completion.promise; });
    const pending = runApplication(h.application, input, { ...h, signal: controller.signal });
    const context = await started.promise;
    controller.abort();
    const result = await pending;
    const events = h.store.events(result.runId);
    const record = h.store.get(result.runId);
    completion.resolve(output);
    // An event-loop barrier drains late promise continuations; no sleep or polling.
    await nextTurn();
    expectFailure(h, result, 'CANCELLED', sideEffect === 'external' ? 'interrupted' : 'cancelled');
    expect(context.signal.aborted).toBe(true);
    expect(() => context.state.set('late-write', output)).toThrow();
    expect(context.state.get('late-write')).toBeUndefined();
    expect(events.at(-1)?.data).toMatchObject({ uncertainToolCalls: sideEffect === 'external' ? ['quote-1'] : [] });
    expect(h.store.events(result.runId)).toEqual(events);
    expect(h.store.get(result.runId)).toEqual(record);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'tool.completed')).toEqual([]);
  });

  it.each(['resolve', 'reject'] as const)('ignores a model that completes late by %s after user cancellation', async outcome => {
    const h = harness();
    const controller = new AbortController();
    const started = deferred<void>();
    const completion = deferred<LanguageModelV4GenerateResult>();
    h.respond.mockImplementation(() => { started.resolve(); return completion.promise; });
    const pending = runApplication(h.application, input, { ...h, signal: controller.signal });
    await started.promise;
    controller.abort();
    const result = await pending;
    const events = h.store.events(result.runId);
    const record = h.store.get(result.runId);
    if (outcome === 'resolve') completion.resolve(toolResponse('quote', input, 'too-late'));
    else completion.reject(new Error('Late model rejection.'));
    await nextTurn();
    expectFailure(h, result, 'CANCELLED', 'cancelled');
    expect(h.store.events(result.runId)).toEqual(events);
    expect(h.store.get(result.runId)).toEqual(record);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate tool call IDs across steps without re-execution', async () => {
    const h = harness([toolResponse('quote', input, 'same-id'), toolResponse('quote', input, 'same-id')]);
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'TOOL_ERROR');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate tool call IDs within one response before executing either', async () => {
    const response = toolResponse('quote', input, 'same-id');
    const h = harness([modelResponse([...response.content, ...response.content], 'tool-calls')]);
    const result = await runApplication(h.application, input, h);
    expectFailure(h, result, 'TOOL_ERROR');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('honors configured maxSteps without publishing an unfinished tool loop', async () => {
    const h = harness();
    const result = await runApplication(h.application, input, { ...h, maxSteps: 1 });
    expectFailure(h, result, 'STEP_LIMIT');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('has no default forced step cap (64 tool steps followed by a final response)', async () => {
    const steps = 64;
    const h = harness([
      ...Array.from({ length: steps }, (_, i) => toolResponse('quote', input, `quote-${i}`)),
      finalResponse(),
    ]);
    const result = await runApplication(h.application, input, h);
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual(output);
    expect(h.execute).toHaveBeenCalledTimes(steps);
    expect(h.respond).toHaveBeenCalledTimes(steps + 1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('records unknown token usage as null instead of inventing zero usage', async () => {
    const h = harness();
    const result = await runApplication(h.application, input, h);
    expect(result.status).toBe('succeeded');
    const completed = h.store.events(result.runId).filter(event => event.type === 'model.completed');
    expect(completed).toHaveLength(2);
    for (const event of completed) expect(event.data).toMatchObject({ usage: { inputTokens: null, outputTokens: null } });
  });

  it('omits input, prompts, tool payloads, state, and final output from events by default', async () => {
    const h = harness();
    const result = await runApplication(h.application, input, h);
    expect(result.output).toEqual(output);
    const fields = new Map([
      ['run.started', 'input'], ['model.started', 'messages'], ['model.completed', 'content'],
      ['tool.started', 'input'], ['tool.completed', 'output'], ['state.changed', 'value'], ['run.status', 'output'],
    ]);
    const events = h.store.events(result.runId);
    for (const [type, field] of fields) {
      const matching = events.filter(event => event.type === type);
      expect(matching.length).toBeGreaterThan(0);
      for (const event of matching) expect(event.data).toHaveProperty(field, { omitted: true });
    }
    expect(JSON.stringify(events)).not.toContain('totalCents');
    expect(h.published.get(result.runId)?.[0]?.content).toBe(JSON.stringify(output));
  });

  it('redacts captured structured secrets recursively without altering tool inputs or state', async () => {
    const h = harness();
    const secret = { apiKey: 'app-key-value', nested: [{ password: 'password-value', access_token: 'token-value', safe: 'visible' }] };
    h.execute.mockImplementation((_value, context) => {
      expect(context.input).toEqual({ ...input, apiKey: secret.apiKey });
      context.state.set('credentials', secret);
      expect(context.state.get('credentials')).toEqual(secret);
      return output;
    });
    const result = await runApplication(h.application, { ...input, apiKey: secret.apiKey }, { ...h, captureContent: true });
    expect(result.status).toBe('succeeded');
    const events = h.store.events(result.runId);
    expect(events[0]?.data).toMatchObject({ input: { quantity: 3, apiKey: '[REDACTED]' } });
    expect(events.find(event => event.type === 'state.changed')?.data).toEqual({ key: 'credentials', value: {
      apiKey: '[REDACTED]', nested: [{ password: '[REDACTED]', access_token: '[REDACTED]', safe: 'visible' }],
    } });
    const captured = JSON.stringify(events);
    for (const value of ['app-key-value', 'password-value', 'token-value']) expect(captured).not.toContain(value);
  });

  it('uses the application redactor for secrets inside captured free text and model tool JSON', async () => {
    const secret = 'text-secret-value';
    const h = harness([toolResponse('quote', { ...input, apiKey: secret }, 'quote-1'), finalResponse()]);
    h.application.messages = () => [{ role: 'user', content: `Do not log ${secret}.` }];
    const redact = vi.fn((value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(secret, '[REDACTED]')));
    const result = await runApplication(h.application, input, { ...h, captureContent: true, redact });
    expect(result.status).toBe('succeeded');
    expect(h.execute).toHaveBeenCalledWith({ ...input, apiKey: secret }, expect.anything());
    expect(redact).toHaveBeenCalled();
    const captured = JSON.stringify(h.store.events(result.runId));
    expect(captured).not.toContain(secret);
    expect(captured).toContain('[REDACTED]');
  });

  it('keeps concurrent runs isolated on the same fake model and store with reversed tool completion', async () => {
    const h = harness([]);
    const starts = [deferred<ToolContext>(), deferred<ToolContext>()];
    const releases = [deferred<Output>(), deferred<Output>()];
    const observedQuantities: number[] = [];
    h.respond.mockImplementation(call => {
      const user = call.prompt.find(message => message.role === 'user');
      if (!user || user.role !== 'user') throw new Error('Missing user prompt.');
      const text = user.content.filter(part => part.type === 'text').map(part => part.text).join('');
      const quantity = Number(/quantity (\d+)/.exec(text)?.[1]);
      expect([1, 2]).toContain(quantity);
      const history = call.prompt.filter(message => message.role === 'tool');
      observedQuantities.push(quantity);
      if (!history.length) return toolResponse('quote', { quantity }, 'shared-call-id');
      expect(history).toHaveLength(1);
      expect(history[0]?.content).toEqual([expect.objectContaining({
        toolCallId: 'shared-call-id', output: { type: 'json', value: { totalCents: quantity * 1250, currency: 'USD' } },
      })]);
      return modelResponse(JSON.stringify({ totalCents: quantity * 1250, currency: 'USD' }));
    });
    h.execute.mockImplementation(async (value, context) => {
      const slot = value.quantity - 1;
      expect(context.input).toEqual(value);
      expect(context.state.get('quote')).toBeUndefined();
      starts[slot]!.resolve(context);
      const quote = await releases[slot]!.promise;
      context.state.set('quote', quote);
      return quote;
    });
    h.finalize.mockImplementation((value, context) => {
      expect(value.totalCents).toBe(context.input.quantity * 1250);
      expect(context.state.get('quote')).toEqual(value);
      return [{ name: 'quote.json', mediaType: 'application/json', content: JSON.stringify(value) }];
    });
    const first = runApplication(h.application, { quantity: 1 }, { ...h, captureContent: true });
    const second = runApplication(h.application, { quantity: 2 }, { ...h, captureContent: true });
    const [context1, context2] = await Promise.all(starts.map(start => start.promise));
    expect(context1!.runId).not.toBe(context2!.runId);
    releases[1]!.resolve({ totalCents: 2500, currency: 'USD' });
    const result2 = await second;
    const secondEvents = h.store.events(result2.runId);
    try {
      expect(result2.status).toBe('succeeded');
      expect(h.store.get(context1!.runId).status).toBe('running');
      expect(context1!.signal.aborted).toBe(false);
      expect(context1!.state.get('quote')).toBeUndefined();
    } finally { releases[0]!.resolve({ totalCents: 1250, currency: 'USD' }); }
    const result1 = await first;
    expect(result1.status).toBe('succeeded');
    expect(result1.output).toEqual({ totalCents: 1250, currency: 'USD' });
    expect(result2.output).toEqual({ totalCents: 2500, currency: 'USD' });
    expect(observedQuantities).toEqual([1, 2, 2, 1]);
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.respond).toHaveBeenCalledTimes(4);
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.store.events(result2.runId)).toEqual(secondEvents);
    for (const result of [result1, result2]) {
      const events = h.store.events(result.runId);
      expect(events.every(event => event.runId === result.runId)).toBe(true);
      expect(events.map(event => event.sequence)).toEqual(events.map((_, i) => i + 1));
      expect(events.find(event => event.type === 'state.changed')?.data).toMatchObject({ value: result.output });
      expect(h.published.get(result.runId)?.[0]?.content).toBe(JSON.stringify(result.output));
    }
  });
});