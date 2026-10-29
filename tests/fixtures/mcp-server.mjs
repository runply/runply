import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// The test owns this directory. No sockets, providers, or non-test files are used.
const mode = process.env.MCP_FIXTURE_MODE ?? 'normal';
const record = (event, extra = {}) => {
  if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, JSON.stringify({ event, pid: process.pid, ...extra }) + '\n');
};
record('started', { cwd: process.cwd(), inherited: process.env.MCP_FIXTURE_INHERITED, override: process.env.MCP_FIXTURE_OVERRIDE });
process.on('exit', () => record('exit'));
process.stdin.on('end', () => { record('stdin-end'); process.exit(0); });
if (mode === 'exit') process.exit(7);
if (mode === 'hang-connect') {
  process.stdin.resume();
} else {
  const server = new Server({ name: 'runply-test', version: '1.0.0' }, {
    capabilities: { ...(mode === 'no-tools' ? {} : { tools: {} }), resources: {}, prompts: {} },
  });
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const add = {
    name: 'add', description: 'Add two numbers.',
    inputSchema: {
      type: 'object', properties: { a: { type: 'number' }, b: { type: 'number', default: 10 } },
      required: ['a', 'b'], additionalProperties: false, 'x-test-schema': { retained: true },
    },
    outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  const hang = (extra, label) => new Promise(resolve => {
    record(`${label}-waiting`);
    extra.signal.addEventListener('abort', () => { record(`${label}-aborted`); resolve({}); }, { once: true });
  });
  if (mode !== 'no-tools') server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    record('tools/list', { cursor: request.params?.cursor });
    if (mode === 'hang-list') return hang(extra, 'list');
    if (mode === 'invalid-schema') return { tools: [{ ...add, inputSchema: { type: 'object', required: 42 } }] };
    if (mode === 'compile-error') return { tools: [{ ...add, inputSchema: { type: 'object', properties: { a: { type: 'invalid' } } } }] };
    if (mode === 'cycle') return { tools: [], nextCursor: 'loop' };
    if (mode === 'duplicate') return { tools: [add, add] };
    if (request.params?.cursor === undefined) return { tools: [add], nextCursor: 'page-two' };
    if (request.params.cursor !== 'page-two') throw new Error('Unexpected tools cursor');
    return { tools: [
      { name: 'echo', inputSchema: { type: 'object', additionalProperties: true } },
      { name: 'fail', inputSchema: empty }, { name: 'slow', inputSchema: empty },
      { name: 'bad-output', inputSchema: empty, outputSchema: add.outputSchema },
      { name: 'modern', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
        properties: { tuple: { type: 'array', prefixItems: [{ type: 'number' }], items: false } }, required: ['tuple'] } },
    ] };
  });
  if (mode !== 'no-tools') server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: input } = request.params;
    record('tools/call', { name, input, signalAborted: extra.signal.aborted });
    if (name === 'slow') return hang(extra, 'call');
    if (name === 'fail') return { isError: true, content: [{ type: 'text', text: 'synthetic failure' }], structuredContent: { reason: 'test' } };
    if (name === 'bad-output') return { content: [], structuredContent: { sum: 'wrong' } };
    if (name === 'add') {
      const sum = mode === 'bad-first-output' ? 'wrong' : input.a + input.b;
      return { content: [{ type: 'text', text: String(sum) }], structuredContent: { sum }, _meta: { fixture: true } };
    }
    if (name === 'echo' || name === 'modern') return { content: [], structuredContent: input };
    throw new Error(`Unknown tool: ${name}`);
  });
  server.setRequestHandler(ListResourcesRequestSchema, request => {
    record('resources/list', { cursor: request.params?.cursor });
    return request.params?.cursor === 'next-resource'
      ? { resources: [{ uri: 'fixture:///second', name: 'Second' }] }
      : { resources: [{ uri: 'fixture:///readme', name: 'Readme', mimeType: 'text/plain' }], nextCursor: 'next-resource' };
  });
  server.setRequestHandler(ReadResourceRequestSchema, request => {
    record('resources/read');
    return { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'fixture resource' }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: 'greet', arguments: [{ name: 'name', required: true }] }] }));
  server.setRequestHandler(GetPromptRequestSchema, request => ({
    description: 'Fixture prompt', messages: [{ role: 'user', content: { type: 'text', text: `Hello ${request.params.arguments?.name}` } }],
  }));
  server.onclose = () => record('closed');
  await server.connect(new StdioServerTransport());
}