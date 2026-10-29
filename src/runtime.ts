import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { generateText, isLoopFinished, isStepCount, tool, jsonSchema } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ToolSet } from 'ai';
import type { Application, RunEvent, RunRecord, RunState, RuntimeOptions, RunComponent } from './contracts.js';
import { abortable, FrameworkError, normalizeError } from './errors.js';
import { parseProviderOptions } from './model.js';

export interface RunResult<O> {
  runId: string;
  status: RunRecord['status'];
  output?: O;
  artifacts: Awaited<ReturnType<RuntimeOptions['workspace']['publish']>>;
  error?: FrameworkError;
}

/** Applies to structured values only; content capture is opt-in for this reason. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, /password|secret|authorization|api[_-]?key|access[_-]?token|cookie/i.test(key) ? '[REDACTED]' : redactSecrets(child),
    ]));
  }
  return value;
}

export const harnessCapabilities = {
  id: 'ai-sdk-tool-loop', tokenStreaming: false, nativeStructuredOutput: false,
  approvals: 'in-process', continuation: false, toolExecution: 'serial',
} as const;

export function validateCapabilities<I, O>(application: Application<I, O>, options: Pick<RuntimeOptions, 'model' | 'workspace' | 'maxSteps' | 'timeoutMs'>): void {
  if (application.requirements?.streaming || application.requirements?.structuredOutput) {
    throw new FrameworkError('CAPABILITY_MISMATCH', 'This harness supports JSON validation after generation, not token streaming or native schema-constrained output.');
  }
  const requirements = { ...application.requirements, ...(Object.keys(application.tools).length ? { tools: true } : {}) };
  for (const [key, required] of Object.entries(requirements)) {
    if (required && !options.model.capabilities[key as keyof typeof options.model.capabilities]) {
      throw new FrameworkError('CAPABILITY_MISMATCH', `Model adapter ${options.model.id} does not declare ${key}. Select an adapter that does.`);
    }
  }
  for (const [key, required] of Object.entries(application.workspaceRequirements ?? {})) {
    if (required && !options.workspace.capabilities[key as keyof typeof options.workspace.capabilities]) {
      throw new FrameworkError('CAPABILITY_MISMATCH', `Workspace does not provide ${key}. Select a workspace with this capability.`);
    }
  }
  if (options.maxSteps !== undefined && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1)) {
    throw new FrameworkError('CONFIGURATION_ERROR', 'maxSteps must be a positive safe integer when configured.');
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)) {
    throw new FrameworkError('CONFIGURATION_ERROR', 'timeoutMs must fit the Node timer range: 1..2147483647 milliseconds.');
  }
}

/** Callers own the supplied store and workspace; the runtime owns only this run. */
export async function runApplication<I, O>(application: Application<I, O>, input: unknown, options: RuntimeOptions): Promise<RunResult<O>> {
  const id = randomUUID();
  const owner = JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() });
  let run = options.store.create({ id, owner, application: application.name, model: options.model.id, ...(options.release ? { release: options.release } : {}) });
  let terminal = false;
  let stepId: string | undefined;
  let modelStep = 0;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const externalInFlight = new Set<string>();
  const usedCallIds = new Set<string>();
  const pendingCalls = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fatal: FrameworkError | undefined;
  let publicationInFlight = false;
  const artifacts: RunResult<O>['artifacts'] = [];
  const acquired: Array<{ id: string; resource: Awaited<ReturnType<RunComponent['open']>> }> = [];
  const applicationTools = { ...application.tools };
  const sanitize = (value: unknown) => redactSecrets(options.redact ? options.redact(value) : value);
  const content = (value: unknown) => options.captureContent ? sanitize(value) : { omitted: true };
  const emit = (type: RunEvent['type'], data: unknown, eventStep = stepId, parentId?: string, status?: RunRecord['status']) => {
    if (terminal) return;
    run = options.store.append(id, owner, run.version, { type, data: sanitize(data), stepId: eventStep, parentId }, status);
  };
  const finish = (status: RunRecord['status'], data: unknown) => {
    emit('run.status', { status, ...data as object }, undefined, undefined, status);
    terminal = true;
  };
  const values = new Map<string, unknown>();
  const state: RunState = {
    get(key) { return structuredClone(values.get(key)); },
    set(key, value) {
      signal.throwIfAborted();
      const snapshot: unknown = JSON.parse(JSON.stringify(value));
      emit('state.changed', { key, value: content(snapshot) });
      values.set(key, snapshot);
    },
  };
  const closeComponents = async () => {
    const errors: unknown[] = [];
    for (const entry of acquired.splice(0).reverse()) {
      try { await entry.resource.close(); emit('component.closed', { component: entry.id }); }
      catch (error) { errors.push(error); emit('component.failed', { component: entry.id, phase: 'close' }); }
    }
    if (errors.length) throw new FrameworkError('TOOL_ERROR', 'Component cleanup failed.', { cause: new AggregateError(errors) });
  };

  try {
    emit('run.started', { input: content(input), model: options.model.id, capabilities: options.model.capabilities, continuation: false, retries: 0, ...(options.release ? { release: options.release } : {}) });
    validateCapabilities(application, options);
    const parsed = application.inputSchema.safeParse(input);
    if (!parsed.success) throw new FrameworkError('INVALID_INPUT', 'Application input does not match its schema.', { cause: parsed.error });
    const extensionOptions = parseProviderOptions(options.model, options.providerOptions);
    if (options.timeoutMs !== undefined) timer = setTimeout(() => controller.abort(new FrameworkError('TIMED_OUT', 'Run exceeded the configured timeout.')), options.timeoutMs);
    if (signal.aborted) throw new FrameworkError('CANCELLED', 'Run cancelled before execution.');

    const componentIds = new Set<string>();
    for (const component of options.components ?? []) {
      if (componentIds.has(component.id)) throw new FrameworkError('CONFLICT', `Duplicate component ${component.id}.`);
      componentIds.add(component.id);
      emit('component.connecting', { component: component.id });
      try {
        const opening = component.open({ runId: id, signal });
        let adopted = false;
        const resource = await abortable(opening, signal).catch(error => {
          void opening.then(async late => { if (!adopted) await late.close(); }).catch(() => {});
          throw error;
        });
        acquired.push({ id: component.id, resource }); adopted = true;
        for (const [name, definition] of Object.entries(resource.tools)) {
          if (Object.hasOwn(applicationTools, name)) throw new FrameworkError('CONFLICT', `Component tool name collides with an existing tool: ${name}.`);
          Object.defineProperty(applicationTools, name, { value: definition, enumerable: true, configurable: true, writable: true });
        }
        emit('component.ready', { component: component.id, tools: Object.keys(resource.tools) });
      } catch (error) { const failure = normalizeError(error, 'TOOL_UNAVAILABLE'); emit('component.failed', { component: component.id, phase: 'open', code: failure.code }); throw failure; }
    }
    validateCapabilities({ ...application, tools: applicationTools }, options);

    const tools: ToolSet = Object.create(null) as ToolSet;
    for (const [name, definition] of Object.entries(applicationTools)) {
      tools[name] = tool({
        description: definition.description,
        inputSchema: definition.inputJsonSchema ? jsonSchema(definition.inputJsonSchema) : definition.inputSchema,
        execute: async (toolInput: unknown, invocation) => {
          const callId = invocation.toolCallId;
          try {
            signal.throwIfAborted();
            if (fatal) throw fatal;
            const missing = definition.permissions.filter(permission => !options.permissions?.includes(permission));
            if (missing.length) throw new FrameworkError('PERMISSION_DENIED', `Tool ${name} requires permissions: ${missing.join(', ')}.`);
            if (definition.approval) {
              emit('approval.requested', { tool: name, input: content(toolInput), toolCallId: callId }, callId, stepId, 'waiting_approval');
              if (!options.approve) throw new FrameworkError('APPROVAL_REQUIRED', `Tool ${name} needs an application approval handler.`);
              const accepted = await abortable(options.approve({ runId: id, toolCallId: callId, tool: name, input: toolInput, signal }), signal);
              if (!accepted) throw new FrameworkError('PERMISSION_DENIED', `Tool ${name} was not approved.`);
              emit('run.status', { status: 'running', approvedToolCallId: callId }, callId, stepId, 'running');
            }
            signal.throwIfAborted();
            emit('tool.started', { tool: name, input: content(toolInput), sideEffect: definition.sideEffect, idempotent: definition.idempotent }, callId, stepId);
            if (definition.sideEffect === 'external') externalInFlight.add(callId);
            const output = await definition.invoke(toolInput, { runId: id, toolCallId: callId, signal, input: parsed.data, state });
            signal.throwIfAborted();
            emit('tool.completed', { tool: name, output: content(output) }, callId, stepId);
            externalInFlight.delete(callId);
            pendingCalls.delete(callId);
            return output;
          } catch (error) {
            fatal = signal.aborted
              ? signal.reason instanceof FrameworkError ? signal.reason : new FrameworkError('CANCELLED', 'Run cancelled.', { cause: signal.reason })
              : normalizeError(error, 'TOOL_ERROR');
            emit('tool.failed', { tool: name, code: fatal.code, outcome: externalInFlight.has(callId) ? 'unknown' : 'not_completed' }, callId, stepId);
            controller.abort(fatal);
            throw fatal;
          }
        },
      });
    }

    const delegate = options.model.model;
    const observedModel: LanguageModelV4 = {
      specificationVersion: 'v4', provider: delegate.provider, modelId: delegate.modelId, supportedUrls: delegate.supportedUrls,
      async doGenerate(call) {
        signal.throwIfAborted();
        if (fatal) throw fatal;
        if (pendingCalls.size) throw new FrameworkError('TOOL_ERROR', 'A requested tool did not complete; the run cannot continue.');
        stepId = `model-${++modelStep}`;
        const currentStep = stepId;
        const started = performance.now();
        emit('model.started', { provider: delegate.provider, model: delegate.modelId, messages: content(call.prompt) }, currentStep);
        try {
          const result = await abortable(delegate.doGenerate({ ...call, abortSignal: signal }), signal);
          const unsupported = result.warnings.filter(warning => warning.type === 'unsupported' || warning.type === 'compatibility');
          if (unsupported.length) throw new FrameworkError('UNSUPPORTED_OPTIONS', 'Provider reported unsupported or compatibility-mode options. No tools were executed from this response.');
          for (const part of result.content) {
            if (part.type !== 'tool-call') continue;
            if (part.providerExecuted) throw new FrameworkError('CAPABILITY_MISMATCH', 'This harness requires application-controlled tool execution; provider-executed calls cannot be authorized locally.');
            if (!Object.hasOwn(applicationTools, part.toolName)) throw new FrameworkError('TOOL_UNAVAILABLE', `Model requested unavailable tool ${part.toolName}.`);
            if (usedCallIds.has(part.toolCallId)) throw new FrameworkError('TOOL_ERROR', 'Duplicate tool call ID; refusing implicit re-execution.');
            usedCallIds.add(part.toolCallId);
            pendingCalls.add(part.toolCallId);
            const definition = applicationTools[part.toolName]!;
            let toolInput: unknown;
            try { toolInput = JSON.parse(part.input); } catch (error) { throw new FrameworkError('INVALID_INPUT', `Model produced malformed arguments for ${part.toolName}.`, { cause: error }); }
            if (!definition.inputSchema.safeParse(toolInput).success) throw new FrameworkError('INVALID_INPUT', `Model arguments do not match tool ${part.toolName}.`);
          }
          emit('model.completed', {
            durationMs: performance.now() - started, finishReason: result.finishReason,
            usage: { inputTokens: result.usage.inputTokens.total ?? null, outputTokens: result.usage.outputTokens.total ?? null },
            content: content(result.content), warnings: result.warnings,
          }, currentStep);
          return result;
        } catch (error) {
          emit('model.failed', { code: normalizeError(error).code, durationMs: performance.now() - started }, currentStep);
          throw error;
        }
      },
      doStream() { throw new FrameworkError('CAPABILITY_MISMATCH', 'This first harness uses non-streaming generation. Token streaming is not implemented.'); },
    };
    const result = await abortable(generateText({
      model: observedModel,
      messages: application.messages(parsed.data),
      allowSystemInMessages: true,
      tools,
      toolCallConcurrency: 1,
      stopWhen: options.maxSteps === undefined ? isLoopFinished() : isStepCount(options.maxSteps),
      maxRetries: 0,
      abortSignal: signal,
      providerOptions: extensionOptions,
    }), signal);
    if (fatal) throw fatal;
    signal.throwIfAborted();
    if (pendingCalls.size) throw new FrameworkError('TOOL_ERROR', 'One or more requested tools did not complete.');
    if (result.finishReason === 'tool-calls') throw new FrameworkError('STEP_LIMIT', 'Configured step limit reached before a final response.');
    if (result.finishReason !== 'stop') throw new FrameworkError('MODEL_ERROR', `Generation ended with ${result.finishReason}, not a complete response.`);
    let decoded: unknown;
    try { decoded = JSON.parse(result.text); } catch (error) { throw new FrameworkError('INVALID_OUTPUT', 'Model response is not a JSON value.', { cause: error }); }
    const output = application.outputSchema.safeParse(decoded);
    if (!output.success) throw new FrameworkError('INVALID_OUTPUT', 'Model response does not match the application output schema.', { cause: output.error });
    const rendered = await abortable(Promise.resolve(application.finalize(output.data, { input: parsed.data, state, signal })), signal);
    signal.throwIfAborted();
    publicationInFlight = true;
    artifacts.push(...await abortable(options.workspace.publish(id, rendered), signal));
    for (const artifact of artifacts) emit('artifact.created', artifact, undefined);
    publicationInFlight = false;
    signal.throwIfAborted();
    await closeComponents();
    signal.throwIfAborted();
    finish('succeeded', { output: content(output.data), artifactCount: artifacts.length });
    return { runId: id, status: run.status, output: output.data, artifacts };
  } catch (caught) {
    try { await closeComponents(); } catch (cleanupError) { if (!fatal) fatal = normalizeError(cleanupError, 'TOOL_ERROR'); }
    const error = fatal ?? (signal.aborted
      ? signal.reason instanceof FrameworkError ? signal.reason : new FrameworkError('CANCELLED', 'Run cancelled.')
      : normalizeError(caught));
    const status = externalInFlight.size || publicationInFlight ? 'interrupted' : error.code === 'CANCELLED' ? 'cancelled' : 'failed';
    finish(status, { code: error.code, message: caught instanceof FrameworkError ? error.message : 'Component execution failed. Inspect the returned error cause.', uncertainToolCalls: [...externalInFlight], artifactPublication: publicationInFlight ? 'unknown' : 'settled' });
    return { runId: id, status: run.status, artifacts, error };
  } finally {
    terminal = true;
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new FrameworkError('CANCELLED', 'Run has ended.'));
    await closeComponents();
  }
}