import { createHash } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Application, Artifact, ToolContext, Workspace } from '../src/contracts.js';
import { FrameworkError } from '../src/errors.js';
import { aiSdkModel } from '../src/model.js';
import { runApplication } from '../src/runtime.js';
import { MemoryRunStore } from '../src/testing/store.js';

// These are wire-protocol fixtures, not evidence of native structured output or streaming.
const capabilities = { tools: true, streaming: false, structuredOutput: false };
const apiKey = 'dummy-local-provider-test-key';
const callId = 'call_quote_1';
const input = { quantity: 3 };
const toolResult = { totalCents: 3750, currency: 'USD' };
const finalText = JSON.stringify(toolResult);
const inputSchema = z.strictObject({ quantity: z.number().int().positive() });
const outputSchema = z.strictObject({ totalCents: z.number().int().positive(), currency: z.literal('USD') });
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
type Body = Record<string, unknown>;

interface ProviderCase {
  name: string;
  modelId: string;
  endpoint: string;
  makeModel(fetch: typeof globalThis.fetch): LanguageModelV4;
  optionsSchema: z.ZodType<SharedV4ProviderOptions>;
  options: SharedV4ProviderOptions;
  invalidOptions: Array<{ name: string; value: SharedV4ProviderOptions }>;
  response(step: number, text: string): unknown;
  error: unknown;
  assertRequest(body: Body, headers: Headers, withOptions: boolean): void;
  assertToolHistory(body: Body): void;
  rawStops: readonly [string, string];
}

