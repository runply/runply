import { spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { FrameworkError } from './errors.js';
import { brand } from './brand.js';

export type ToolingCommand = { command: string; args?: string[] };
export type ToolingConfiguration = {
  install?: ToolingCommand;
  build?: ToolingCommand;
  test?: ToolingCommand;
  watch?: string[];
};

const argument = z.string().refine(value => !value.includes('\0'), 'NUL is not a process argument.');
const commandSchema = z.strictObject({ command: argument.refine(value => value.trim().length > 0), args: z.array(argument).optional() });
const toolingSchema = z.strictObject({
  install: commandSchema.optional(), build: commandSchema.optional(), test: commandSchema.optional(),
  watch: z.array(z.string()).optional(),
});
const packageSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

function configurationError(message: string, cause?: unknown): FrameworkError {
  return new FrameworkError('CONFIGURATION_ERROR', message, { cause });
}

async function jsonFile(path: string, optional = false): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw configurationError(`Cannot read JSON from ${path}.`, error);
  }
}

// Only inspect executable positions, not quoted messages or JavaScript source arguments.
// This is deliberately not a shell evaluator: dynamic commands cannot be proved cyclic here.
function scriptCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = '', started = false, quote = '';
  const flushWord = () => { if (started) words.push(word); word = ''; started = false; };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < script.length; i++) {
    const char = script[i]!;
    if (char === '\\' && quote !== "'") { word += script[++i] ?? ''; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '#' && !started) { while (i < script.length && script[i] !== '\n') i++; flushCommand(); continue; }
    if (';&|\n'.includes(char)) { flushCommand(); continue; }
    if (/\s/.test(char)) { flushWord(); continue; }
    word += char; started = true;
  }
  flushCommand();
  return commands;
}

function directlyCallsTask(words: string[], task: string): boolean {
  let offset = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[offset] ?? '')) offset++;
  const executable = basename(words[offset] ?? '');
  if (executable === 'npx' || executable === 'npx.cmd') {
    offset++;
    if (words[offset] === '--no-install') offset++;
    if (words[offset] === '--') offset++;
  } else if ((executable === 'npm' || executable === 'npm.cmd') && words[offset + 1] === 'exec') {
    offset += 2;
    if (words[offset] === '--') offset++;
  }
  return [brand.command, `${brand.command}.cmd`].includes(basename(words[offset] ?? ''))
    && words[offset + 1] === task
    // Flags can select another project, or just display help; do not call those proven cycles.
    && words.slice(offset + 2).every(word => word === '--' || word === '--no-build');
}

