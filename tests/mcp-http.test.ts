import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openMcpConnection } from '../src/mcp.js';

it('uses the official Streamable HTTP transport on loopback with header references and real tool calls', async () => {
  const protocol = new Server({ name: 'local-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  protocol.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'double', inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } }] }));
  protocol.setRequestHandler(CallToolRequestSchema, request => ({ content: [{ type: 'text', text: String(Number(request.params.arguments?.value) * 2) }], structuredContent: { result: Number(request.params.arguments?.value) * 2 } }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await protocol.connect(transport);
  const headers: Array<string | undefined> = [];
  const http = createServer((request, response) => {
    headers.push(request.headers.authorization);
    void transport.handleRequest(request, response).catch(error => { response.statusCode = 500; response.end(String(error)); });
  });
  await new Promise<void>(accept => http.listen(0, '127.0.0.1', accept));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No port');
  vi.stubEnv('RUNPLY_TEST_HTTP_TOKEN', 'Bearer synthetic-test-token');
  let connection: Awaited<ReturnType<typeof openMcpConnection>> | undefined;
  try {
    const signal = new AbortController().signal;
    connection = await openMcpConnection('remote', { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: { env: 'RUNPLY_TEST_HTTP_TOKEN' } } }, { signal });
    const result = await connection.tools.remote__double!.invoke({ value: 21 }, { runId: 'local', toolCallId: 'double-1', signal, input: {}, state: { get: () => undefined, set: () => {} } });
    expect(result).toMatchObject({ content: [{ type: 'text', text: '42' }], structuredContent: { result: 42 } });
    expect(headers.length).toBeGreaterThanOrEqual(3);
    expect(headers.every(value => value === 'Bearer synthetic-test-token')).toBe(true);
  } finally {
    await connection?.close(); await protocol.close();
    await new Promise<void>(accept => { http.close(() => accept()); http.closeAllConnections(); });
    vi.unstubAllEnvs();
  }
});