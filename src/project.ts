import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import { FrameworkError } from './errors.js';
import { mcpConnectionSchema } from './mcp.js';

// Object.fromEntries preserves own keys such as __proto__ without prototype mutation.
function namedMap<S extends z.ZodType>(valueSchema: S) {
  return z.custom<Record<string, z.input<S>>>(value => Object.prototype.toString.call(value) === '[object Object]')
    .transform((value, context): Record<string, z.output<S>> => {
      const entries: Array<[string, z.output<S>]> = [];
      for (const [name, child] of Object.entries(value)) {
        const parsed = valueSchema.safeParse(child);
        if (!parsed.success) {
          context.addIssue({ code: 'custom', path: [name], message: 'Invalid named configuration value.' });
          return z.NEVER;
        }
        entries.push([name, parsed.data]);
      }
      return Object.fromEntries(entries);
    });
}

const capabilitiesSchema = z.strictObject({
  releaseSnapshots: z.boolean().optional(), persistentState: z.boolean().optional(),
  artifacts: z.boolean().optional(), isolation: z.boolean().optional(),
  resumableRuns: z.boolean().optional(),
});
const environmentSchema = z.strictObject({
  target: z.string().default('local-process'),
  model: z.string().default('default'),
  state: z.strictObject({ path: z.string().min(1) }),
  artifacts: z.strictObject({ path: z.string().min(1) }),
  permissions: z.array(z.string()).optional(),
  providerOptions: namedMap(namedMap(z.json())).optional(),
  variables: namedMap(z.string()).default({}),
  secrets: namedMap(z.strictObject({ env: z.string().min(1) })).default({}),
  requirements: capabilitiesSchema.default({}),
  mcp: namedMap(mcpConnectionSchema).optional(),
});

export const projectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  entry: z.string().min(1),
  defaultEnvironment: z.string().min(1),
  environments: namedMap(environmentSchema),
  tooling: z.strictObject({
    install: z.strictObject({ command: z.string().min(1), args: z.array(z.string()).optional() }).optional(),
    build: z.strictObject({ command: z.string().min(1), args: z.array(z.string()).optional() }).optional(),
    test: z.strictObject({ command: z.string().min(1), args: z.array(z.string()).optional() }).optional(),
    watch: z.array(z.string()).optional(),
  }).optional(),
});
export type ProjectDefinition = z.input<typeof projectSchema>;
export type EnvironmentDefinition = z.output<typeof environmentSchema>;

export const localTargetCapabilities = {
  releaseSnapshots: true, persistentState: true, artifacts: true,
  isolation: false, resumableRuns: false,
} as const;

export function defineProject(project: ProjectDefinition): z.output<typeof projectSchema> {
  return projectSchema.parse(project);
}

export function projectRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (isAbsolute(path) || normalized.split('/').some(part => part === '..') || normalized === '.' || !normalized) {
    throw new FrameworkError('CONFIGURATION_ERROR', `Packaged entry must be relative to its project: ${path}`);
  }
  return normalized.replace(/^\.\//, '');
}

export async function loadProject(file: string, environment?: string) {
  const projectFile = await realpath(resolve(file));
  const raw = await readFile(projectFile, 'utf8');
  const parsed = projectSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new FrameworkError('CONFIGURATION_ERROR', 'Project definition does not match schema version 1.', { cause: parsed.error });
  const project = parsed.data;
  const selected = environment ?? project.defaultEnvironment;
  if (!Object.hasOwn(project.environments, selected)) throw new FrameworkError('CONFIGURATION_ERROR', `Environment ${selected} is not defined.`);
  const settings = project.environments[selected]!;
  if (settings.target !== 'local-process') throw new FrameworkError('CONFIGURATION_ERROR', `No implementation is installed for target ${settings.target}. This release includes local-process.`);
  for (const [capability, required] of Object.entries(settings.requirements)) {
    if (required && !localTargetCapabilities[capability as keyof typeof localTargetCapabilities]) throw new FrameworkError('CAPABILITY_MISMATCH', `Target ${settings.target} does not provide ${capability}.`);
  }
  for (const name of [...Object.keys(settings.variables), ...Object.keys(settings.secrets)]) {
    if (!name || name.includes('=') || name.includes('\0')) throw new FrameworkError('CONFIGURATION_ERROR', `Invalid process environment key: ${name}`);
    if (Object.hasOwn(settings.variables, name) && Object.hasOwn(settings.secrets, name)) throw new FrameworkError('CONFIGURATION_ERROR', `Variable ${name} is defined both as a value and a secret reference.`);
  }
  const root = dirname(projectFile);
  const bindings: EnvironmentDefinition = {
    ...settings,
    state: { path: resolve(root, settings.state.path) },
    artifacts: { path: resolve(root, settings.artifacts.path) },
  };
  if (bindings.state.path === bindings.artifacts.path || isWithin(bindings.state.path, bindings.artifacts.path)) throw new FrameworkError('CONFIGURATION_ERROR', 'State database and artifact directory cannot occupy the same path.');
  return { project, root, projectFile, environment: selected, bindings, entry: projectRelativePath(project.entry), raw };
}

export function isWithin(root: string, path: string): boolean {
  const result = relative(root, path);
  return !result || (!result.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && result !== '..' && !isAbsolute(result));
}

/** Secrets are resolved for the child process only, never serialized in a plan/release. */
export function bindProcessEnvironment(bindings: EnvironmentDefinition, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...source, ...bindings.variables };
  for (const [name, reference] of Object.entries(bindings.secrets)) {
    const value = Object.hasOwn(source, reference.env) ? source[reference.env] : undefined;
    if (value === undefined) throw new FrameworkError('CONFIGURATION_ERROR', `Missing secret environment reference ${reference.env} for ${name}.`);
    Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}