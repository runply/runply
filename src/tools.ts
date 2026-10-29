import type { ZodType } from 'zod';
import type { AppTool, ToolContext } from './contracts.js';
import { FrameworkError } from './errors.js';

export function defineTool<I, O>(definition: {
  description: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  sideEffect: AppTool['sideEffect'];
  idempotent: boolean;
  permissions?: readonly string[];
  approval?: boolean;
  execute(input: I, context: ToolContext): Promise<O> | O;
}): AppTool {
  return {
    ...definition,
    permissions: definition.permissions ?? [],
    approval: definition.approval ?? false,
    async invoke(input, context) {
      context.signal.throwIfAborted();
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) throw new FrameworkError('INVALID_INPUT', 'Tool input does not match its schema.', { cause: parsed.error });
      const value = await definition.execute(parsed.data, context);
      context.signal.throwIfAborted();
      const output = definition.outputSchema.safeParse(value);
      if (!output.success) throw new FrameworkError('INVALID_OUTPUT', 'Tool output does not match its schema.', { cause: output.error });
      return output.data;
    },
  };
}

export function defineApplication<I, O>(application: import('./contracts.js').Application<I, O>) {
  return application;
}