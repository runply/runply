import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Application, ModelAdapter, RuntimeOptions, RunComponent } from './contracts.js';
import type { EnvironmentDefinition } from './project.js';
import { FrameworkError } from './errors.js';
import { createMcpComponent } from './mcp.js';

export interface ApplicationConfiguration {
  application: Application;
  model: ModelAdapter;
  /** A composition registry; business application code need not change between environments. */
  models?: Record<string, ModelAdapter>;
  input: unknown;
  permissions?: readonly string[];
  providerOptions?: RuntimeOptions['providerOptions'];
  components?: readonly RunComponent[];
}

export async function loadApplicationConfiguration(path: string, bindings?: EnvironmentDefinition): Promise<ApplicationConfiguration> {
  const imported = await import(pathToFileURL(resolve(path)).href) as { default?: ApplicationConfiguration };
  const config = imported.default;
  if (!config?.application || !config.model) throw new FrameworkError('CONFIGURATION_ERROR', 'App module must default-export { application, model, input, permissions? }.');
  if (!bindings) return config;
  const model = bindings.model === 'default' ? config.model : Object.hasOwn(config.models ?? {}, bindings.model) ? config.models![bindings.model] : undefined;
  if (!model) throw new FrameworkError('CONFIGURATION_ERROR', `Model binding ${bindings.model} is not registered by the application composition.`);
  return {
    ...config, model,
    permissions: bindings.permissions ?? config.permissions,
    providerOptions: bindings.providerOptions ?? config.providerOptions,
    components: [...config.components ?? [], ...Object.entries(bindings.mcp ?? {}).map(([id, options]) => createMcpComponent(id, options))],
  };
}