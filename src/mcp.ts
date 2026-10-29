import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC, type RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ErrorCode as McpErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import type { AppTool, RunComponent } from './contracts.js';
import { FrameworkError, type ErrorCode } from './errors.js';
import { brand } from './brand.js';

const processString = z.string().refine(value => !value.includes('\0'), 'NUL is not a process argument.');
const policy = {
  permissions: z.array(z.string()).default([]),
  approval: z.boolean().default(false),
  sideEffect: z.enum(['none', 'external']).default('external'),
  idempotent: z.boolean().default(false),
  timeoutMs: z.number().int().positive().optional(),
};

export const mcpConnectionSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: processString.refine(value => value.trim().length > 0, 'Command must not be empty.'),
    args: z.array(processString).optional(),
    cwd: processString.refine(isAbsolute, 'Pass an absolute cwd from the caller.').optional(),
    env: z.record(z.string(), processString).optional(),
    ...policy,
  }),
  z.strictObject({
    transport: z.literal('http'),
    url: z.string().refine(value => {
      try { return ['http:', 'https:'].includes(new URL(value).protocol); }
      catch { return false; }
    }, 'Expected an HTTP or HTTPS URL.'),
    headers: z.record(z.string(), z.strictObject({ env: z.string().min(1) })).optional(),
    ...policy,
  }),
]);

export type McpConnectionOptions = z.input<typeof mcpConnectionSchema>;

export interface McpAppTool extends AppTool {
  /** Remote metadata is informational. Only the local options set execution policy. */
  mcp: Tool;
}

type SignalOptions = { signal?: AbortSignal };
export interface McpConnection {
  tools: Record<string, McpAppTool>;
  /** These are native paginated MCP APIs; pass nextCursor as params.cursor. */
  listResources(params?: Parameters<Client['listResources']>[0], options?: SignalOptions): ReturnType<Client['listResources']>;
  readResource(params: Parameters<Client['readResource']>[0], options?: SignalOptions): ReturnType<Client['readResource']>;
  listPrompts(params?: Parameters<Client['listPrompts']>[0], options?: SignalOptions): ReturnType<Client['listPrompts']>;
  getPrompt(params: Parameters<Client['getPrompt']>[0], options?: SignalOptions): ReturnType<Client['getPrompt']>;
  close(): Promise<void>;
}

function parseOptions(options: McpConnectionOptions): z.output<typeof mcpConnectionSchema> {
  const result = mcpConnectionSchema.safeParse(options);
  if (!result.success) throw new FrameworkError('CONFIGURATION_ERROR', 'Invalid MCP connection options.', { cause: result.error });
  return result.data;
}

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const dialect = schema.$schema;
  const Constructor = typeof dialect === 'string' && dialect.includes('/2020-12/') ? Ajv2020
    : typeof dialect === 'string' && dialect.includes('/2019-09/') ? Ajv2019 : Ajv;
  // Formats are annotations, as in JSON Schema's default vocabulary. Never mutate input.
  const ajv = new Constructor({ strict: false, validateFormats: false, allErrors: true,
    coerceTypes: false, removeAdditional: false, useDefaults: false });
  const validate = ajv.compile(structuredClone(schema));
  if ('$async' in validate && validate.$async) throw new Error('Asynchronous JSON schemas cannot validate MCP arguments synchronously.');
  return validate;
}

function cancelled(signal: AbortSignal, label: string): FrameworkError {
  if (signal.reason instanceof FrameworkError) return signal.reason;
  const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return new FrameworkError(timedOut ? 'TIMED_OUT' : 'CANCELLED', `MCP ${label} ${timedOut ? 'timed out' : 'was cancelled'}.`, { cause: signal.reason });
}