function npmCommand(args: string[]): ToolingCommand {
  // npm's Windows launcher is a .cmd file, which cannot be spawned without a shell.
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.js$/.test(cli)) return { command: process.execPath, args: [cli, ...args] };
  if (process.platform === 'win32') return { command: process.execPath, args: [join(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js'), ...args] };
  return { command: 'npm', args };
}

function npmLifecycle(command: ToolingCommand): string | undefined {
  let args = command.args ?? [];
  const executable = basename(command.command);
  if (command.command === process.execPath && /npm-cli\.js$/.test(args[0] ?? '')) args = args.slice(1);
  else if (executable !== 'npm' && executable !== 'npm.cmd') return undefined;
  if (args.includes('--prefix') || args.includes('--workspace') || args.includes('-w')
    || args.some(arg => /^(--prefix|--workspace)=/.test(arg))) return undefined;
  if (args[0] === 'run' || args[0] === 'run-script') return args[1];
  if (args[0] === 'test' || args[0] === 't' || args[0] === 'tst') return 'test';
  return undefined;
}

function scriptCallsTask(script: string, task: string, root: string): boolean {
  let cwd: string | undefined = root;
  for (const words of scriptCommands(script)) {
    if (words[0] === 'cd') {
      const target = words[1];
      cwd = cwd && target && words.length === 2 && !/[~$`]/.test(target) ? resolve(cwd, target) : undefined;
    } else if (cwd === root && directlyCallsTask(words, task)) return true;
  }
  return false;
}

export async function runProjectTask(
  task: 'install' | 'build' | 'test',
  root: string,
  options: { signal?: AbortSignal; onOutput?: (text: string) => void; projectFile?: string } = {},
): Promise<{ task: string; status: 'completed' | 'not-configured' }> {
  const cancelled = () => new FrameworkError('CANCELLED', `Project ${task} was cancelled.`, { cause: options.signal?.reason });
  if (options.signal?.aborted) throw cancelled();
  const directory = resolve(root);
  const pkg = packageSchema.safeParse(await jsonFile(join(directory, 'package.json')));
  const project = z.object({ tooling: toolingSchema.optional() }).safeParse(await jsonFile(options.projectFile ?? join(directory, 'agent.project.json'), true));
  if (!pkg.success) throw configurationError('Invalid package.json scripts.', pkg.error);
  if (!project.success) throw configurationError('Invalid agent.project.json tooling configuration.', project.error);
  if (options.signal?.aborted) throw cancelled();
  const override = project.data.tooling?.[task];
  let command = override;
  if (!command) {
    if (task !== 'install' && !Object.hasOwn(pkg.data.scripts ?? {}, task)) {
      if (task === 'build') return { task, status: 'not-configured' };
      throw configurationError('No test command configured. Define scripts.test or tooling.test.');
    }
    command = npmCommand(task === 'install' ? ['install', '--no-audit', '--no-fund'] : task === 'build' ? ['run', 'build'] : ['test']);
  } else if (directlyCallsTask([command.command, ...command.args ?? []], task)) {
    throw configurationError(`Recursive task: tooling.${task} directly calls ${brand.command} ${task}.`);
  }
  const lifecycle = npmLifecycle(command);
  if (lifecycle) {
    for (const scriptName of [`pre${lifecycle}`, lifecycle, `post${lifecycle}`]) {
      const script = pkg.data.scripts?.[scriptName];
      if (script && scriptCallsTask(script, task, directory)) {
        throw configurationError(`Recursive task: npm script ${scriptName} directly calls ${brand.command} ${task}, which runs the same npm lifecycle again.`);
      }
    }
  }

  await new Promise<void>((resolveTask, rejectTask) => {
    const grouped = process.platform !== 'win32';
    let aborted = false;
    let failure: unknown;
    let spawned = false;
    const child = spawn(command.command, command.args ?? [], {
      cwd: directory, shell: false, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = () => {
      if (!spawned || child.pid === undefined) return;
      try {
        // Cancellation is definitive, including children that ignore SIGTERM. No task deadline.
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error; }
    };
    const abort = () => { aborted = true; kill(); };
    options.signal?.addEventListener('abort', abort);
    if (options.signal?.aborted) abort();
    child.once('spawn', () => { spawned = true; if (aborted || failure) kill(); });
    child.once('error', error => { failure ??= error; });
    const output = (text: string) => {
      try { if (options.onOutput) options.onOutput(text); else process.stderr.write(text); }
      catch (error) { failure ??= error instanceof Error ? error : configurationError('Project output callback failed.', error); kill(); }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    // Keep cancellation installed through exit and pipe drainage; never resolve on abort alone.
    child.once('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      if (aborted || options.signal?.aborted) rejectTask(cancelled());
      else if (failure) rejectTask(configurationError(`Could not run project ${task}.`, failure));
      else if (code !== 0) rejectTask(configurationError(`Project ${task} failed (${signal ? `signal ${signal}` : `exit ${code}`}).`));
      else resolveTask();
    });
  });
  if (options.signal?.aborted) throw cancelled();
  return { task, status: 'completed' };
}

const registryMarker = `// ${brand.command} generated tool registry v1: `;

function safeName(name: string): string {
  // A filename stem, not a path. Alias imports avoid reserved-word identifier problems.
  if (name === 'index') throw configurationError('The index filename belongs to the tool registry.');
  if (!/^(?:[A-Za-z_$][A-Za-z0-9_$]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/.test(name)) {
    throw configurationError(`Invalid tool name ${JSON.stringify(name)}. Use a JavaScript identifier or a kebab-case filename stem.`);
  }
  return name;
}

export function renderToolRegistry(names: string[]): string {
  const sorted = [...new Set(names.map(safeName))].sort();
  return `${registryMarker}${JSON.stringify(sorted)}\n`
    + sorted.map((name, index) => `import tool${index} from './${name}.js';\n`).join('')
    + '\nexport const generatedTools = {\n'
    + sorted.map((name, index) => `  [${JSON.stringify(name)}]: tool${index},\n`).join('')
    + '};\n';
}

function registryNames(content: string): string[] {
  try {
    if (!content.startsWith(registryMarker)) throw new Error('Missing registry marker.');
    const names: unknown = JSON.parse(content.slice(registryMarker.length).split('\n')[0]!);
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) throw new Error('Invalid registry metadata.');
    if (content !== renderToolRegistry(names)) throw new Error('Registry was edited.');
    return names;
  } catch (error) { throw configurationError('Tool registry is not an unchanged generated registry. Keep custom tools outside this file.', error); }
}

function sourceText(name: string): string {
  return `import { defineTool } from '${brand.packageName}';
import { z } from 'zod';

export default defineTool({
  description: ${JSON.stringify(`${name}: returns the supplied text; replace execute with your business logic.`)},
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  sideEffect: 'none',
  idempotent: true,
  execute(input) {
    return { text: input.text };
  },
});
`;
}

function testText(name: string): string {
  return `import { test } from 'node:test';
import { deepStrictEqual } from 'node:assert/strict';
import tool from './${name}.js';

test(${JSON.stringify(`${name} returns the supplied text`)}, async () => {
  const input = { text: 'hello' };
  const state = new Map<string, unknown>();
  const output = await tool.invoke(input, {
    runId: 'test-run',
    toolCallId: 'test-call',
    signal: new AbortController().signal,
    input,
    state: { get: key => state.get(key), set: (key, value) => { state.set(key, value); } },
  });
  deepStrictEqual(output, input);
});
`;
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Synchronous filesystem commit inside the async API leaves no interleaving await windows. */
export async function generateTool(root: string, name: string): Promise<{ files: string[]; tool: string }> {
  safeName(name);
  const directory = join(resolve(root), 'src', 'tools');
  const registry = join(directory, 'index.ts');
  const files = [`src/tools/${name}.ts`, `src/tools/${name}.test.ts`];
  const paths = files.map(file => join(resolve(root), file));
  const created: Array<{ path: string; dev: number; ino: number; content: string }> = [];
  let registryFd: number | undefined;
  let lockFd: number | undefined;
  const lock = join(directory, `${brand.dataDirectory}-generator.lock`);
  try {
    // Never follow registry or directory symlinks into user files outside the project.
    for (const path of [join(resolve(root), 'src'), directory]) {
      if (exists(path) && !lstatSync(path).isDirectory()) throw configurationError(`Expected a real directory: ${path}.`);
    }
    for (const path of paths) if (exists(path)) throw configurationError(`Refusing to overwrite ${path}.`);
    if (!exists(registry)) throw configurationError('Missing src/tools/index.ts. Initialize it with renderToolRegistry([]).');
    if (!lstatSync(registry).isFile()) throw configurationError('Tool registry must be a regular file, not a symlink.');
    const original = readFileSync(registry, 'utf8');
    const names = registryNames(original);
    if (names.includes(name)) throw configurationError(`Tool ${name} is already registered.`);
    lockFd = openSync(lock, 'wx');
    registryFd = openSync(registry, constants.O_RDWR | constants.O_NOFOLLOW);
    const registryStat = fstatSync(registryFd);
    const unchanged = () => {
      const current = lstatSync(registry);
      if (current.dev !== registryStat.dev || current.ino !== registryStat.ino || readFileSync(registry, 'utf8') !== original) {
        throw configurationError('Tool registry changed during generation; no registry update was made.');
      }
    };
    unchanged();
    for (const [index, content] of [sourceText(name), testText(name)].entries()) {
      const path = paths[index]!;
      const fd = openSync(path, 'wx');
      try {
        const stat = fstatSync(fd);
        created.push({ path, dev: stat.dev, ino: stat.ino, content });
        writeFileSync(fd, content);
      } finally { closeSync(fd); }
    }
    unchanged();
    const content = Buffer.from(renderToolRegistry([...names, name]));
    let offset = 0;
    while (offset < content.length) {
      const bytes = writeSync(registryFd, content, offset, content.length - offset, offset);
      if (bytes === 0) throw new Error('Registry write made no progress.');
      offset += bytes;
    }
    ftruncateSync(registryFd, content.length);
    const committed = lstatSync(registry);
    if (committed.dev !== registryStat.dev || committed.ino !== registryStat.ino || readFileSync(registry, 'utf8') !== content.toString()) {
      throw configurationError('Tool registry changed during generation; its replacement was not overwritten.');
    }
    return { files: [...files, 'src/tools/index.ts'], tool: name };
  } catch (error) {
    for (const file of created.reverse()) {
      try {
        const stat = lstatSync(file.path);
        if (stat.dev === file.dev && stat.ino === file.ino && file.content.startsWith(readFileSync(file.path, 'utf8'))) unlinkSync(file.path);
      } catch { /* Do not remove a replacement or mask the original failure. */ }
    }
    throw error instanceof FrameworkError ? error : configurationError(`Could not generate tool ${name}.`, error);
  } finally {
    if (registryFd !== undefined) closeSync(registryFd);
    if (lockFd !== undefined) { closeSync(lockFd); unlinkSync(lock); }
  }
}