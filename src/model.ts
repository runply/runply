import { z } from 'zod';
import type { ModelAdapter, ModelCapabilities } from './contracts.js';
import type { LanguageModelV4, SharedV4ProviderOptions as ProviderOptions } from '@ai-sdk/provider';
import { FrameworkError } from './errors.js';

function droppedKey(input: unknown, output: unknown, path = ''): string | undefined {
  if (!input || typeof input !== 'object') return;
  for (const key of Object.keys(input)) {
    const name = path ? `${path}.${key}` : key;
    if (!output || typeof output !== 'object' || !Object.hasOwn(output, key)) return name;
    const nested = droppedKey((input as Record<string, unknown>)[key], (output as Record<string, unknown>)[key], name);
    if (nested) return nested;
  }
}

export function parseProviderOptions(adapter: ModelAdapter, options: ProviderOptions = {}): ProviderOptions {
  const parsed = adapter.providerOptionsSchema.safeParse(options);
  if (!parsed.success) throw new FrameworkError('UNSUPPORTED_OPTIONS', `Provider options do not match adapter ${adapter.id}. Nothing was sent.`, { cause: parsed.error });
  const missing = droppedKey(options, parsed.data);
  if (missing) throw new FrameworkError('UNSUPPORTED_OPTIONS', `Adapter schema would silently drop option ${missing}. Nothing was sent.`);
  return parsed.data;
}

/** Provider-native options stay available, but need an explicit validation schema. */
export function aiSdkModel(options: {
  id: string;
  model: LanguageModelV4;
  capabilities: ModelCapabilities;
  providerOptionsSchema?: z.ZodType<ProviderOptions>;
}): ModelAdapter {
  return { ...options, providerOptionsSchema: options.providerOptionsSchema ?? z.strictObject({}) };
}