/** Opens one owned connection. Stdio inherits process privileges and is not a sandbox. */
export async function openMcpConnection(
  id: string,
  options: McpConnectionOptions,
  context: { signal: AbortSignal; runId?: string },
): Promise<McpConnection> {
  const config = parseOptions(options);
  if (context.signal.aborted) throw cancelled(context.signal, id);
  // Resolve all secrets before constructing a transport, let alone sending a request.
  const headers = new Headers();
  if (config.transport === 'http') {
    for (const [name, ref] of Object.entries(config.headers ?? {})) {
      const value = process.env[ref.env];
      if (value === undefined) throw new FrameworkError('CONFIGURATION_ERROR', `Missing MCP header environment variable ${ref.env}.`);
      try { headers.set(name, value); }
      catch (error) { throw new FrameworkError('CONFIGURATION_ERROR', `Invalid MCP header ${name}.`, { cause: error }); }
    }
  }
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = config.transport === 'stdio'
    ? new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...inherited, ...config.env } })
    : new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 30000, reconnectionDelayGrowFactor: 1.5 },
    });
  // The SDK can call close without awaiting it after failed initialization. Share that
  // exact promise so our rejection cannot precede cleanup of the partially started child.
  const originalClose = transport.close.bind(transport);
  let transportClosing: Promise<void> | undefined;
  transport.close = () => transportClosing ??= originalClose();
  const client = new Client({ name: brand.packageName, version: '0.3.0' });
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      context.signal.removeEventListener('abort', abort);
      closing = transport.close().catch(error => {
        throw new FrameworkError('TOOL_UNAVAILABLE', `MCP ${id} close failed.`, { cause: error });
      });
    }
    return closing;
  };
  const abort = () => {
    lifetime.abort(cancelled(context.signal, id));
    void close().catch(() => {}); // Awaited by the operation or the owner's close().
  };
  context.signal.addEventListener('abort', abort, { once: true });
  client.onerror = error => {
    if (closing) return;
    lifetime.abort(new FrameworkError('TOOL_UNAVAILABLE', `MCP ${id} transport failed: ${error.message}`, { cause: error }));
    void close().catch(() => {});
  };

  async function perform<T>(label: string, fallback: ErrorCode, work: (options: RequestOptions) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const forwardLifetime = () => controller.abort(lifetime.signal.reason);
    const forwardRequest = () => controller.abort(cancelled(signal!, `${id} ${label}`));
    lifetime.signal.addEventListener('abort', forwardLifetime, { once: true });
    signal?.addEventListener('abort', forwardRequest, { once: true });
    if (lifetime.signal.aborted) forwardLifetime();
    if (signal?.aborted) forwardRequest();
    const timeout = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    const timer = setTimeout(() => controller.abort(new FrameworkError('TIMED_OUT', `MCP ${id} ${label} timed out after ${timeout}ms.`)), timeout);
    let onAbort: () => void = () => {};
    try {
      controller.signal.throwIfAborted();
      if (closing) throw new FrameworkError('TOOL_UNAVAILABLE', `MCP ${id} connection is closed.`);
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      // The race also covers transport.start() and initialized notifications, which
      // Client.connect's request signal alone does not cover.
      const result = await Promise.race([work({ signal: controller.signal, timeout }), interrupted]);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      const failure = controller.signal.aborted ? cancelled(controller.signal, `${id} ${label}`)
        : error instanceof FrameworkError ? error
          : new FrameworkError(error instanceof McpError && error.code === McpErrorCode.RequestTimeout ? 'TIMED_OUT' : fallback,
            `MCP ${id} ${label} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      try { await close(); }
      catch (cleanupError) { throw new FrameworkError(failure.code, failure.message, { cause: new AggregateError([failure, cleanupError], 'MCP operation and cleanup failed.') }); }
      throw failure;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      lifetime.signal.removeEventListener('abort', forwardLifetime);
      signal?.removeEventListener('abort', forwardRequest);
    }
  }

  if (context.signal.aborted) abort();
  await perform('connect', 'TOOL_UNAVAILABLE', request => client.connect(transport, request));
  const tools: Record<string, McpAppTool> = Object.create(null) as Record<string, McpAppTool>;
  await perform('tools/list', 'TOOL_UNAVAILABLE', async request => {
    if (!client.getServerCapabilities()?.tools) return;
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, request);
      for (const remote of page.tools) {
        const name = `${id}__${remote.name}`;
        if (Object.hasOwn(tools, name)) throw new FrameworkError('CONFLICT', `MCP ${id} advertised duplicate tool ${remote.name}.`);
        let validate: ValidateFunction;
        let validateOutput: ValidateFunction | undefined;
        try {
          validate = compileSchema(remote.inputSchema);
          if (remote.outputSchema) validateOutput = compileSchema(remote.outputSchema);
        } catch (error) { throw new FrameworkError('CONFIGURATION_ERROR', `MCP ${name} has an invalid JSON schema.`, { cause: error }); }
        const inputSchema = z.unknown().superRefine((value, ctx) => {
          if (!validate(value)) ctx.addIssue({ code: 'custom', message: `Invalid MCP input: ${JSON.stringify(validate.errors)}` });
        });
        tools[name] = {
          description: remote.description ?? remote.name,
          inputSchema,
          inputJsonSchema: remote.inputSchema as AppTool['inputJsonSchema'],
          mcp: remote,
          permissions: [...config.permissions], approval: config.approval,
          sideEffect: config.sideEffect, idempotent: config.idempotent,
          invoke: (input, toolContext) => perform(`tools/call ${remote.name}`, 'TOOL_ERROR', async callOptions => {
            const parsed = inputSchema.safeParse(input);
            if (!parsed.success) throw new FrameworkError('INVALID_INPUT', `Invalid input for MCP tool ${name}.`, { cause: parsed.error });
            if (remote.execution?.taskSupport === 'required') throw new FrameworkError('TOOL_ERROR', `MCP tool ${name} requires the SDK task API; synchronous invocation is unavailable.`);
            const result = await client.callTool({ name: remote.name, arguments: input as Record<string, unknown> }, undefined, callOptions);
            if (result.isError) throw new FrameworkError('TOOL_ERROR', `MCP tool ${name} returned isError.`, { cause: result });
            // listTools resets the SDK output-validator cache for each page. Validate
            // here as well so earlier pages receive the same checks as the last page.
            if (validateOutput && !validateOutput(result.structuredContent)) {
              throw new FrameworkError('TOOL_ERROR', `MCP tool ${name} returned invalid structuredContent.`, { cause: result });
            }
            return result;
          }, toolContext.signal),
        };
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new FrameworkError('TOOL_UNAVAILABLE', `MCP ${id} repeated a tools/list cursor.`);
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  });
  return {
    tools,
    listResources: (params, request) => perform('resources/list', 'TOOL_ERROR', opts => client.listResources(params, opts), request?.signal),
    readResource: (params, request) => perform('resources/read', 'TOOL_ERROR', opts => client.readResource(params, opts), request?.signal),
    listPrompts: (params, request) => perform('prompts/list', 'TOOL_ERROR', opts => client.listPrompts(params, opts), request?.signal),
    getPrompt: (params, request) => perform('prompts/get', 'TOOL_ERROR', opts => client.getPrompt(params, opts), request?.signal),
    close,
  };
}

/** Configuration only. No process, network request, or tool call occurs until open(). */
export function createMcpComponent(id: string, options: McpConnectionOptions): RunComponent {
  const config = parseOptions(options);
  return { id, open: context => openMcpConnection(id, config, context) };
}