const providers: ProviderCase[] = [
  {
    name: 'OpenAI chat',
    modelId: 'gpt-4o',
    endpoint: 'https://openai.invalid/v1/chat/completions',
    makeModel: fetch => createOpenAI({ apiKey, baseURL: 'https://openai.invalid/v1', fetch }).chat('gpt-4o'),
    optionsSchema: z.strictObject({ openai: z.strictObject({ parallelToolCalls: z.boolean().optional() }).optional() }),
    options: { openai: { parallelToolCalls: false } },
    invalidOptions: [
      { name: 'unknown namespace', value: { anthropic: { disableParallelToolUse: true } } },
      { name: 'unknown nested option', value: { openai: { parallelToolCalls: false, unsupportedFixtureOption: true } } },
      { name: 'wrong option type', value: { openai: { parallelToolCalls: 'false' } } },
    ],
    response: (step, text) => ({
      id: `chatcmpl_fixture_${step}`,
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o',
      choices: [{
        index: 0,
        message: step === 0
          ? { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'quote', arguments: JSON.stringify(input) } }] }
          : { role: 'assistant', content: text },
        finish_reason: step === 0 ? 'tool_calls' : 'stop',
      }],
      usage: step === 0
        ? { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20, prompt_tokens_details: { cached_tokens: 2 } }
        : { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34, prompt_tokens_details: { cached_tokens: 3 } },
    }),
    error: { error: { message: 'Local fixture unavailable', type: 'server_error', param: null, code: 'server_error' } },
    assertRequest(body, headers, withOptions) {
      expect(headers.get('authorization')).toBe(`Bearer ${apiKey}`);
      expect(body).not.toHaveProperty('response_format');
      if (withOptions) expect(body.parallel_tool_calls).toBe(false);
      else expect(body).not.toHaveProperty('parallel_tool_calls');
      expect(body.tools).toEqual([expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'quote', parameters: expect.objectContaining({
          type: 'object', required: ['quantity'], additionalProperties: false,
          properties: { quantity: expect.objectContaining({ type: 'integer' }) },
        }) }),
      })]);
    },
    assertToolHistory(body) {
      expect(body.messages).toEqual([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant', tool_calls: [{
          id: callId, type: 'function', function: { name: 'quote', arguments: JSON.stringify(input) },
        }] }),
        { role: 'tool', tool_call_id: callId, content: finalText },
      ]);
    },
    rawStops: ['tool_calls', 'stop'],
  },
  {
    name: 'Anthropic messages',
    modelId: 'claude-sonnet-4-5',
    endpoint: 'https://anthropic.invalid/v1/messages',
    makeModel: fetch => createAnthropic({ apiKey, baseURL: 'https://anthropic.invalid/v1', fetch })('claude-sonnet-4-5'),
    optionsSchema: z.strictObject({ anthropic: z.strictObject({ disableParallelToolUse: z.boolean().optional() }).optional() }),
    options: { anthropic: { disableParallelToolUse: true } },
    invalidOptions: [
      { name: 'unknown namespace', value: { openai: { parallelToolCalls: false } } },
      { name: 'unknown nested option', value: { anthropic: { disableParallelToolUse: true, unsupportedFixtureOption: true } } },
      { name: 'wrong option type', value: { anthropic: { disableParallelToolUse: 'true' } } },
    ],
    response: (step, text) => ({
      id: `msg_fixture_${step}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: step === 0
        ? [{ type: 'tool_use', id: callId, name: 'quote', input }]
        : [{ type: 'text', text }],
      stop_reason: step === 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      // Anthropic input totals include cache reads and writes: 8+3+2=13, 16+4+3=23.
      usage: step === 0
        ? { input_tokens: 8, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 7 }
        : { input_tokens: 16, cache_creation_input_tokens: 4, cache_read_input_tokens: 3, output_tokens: 11 },
    }),
    error: { type: 'error', error: { type: 'api_error', message: 'Local fixture unavailable' } },
    assertRequest(body, headers, withOptions) {
      expect(headers.get('x-api-key')).toBe(apiKey);
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(body).not.toHaveProperty('output_format');
      expect(body).not.toHaveProperty('output_config');
      if (withOptions) expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      else expect(body.tool_choice).not.toHaveProperty('disable_parallel_tool_use');
      expect(body.tools).toEqual([expect.objectContaining({
        name: 'quote', input_schema: expect.objectContaining({
          type: 'object', required: ['quantity'], additionalProperties: false,
          properties: { quantity: expect.objectContaining({ type: 'integer' }) },
        }),
      })]);
    },
    assertToolHistory(body) {
      expect(body.messages).toEqual([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'quote', input }] }),
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: finalText }] },
      ]);
    },
    rawStops: ['tool_use', 'end_turn'],
  },
];

function makeApplication() {
  const invoke = vi.fn(async (value: unknown, context: ToolContext) => {
    const { quantity } = inputSchema.parse(value);
    const quote = { totalCents: quantity * 1250, currency: 'USD' };
    context.state.set('quote', quote);
    return quote;
  });
  const finalize = vi.fn((output: Output, context: { input: Input; state: ToolContext['state'] }): Artifact[] => {
    const quote = outputSchema.parse(context.state.get('quote'));
    if (output.totalCents !== quote.totalCents) throw new FrameworkError('INVALID_OUTPUT', 'Quote does not match the business tool result.');
    return [{ name: 'quote.json', mediaType: 'application/json', content: JSON.stringify(output) }];
  });
  const application: Application<Input, Output> = {
    name: 'provider-conformance-quote', inputSchema, outputSchema,
    requirements: { tools: true }, workspaceRequirements: { artifacts: true },
    tools: { quote: {
      description: 'Calculate a quote in cents.', inputSchema,
      sideEffect: 'none', idempotent: true, permissions: [], approval: false, invoke,
    } },
    messages: value => [{ role: 'user', content: `Call quote for quantity ${value.quantity}, then return JSON with totalCents and currency.` }],
    finalize,
  };
  return { application, invoke, finalize };
}

function makeHarness(provider: ProviderCase, responses: Response[]) {
  const requests: Array<{ body: Body; headers: Headers }> = [];
  const transport = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    // Never delegate to global fetch, even when a fixture is exhausted.
    expect(String(url)).toBe(provider.endpoint);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof init?.body).toBe('string');
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(init!.body as string));
    requests.push({ body, headers: new Headers(init?.headers) });
    const response = responses[requests.length - 1];
    if (!response) throw new Error('Unexpected extra provider request; no network fallback exists.');
    return response;
  });
  const published = new Map<string, readonly Artifact[]>();
  const publish = vi.fn<Workspace['publish']>(async (runId, artifacts) => {
    if (published.has(runId)) throw new Error('Run already published.');
    published.set(runId, structuredClone(artifacts));
    return artifacts.map(artifact => ({
      name: artifact.name, path: `memory://${runId}/${artifact.name}`,
      sha256: createHash('sha256').update(artifact.content).digest('hex'),
      bytes: Buffer.byteLength(artifact.content),
    }));
  });
  const workspace: Workspace = {
    capabilities: { files: false, artifacts: true, execution: false, isolation: false },
    publish, async close() {},
  };
  const store = new MemoryRunStore();
  const model = aiSdkModel({
    id: `fixture:${provider.modelId}`, model: provider.makeModel(transport), capabilities,
    providerOptionsSchema: provider.optionsSchema,
  });
  return { ...makeApplication(), model, store, workspace, requests, transport, published, publish };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const blockedFetch = vi.fn<typeof globalThis.fetch>(async () => {
  throw new Error('Network disabled: provider tests must use injected fixture fetch.');
});
beforeEach(() => {
  blockedFetch.mockClear();
  vi.stubGlobal('fetch', blockedFetch);
});
afterEach(() => {
  try { expect(blockedFetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); }
});

