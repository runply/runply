import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { generateTool, renderToolRegistry, runProjectTask } from '../src/tooling.js';

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

const roots: string[] = [];
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realSpawn = childProcess.spawn;
const realWrite = fs.writeFileSync;

function fixture(scripts: Record<string, string> = {}, tooling?: unknown): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'runply-tooling-')));
  roots.push(root);
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts }));
  if (tooling !== undefined) fs.writeFileSync(join(root, 'agent.project.json'), JSON.stringify({ schemaVersion: 1, tooling }));
  return root;
}

function script(root: string, content: string, name = 'task.mjs'): string {
  const path = join(root, name);
  fs.writeFileSync(path, content);
  return path;
}

function custom(content: string, args: string[] = []): string {
  const root = fixture({}, { test: { command: process.execPath, args: ['task.mjs', ...args] } });
  script(root, content);
  return root;
}

function generatorFixture(): string {
  const root = fixture();
  fs.mkdirSync(join(root, 'src/tools'), { recursive: true });
  fs.writeFileSync(join(root, 'src/tools/index.ts'), renderToolRegistry([]));
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('runProjectTask', () => {
  it.each(['build', 'test'] as const)('runs the default local npm %s script', async task => {
    const root = fixture({ [task]: 'node task.mjs' });
    script(root, `console.log('local stdout'); console.error('local stderr'); console.log(process.cwd());`);
    let output = '';
    await expect(runProjectTask(task, root, { onOutput: text => { output += text; } })).resolves.toEqual({ task, status: 'completed' });
    expect(output).toContain('local stdout');
    expect(output).toContain('local stderr');
    expect(output).toContain(root);
  });

  it('selects default install arguments without running an installation', async () => {
    const root = fixture();
    const local = script(root, 'console.log("install fixture only")');
    const spawned = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      expect(command).toBeTruthy();
      expect(args).toEqual(expect.arrayContaining(['install', '--no-audit', '--no-fund']));
      expect(options).toMatchObject({ shell: false, cwd: root });
      return realSpawn(process.execPath, [local], options);
    });
    await expect(runProjectTask('install', root, { onOutput: () => {} })).resolves.toEqual({ task: 'install', status: 'completed' });
    expect(spawned).toHaveBeenCalledTimes(1);
  });

  it.each(['build', 'test'] as const)('reports a failed default %s script', async task => {
    const root = fixture({ [task]: 'node task.mjs' });
    script(root, 'process.exitCode = 7');
    await expect(runProjectTask(task, root, { onOutput: () => {} })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('exit 7') });
  });

  it('skips an absent build but rejects an absent test', async () => {
    const root = fixture();
    await expect(runProjectTask('build', root)).resolves.toEqual({ task: 'build', status: 'not-configured' });
    await expect(runProjectTask('test', root)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('No test command') });
  });

  it('passes arbitrary arguments and paths literally, without a shell', async () => {
    const root = fixture();
    const path = script(root, 'console.log(JSON.stringify(process.argv.slice(2)))', 'a script with spaces.mjs');
    const args = ['one two', '$(touch injected)', '; touch injected', '$HOME', 'a"b', '', '日本語'];
    fs.writeFileSync(join(root, 'agent.project.json'), JSON.stringify({ tooling: { build: { command: process.execPath, args: [path, ...args] } } }));
    const spawned = vi.spyOn(childProcess, 'spawn');
    let output = '';
    await expect(runProjectTask('build', root, { onOutput: text => { output += text; } })).resolves.toMatchObject({ status: 'completed' });
    expect(JSON.parse(output)).toEqual(args);
    expect(fs.existsSync(join(root, 'injected'))).toBe(false);
    expect(spawned).toHaveBeenCalledWith(process.execPath, [path, ...args], expect.objectContaining({ shell: false }));
  });

  it('uses explicit overrides even when the unused npm script would recurse', async () => {
    const root = fixture({ test: 'runply test' }, { test: { command: process.execPath, args: ['-e', 'process.exit(0)'] } });
    await expect(runProjectTask('test', root)).resolves.toMatchObject({ status: 'completed' });
  });

  it('forwards full decoded stdout and stderr only to stderr by default', async () => {
    const root = custom(`
      const bytes = Buffer.from('日本語');
      process.stdout.write(bytes.subarray(0, 1));
      setImmediate(() => process.stdout.write(bytes.subarray(1)));
      process.stderr.write('x'.repeat(200000));
    `);
    let output = '';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    const stdout = vi.spyOn(process.stdout, 'write');
    await runProjectTask('test', root);
    expect(stdout).not.toHaveBeenCalled();
    expect(output.replaceAll('x', '')).toBe('日本語');
    expect(output.match(/x/g)).toHaveLength(200000);
    expect(stderr).toHaveBeenCalled();
  });

  it.each([
    { test: { command: '' } }, { test: { command: 'node', shell: true } },
    { test: { command: 'node', args: [1] } }, { test: { command: 'node', args: ['a\0b'] } },
    { test: { command: 'node\0bad' } }, { watch: 'src' }, { unknown: true }, null,
  ])('rejects malformed tooling %j', async tooling => {
    await expect(runProjectTask('test', fixture({}, tooling))).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('accepts command without args and arbitrary watch patterns', async () => {
    const root = fixture({}, { build: { command: process.execPath }, watch: ['**/*', '../shared/**'] });
    // With ignored stdin, bare node exits without evaluating any code.
    await expect(runProjectTask('build', root)).resolves.toMatchObject({ status: 'completed' });
  });

  it('reports missing executables as framework errors', async () => {
    const root = fixture({}, { test: { command: join(tmpdir(), 'runply-no-such-executable') } });
    await expect(runProjectTask('test', root)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it.each(['package.json', 'agent.project.json'])('reports invalid JSON in %s', async file => {
    const root = fixture();
    fs.writeFileSync(join(root, file), '{');
    await expect(runProjectTask('build', root)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('requires package.json and validates script values', async () => {
    const root = fixture();
    fs.writeFileSync(join(root, 'package.json'), '{"scripts":{"build":12}}');
    await expect(runProjectTask('build', root)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    fs.unlinkSync(join(root, 'package.json'));
    await expect(runProjectTask('build', root)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it.each([
    'runply build', '"runply" build', './node_modules/.bin/runply build',
    'node task.mjs && runply build', 'MODE=local runply build',
    'npx --no-install runply build', 'npm exec -- runply build',
  ])('rejects a direct recursive executable: %s', async build => {
    await expect(runProjectTask('build', fixture({ build }))).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('Recursive task') });
  });

  it('checks pre/post lifecycles and explicit self-recursive overrides', async () => {
    await expect(runProjectTask('test', fixture({ test: 'node task.mjs', pretest: 'runply test' }))).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('pretest') });
    await expect(runProjectTask('test', fixture({}, { test: { command: 'runply', args: ['test'] } }))).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('Recursive task') });
  });

  it('checks npm lifecycles selected by explicit overrides', async () => {
    const root = fixture({ compile: 'runply build' }, { build: { command: 'npm', args: ['run', 'compile'] } });
    await expect(runProjectTask('build', root)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('npm script compile') });
  });

  it('does not ban recursion-looking text inside a local script argument', async () => {
    const root = fixture({ build: 'node task.mjs "runply build && runply test"' });
    script(root, 'console.log(process.argv[2])');
    let output = '';
    await expect(runProjectTask('build', root, { onOutput: text => { output += text; } })).resolves.toMatchObject({ status: 'completed' });
    expect(output).toContain('runply build && runply test');
  });

  it.each(['runply build --help', 'runply build --project ../other/agent.project.json', 'runply test', 'cd ../other && runply build'])('does not label a different invocation as a proven build cycle: %s', async build => {
    const root = fixture({ build });
    const local = script(root, 'process.exit(0)');
    vi.spyOn(childProcess, 'spawn').mockImplementation((_command, _args, options) => realSpawn(process.execPath, [local], options));
    await expect(runProjectTask('build', root)).resolves.toMatchObject({ status: 'completed' });
  });

  it('does not spawn when already aborted', async () => {
    const spawned = vi.spyOn(childProcess, 'spawn');
    await expect(runProjectTask('test', fixture(), { signal: AbortSignal.abort('stop') })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(spawned).not.toHaveBeenCalled();
  });

  it('cancels before the spawn event and waits for close to remove the listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let closed = false;
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      const child = realSpawn(command, args, options);
      child.on('close', () => { closed = true; });
      controller.abort();
      expect(remove).not.toHaveBeenCalled();
      return child;
    });
    await expect(runProjectTask('test', custom('setInterval(() => {}, 1000)'), { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(closed).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('never reports success when aborted by the output callback at normal exit', async () => {
    const controller = new AbortController();
    await expect(runProjectTask('test', custom('console.log("done")'), {
      signal: controller.signal, onOutput: () => controller.abort(),
    })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('cleans up the child if the output callback throws', async () => {
    const root = custom('console.log("ready"); setInterval(() => {}, 1000)');
    await expect(runProjectTask('test', root, { onOutput: () => { throw new Error('sink failed'); } })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', cause: { message: 'sink failed' } });
  });

  it('also fails and cleans up when the output callback throws a falsy value', async () => {
    await expect(runProjectTask('test', custom('console.log("ready"); setInterval(() => {}, 1000)'), {
      onOutput: () => { throw undefined; },
    })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it.skipIf(process.platform === 'win32')('kills the spawned POSIX process group, including a SIGTERM-ignoring descendant', async () => {
    const controller = new AbortController();
    const root = custom(`
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      setInterval(() => {}, 1000);
    `);
    let pid = 0;
    try {
      await expect(runProjectTask('test', root, {
        signal: controller.signal,
        onOutput: text => { pid = Number(text.trim()); controller.abort(); },
      })).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 3000, interval: 20 });
    } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } } }
  });
});

describe('generated tool registry', () => {
  it('renders deterministically and idempotently without changing its input', () => {
    const names = ['zeta', 'alpha', 'zeta', 'hello-world', '__proto__'];
    const before = [...names];
    const rendered = renderToolRegistry(names);
    expect(rendered).toBe(renderToolRegistry([...names].reverse()));
    expect(rendered).toBe(renderToolRegistry([...new Set(names)]));
    expect(names).toEqual(before);
    expect(rendered).toContain('["__proto__"]: tool0');
    expect(renderToolRegistry([])).toBe('// runply generated tool registry v1: []\n\nexport const generatedTools = {\n};\n');
  });

  it('creates readable source and a node:test invocation fixture, then extends the registry', async () => {
    const root = generatorFixture();
    await expect(generateTool(root, 'echo-text')).resolves.toEqual({
      files: ['src/tools/echo-text.ts', 'src/tools/echo-text.test.ts', 'src/tools/index.ts'], tool: 'echo-text',
    });
    const source = fs.readFileSync(join(root, 'src/tools/echo-text.ts'), 'utf8');
    expect(source).toContain("from 'runply'");
    expect(source).toContain("from 'zod'");
    expect(source).toContain("sideEffect: 'none'");
    expect(source).toContain('idempotent: true');
    expect(source).toContain('return { text: input.text }');
    const test = fs.readFileSync(join(root, 'src/tools/echo-text.test.ts'), 'utf8');
    expect(test).toContain("from 'node:test'");
    expect(test).toContain('await tool.invoke(input,');
    await generateTool(root, 'anotherTool');
    expect(fs.readFileSync(join(root, 'src/tools/index.ts'), 'utf8')).toBe(renderToolRegistry(['anotherTool', 'echo-text']));
  });

  it('executes the generated nested test with Node against the actual defineTool implementation', async () => {
    const root = generatorFixture();
    await generateTool(root, 'echo-text');
    fs.mkdirSync(join(root, 'node_modules/runply'), { recursive: true });
    fs.symlinkSync(join(workspace, 'node_modules/zod'), join(root, 'node_modules/zod'), 'dir');
    fs.writeFileSync(join(root, 'node_modules/runply/package.json'), JSON.stringify({ type: 'module', exports: './tools.js' }));
    const transpile = (source: string) => stripTypeScriptTypes(source, { mode: 'transform' });
    for (const file of ['tools', 'errors']) {
      fs.writeFileSync(join(root, `node_modules/runply/${file}.js`), transpile(fs.readFileSync(join(workspace, `src/${file}.ts`), 'utf8')));
    }
    fs.mkdirSync(join(root, 'dist/tools'), { recursive: true });
    for (const file of ['echo-text', 'echo-text.test', 'index']) {
      fs.writeFileSync(join(root, `dist/tools/${file}.js`), transpile(fs.readFileSync(join(root, `src/tools/${file}.ts`), 'utf8')));
    }
    fs.writeFileSync(join(root, 'agent.project.json'), JSON.stringify({ tooling: { test: { command: process.execPath, args: ['--test', 'dist/**/*.test.js'] } } }));
    let output = '';
    const result = await runProjectTask('test', root, { onOutput: text => { output += text; } }).catch(error => {
      throw new Error(output, { cause: error });
    });
    expect(result).toMatchObject({ status: 'completed' });
    expect(output).toContain('echo-text returns the supplied text');
  });

  it.each(['already.ts', 'already.test.ts'])('does not overwrite existing %s or touch the registry', async file => {
    const root = generatorFixture();
    const registry = join(root, 'src/tools/index.ts');
    const before = fs.statSync(registry);
    fs.writeFileSync(join(root, 'src/tools', file), 'user code');
    await expect(generateTool(root, 'already')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readFileSync(join(root, 'src/tools', file), 'utf8')).toBe('user code');
    expect(fs.readdirSync(join(root, 'src/tools')).sort()).toEqual([file, 'index.ts'].sort());
    expect(fs.statSync(registry).mtimeMs).toBe(before.mtimeMs);
  });

  it('rejects a duplicate registered name, even if its source was removed', async () => {
    const root = generatorFixture();
    await generateTool(root, 'first');
    fs.unlinkSync(join(root, 'src/tools/first.ts'));
    fs.unlinkSync(join(root, 'src/tools/first.test.ts'));
    await expect(generateTool(root, 'first')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('already registered') });
    expect(fs.readdirSync(join(root, 'src/tools'))).toEqual(['index.ts']);
  });

  it.each([
    'export const generatedTools = {};\n',
    renderToolRegistry([]) + '// edited\n',
    renderToolRegistry([]).replace('= {', '=  {'),
    '// runply generated tool registry v1: ["zeta","alpha"]\n',
    '// runply generated tool registry v1: ["../outside"]\n',
  ])('rejects an edited or malformed registry before creating files: %j', async content => {
    const root = generatorFixture();
    const registry = join(root, 'src/tools/index.ts');
    fs.writeFileSync(registry, content);
    const writes = vi.spyOn(fs, 'openSync');
    await expect(generateTool(root, 'new-tool')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(writes.mock.calls.some(call => call[1] === 'wx')).toBe(false);
    expect(fs.readFileSync(registry, 'utf8')).toBe(content);
    expect(fs.readdirSync(join(root, 'src/tools'))).toEqual(['index.ts']);
  });

  it.each(['../outside', 'a/b', 'a\\b', '.', '..', '', '-bad', 'a.test', 'a\0b', 'a b', 'index'])('rejects unsafe or registry-owned filename %j', async name => {
    const root = generatorFixture();
    await expect(generateTool(root, name)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readdirSync(join(root, 'src/tools'))).toEqual(['index.ts']);
  });

  it.each(['constructor', '__proto__', 'default', '$echo', '_echo', 'a'.repeat(150)])('uses safe alias imports for valid names without an arbitrary length limit: %s', async name => {
    const root = generatorFixture();
    await expect(generateTool(root, name)).resolves.toMatchObject({ tool: name });
    expect(fs.readFileSync(join(root, 'src/tools/index.ts'), 'utf8')).toBe(renderToolRegistry([name]));
  });

  it('does not initialize a missing registry implicitly', async () => {
    const root = fixture();
    await expect(generateTool(root, 'new-tool')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('Missing') });
    expect(fs.existsSync(join(root, 'src'))).toBe(false);
  });

  it('uses exclusive creation and removes only its new files if a competing test appears', async () => {
    const root = generatorFixture();
    const other = join(root, 'src/tools/echo.test.ts');
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
      realWrite(file, content, options);
      if (typeof file === 'number') realWrite(other, 'concurrent user test');
    });
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.existsSync(join(root, 'src/tools/echo.ts'))).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('concurrent user test');
    expect(fs.readFileSync(join(root, 'src/tools/index.ts'), 'utf8')).toBe(renderToolRegistry([]));
  });

  it('cleans up partially written newly created files on write failure', async () => {
    const root = generatorFixture();
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
      realWrite(file, content, options);
      if (String(content).includes("from 'node:test'")) throw new Error('disk failure');
    });
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readdirSync(join(root, 'src/tools'))).toEqual(['index.ts']);
    expect(fs.readFileSync(join(root, 'src/tools/index.ts'), 'utf8')).toBe(renderToolRegistry([]));
  });

  it.each(['edit', 'replace'] as const)('does not clobber the registry on a concurrent %s', async mode => {
    const root = generatorFixture();
    const registry = join(root, 'src/tools/index.ts');
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
      realWrite(file, content, options);
      if (String(content).includes("from 'node:test'")) {
        if (mode === 'replace') fs.unlinkSync(registry);
        realWrite(registry, 'user registry changed during generation');
      }
    });
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('changed during generation') });
    expect(fs.readFileSync(registry, 'utf8')).toBe('user registry changed during generation');
    expect(fs.readdirSync(join(root, 'src/tools'))).toEqual(['index.ts']);
  });

  it('retains a replacement source file during rollback', async () => {
    const root = generatorFixture();
    const source = join(root, 'src/tools/echo.ts');
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
      realWrite(file, content, options);
      if (String(content).includes("from 'node:test'")) {
        // Hold the original inode open so it cannot be reused for the replacement.
        const held = fs.openSync(source, 'r');
        fs.unlinkSync(source);
        realWrite(source, 'replacement source');
        fs.closeSync(held);
        throw new Error('write failed');
      }
    });
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readFileSync(source, 'utf8')).toBe('replacement source');
    expect(fs.existsSync(join(root, 'src/tools/echo.test.ts'))).toBe(false);
  });

  it('retains in-place user edits to a new source file during rollback', async () => {
    const root = generatorFixture();
    const source = join(root, 'src/tools/echo.ts');
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
      realWrite(file, content, options);
      if (String(content).includes("from 'node:test'")) {
        realWrite(source, 'user edited this source');
        throw new Error('write failed');
      }
    });
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readFileSync(source, 'utf8')).toBe('user edited this source');
    expect(fs.existsSync(join(root, 'src/tools/echo.test.ts'))).toBe(false);
  });

  it('does not overwrite a registry replaced during the commit itself', async () => {
    const root = generatorFixture();
    const registry = join(root, 'src/tools/index.ts');
    const write = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
      fs.unlinkSync(registry);
      realWrite(registry, 'replacement at commit');
      return write(...args);
    });
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readFileSync(registry, 'utf8')).toBe('replacement at commit');
    expect(fs.readdirSync(join(root, 'src/tools'))).toEqual(['index.ts']);
  });

  it('does not disturb another generator lock', async () => {
    const root = generatorFixture();
    const lock = join(root, 'src/tools/.runply-generator.lock');
    fs.writeFileSync(lock, 'another generator');
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readFileSync(lock, 'utf8')).toBe('another generator');
    expect(fs.readdirSync(join(root, 'src/tools')).sort()).toEqual(['.runply-generator.lock', 'index.ts']);
  });

  it('does not follow registry symlinks', async () => {
    const root = generatorFixture();
    const registry = join(root, 'src/tools/index.ts');
    const outside = join(root, 'user.ts');
    fs.renameSync(registry, outside);
    fs.symlinkSync(outside, registry);
    await expect(generateTool(root, 'echo')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fs.readFileSync(outside, 'utf8')).toBe(renderToolRegistry([]));
    expect(fs.readdirSync(join(root, 'src/tools'))).toEqual(['index.ts']);
  });
});