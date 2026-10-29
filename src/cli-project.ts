import { readFile, writeFile, open } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { loadProject, projectSchema } from './project.js';
import { defaultProjectFile } from './releases.js';
import { mcpConnectionSchema, type McpConnectionOptions } from './mcp.js';
import { FrameworkError } from './errors.js';
import type { SourceInvocation } from './source-run.js';

export async function sourceInvocation(projectFile = defaultProjectFile, environment?: string): Promise<SourceInvocation> {
  const loaded = await loadProject(projectFile, environment);
  return { app: join(loaded.root, loaded.entry), root: loaded.root, bindings: loaded.bindings, database: loaded.bindings.state.path, artifacts: loaded.bindings.artifacts.path };
}

/** A short local edit lock protects framework edits; never overwrites an already named connection. */
export async function addMcp(projectFile: string, environment: string | undefined, id: string, options: McpConnectionOptions) {
  if (!id) throw new FrameworkError('CONFIGURATION_ERROR', 'MCP connection name is required.');
  const file = resolve(projectFile);
  const lockPath = `${file}.edit-lock`;
  const lock = await open(lockPath, 'wx').catch(error => { throw new FrameworkError('CONFLICT', 'Project is already being edited; no changes made.', { cause: error }); });
  try {
    const before = await readFile(file, 'utf8');
    const raw = JSON.parse(before) as Record<string, unknown>;
    const project = projectSchema.parse(raw);
    const selected = environment ?? project.defaultEnvironment;
    const bindings = project.environments[selected];
    if (!bindings || !Object.hasOwn(project.environments, selected)) throw new FrameworkError('CONFIGURATION_ERROR', `Environment ${selected} is not defined.`);
    if (Object.hasOwn(bindings.mcp ?? {}, id)) throw new FrameworkError('CONFLICT', `MCP connection ${id} already exists.`);
    const validated = mcpConnectionSchema.parse(options);
    const environments = raw.environments as Record<string, Record<string, unknown>>;
    const target = environments[selected]!;
    target.mcp = { ...target.mcp as object, [id]: validated };
    projectSchema.parse(raw);
    if (await readFile(file, 'utf8') !== before) throw new FrameworkError('CONFLICT', 'Project changed during the edit; no changes made.');
    await writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    return { added: id, environment: selected, project: file, status: 'configured; not connected', transport: validated.transport };
  } finally {
    await lock.close();
    const { unlink } = await import('node:fs/promises'); await unlink(lockPath);
  }
}