describe.each(providers)('$name local protocol conformance', provider => {
  it.each([false, true])('runs the same tool-to-JSON application (provider options: %s)', async withOptions => {
    const h = makeHarness(provider, [jsonResponse(provider.response(0, finalText)), jsonResponse(provider.response(1, finalText))]);
    const result = await runApplication(h.application, input, {
      ...h, maxSteps: 3, captureContent: true,
      ...(withOptions ? { providerOptions: provider.options } : {}),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual(toolResult);
    expect(h.model.model.specificationVersion).toBe('v4');
    expect(h.model.capabilities).toEqual({ tools: true, streaming: false, structuredOutput: false });
    expect(h.transport).toHaveBeenCalledTimes(2);
    for (const request of h.requests) {
      expect(request.body.model).toBe(provider.modelId);
      expect(request.body.stream ?? false).toBe(false);
      provider.assertRequest(request.body, request.headers, withOptions);
    }
    expect(h.requests[0]!.body.messages).toHaveLength(1);
    provider.assertToolHistory(h.requests[1]!.body);
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(input, expect.objectContaining({ input, runId: result.runId, toolCallId: callId }));
    expect(h.finalize).toHaveBeenCalledExactlyOnceWith(toolResult, expect.objectContaining({ input }));
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.published.get(result.runId)).toEqual([{ name: 'quote.json', mediaType: 'application/json', content: finalText }]);
    expect(result.artifacts).toEqual([{
      name: 'quote.json', path: `memory://${result.runId}/quote.json`,
      sha256: createHash('sha256').update(finalText).digest('hex'), bytes: Buffer.byteLength(finalText),
    }]);

    const events = h.store.events(result.runId);
    expect(events.map(event => event.type)).toEqual([
      'run.started', 'model.started', 'model.completed', 'tool.started', 'state.changed',
      'tool.completed', 'model.started', 'model.completed', 'artifact.created', 'run.status',
    ]);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const event of events) expect(event).toMatchObject({ schemaVersion: 1, runId: result.runId });
    expect(events[0]!.data).toMatchObject({ capabilities, retries: 0, continuation: false });
    const completed = events.filter(event => event.type === 'model.completed');
    expect(completed).toMatchObject([
      { stepId: 'model-1', data: { finishReason: { unified: 'tool-calls', raw: provider.rawStops[0] }, usage: { inputTokens: 13, outputTokens: 7 }, warnings: [] } },
      { stepId: 'model-2', data: { finishReason: { unified: 'stop', raw: provider.rawStops[1] }, usage: { inputTokens: 23, outputTokens: 11 }, warnings: [] } },
    ]);
    const usageSchema = z.object({ usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }) });
    const totals = completed.reduce((sum, event) => {
      const { usage } = usageSchema.parse(event.data);
      return { input: sum.input + usage.inputTokens, output: sum.output + usage.outputTokens };
    }, { input: 0, output: 0 });
    expect(totals).toEqual({ input: 36, output: 18 });
    expect(events.find(event => event.type === 'tool.started')).toMatchObject({ stepId: callId, parentId: 'model-1', data: { tool: 'quote', input } });
    expect(events.find(event => event.type === 'tool.completed')).toMatchObject({ stepId: callId, parentId: 'model-1', data: { tool: 'quote', output: toolResult } });
    expect(events.at(-1)!.data).toEqual({ status: 'succeeded', output: toolResult, artifactCount: 1 });
    expect(h.store.get(result.runId)).toMatchObject({ status: 'succeeded', version: 10 });
  });

  it.each(provider.invalidOptions)('rejects $name before transport', async ({ value }) => {
    const h = makeHarness(provider, []);
    const result = await runApplication(h.application, input, { ...h, providerOptions: value });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('UNSUPPORTED_OPTIONS');
    expect(result.output).toBeUndefined();
    expect(result.artifacts).toEqual([]);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.store.events(result.runId).map(event => event.type)).toEqual(['run.started', 'run.status']);
    expect(h.store.get(result.runId).status).toBe('failed');
  });

  it.each([429, 503])('fails HTTP %s without retrying', async status => {
    const h = makeHarness(provider, [jsonResponse(provider.error, status)]);
    const result = await runApplication(h.application, input, h);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('MODEL_ERROR');
    expect(result.error?.cause).toMatchObject({ statusCode: status, isRetryable: true });
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(result.artifacts).toEqual([]);
    const events = h.store.events(result.runId);
    expect(events.map(event => event.type)).toEqual(['run.started', 'model.started', 'model.failed', 'run.status']);
    expect(events[2]).toMatchObject({ stepId: 'model-1', data: { code: 'MODEL_ERROR' } });
    expect(h.store.get(result.runId).status).toBe('failed');
  });

  it.each([
    { name: 'malformed JSON', text: '{broken', finalizes: false },
    { name: 'wrong output field type', text: '{"totalCents":"3750","currency":"USD"}', finalizes: false },
    { name: 'extra output field', text: '{"totalCents":3750,"currency":"USD","extra":true}', finalizes: false },
    { name: 'incorrect business total', text: '{"totalCents":1,"currency":"USD"}', finalizes: true },
  ])('rejects $name after the real tool step without publishing', async ({ text, finalizes }) => {
    const h = makeHarness(provider, [jsonResponse(provider.response(0, text)), jsonResponse(provider.response(1, text))]);
    const result = await runApplication(h.application, input, { ...h, maxSteps: 3 });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INVALID_OUTPUT');
    expect(result.output).toBeUndefined();
    expect(result.artifacts).toEqual([]);
    expect(h.transport).toHaveBeenCalledTimes(2);
    provider.assertToolHistory(h.requests[1]!.body);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.finalize).toHaveBeenCalledTimes(finalizes ? 1 : 0);
    expect(h.publish).not.toHaveBeenCalled();
    const events = h.store.events(result.runId);
    expect(events.map(event => event.type)).toEqual([
      'run.started', 'model.started', 'model.completed', 'tool.started', 'state.changed',
      'tool.completed', 'model.started', 'model.completed', 'run.status',
    ]);
    expect(events.at(-1)!.data).toMatchObject({ status: 'failed', code: 'INVALID_OUTPUT' });
    expect(h.store.get(result.runId).status).toBe('failed');
  });
});