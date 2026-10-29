import { it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile); const cli = resolve('dist/cli.js'); const roots: string[] = [];
async function starter() {
  const root = await mkdtemp(join(tmpdir(), 'runply-cli-workflow-')); roots.push(root);
  const app = join(root, 'app');
  await exec(process.execPath, [cli, 'new', app, '--no-install', '--no-build']);
  return app;
}
async function run(root: string, args: string[]) { return exec(process.execPath, [cli, ...args], { cwd: root }); }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('generates registered tool code and tests entirely through the CLI', async () => {
  const root = await starter();
  const generated = JSON.parse((await run(root, ['generate', 'tool', 'check-policy'])).stdout);
  expect(generated.tool).toBe('check-policy');
  expect(await readFile(join(root, 'src/tools/index.ts'), 'utf8')).toContain('./check-policy.js');
  expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('...generatedTools');
  await expect(run(root, ['generate', 'tool', 'check-policy'])).rejects.toThrow();
});

it('adds a connection without starting the executable and refuses replacement', async () => {
  const root = await starter();
  const created = JSON.parse((await run(root, ['add', 'mcp', 'documents', '--command', '/not-an-installed-command', '--arg', 'an argument with spaces', '--env', 'staging'])).stdout);
  expect(created.status).toBe('configured; not connected');
  const file = join(root, 'agent.project.json'); const before = await readFile(file, 'utf8');
  const project = JSON.parse(before);
  expect(project.environments.staging.mcp.documents.args).toEqual(['an argument with spaces']);
  expect(project.environments.development.mcp).toBeUndefined();
  await expect(run(root, ['add', 'mcp', 'documents', '--command', 'different', '--env', 'staging'])).rejects.toThrow(/already exists/);
  expect(await readFile(file, 'utf8')).toBe(before);
});

it('stores HTTP header references, not secret values', async () => {
  const root = await starter();
  await run(root, ['add', 'mcp', 'remote', '--url', 'https://example.invalid/mcp', '--header-env', 'Authorization=MY_MCP_AUTH']);
  const project = JSON.parse(await readFile(join(root, 'agent.project.json'), 'utf8'));
  expect(project.environments.development.mcp.remote.headers).toEqual({ Authorization: { env: 'MY_MCP_AUTH' } });
});

it('runs configured build and test commands without manual package-manager commands', async () => {
  const root = await starter(); const file = join(root, 'agent.project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.tooling = {
    build: { command: process.execPath, args: ['-e', 'require("node:fs").appendFileSync("order", "build\\n")'] },
    test: { command: process.execPath, args: ['-e', 'require("node:fs").appendFileSync("order", "test\\n")'] },
  };
  await writeFile(file, JSON.stringify(project));
  expect(JSON.parse((await run(root, ['test'])).stdout).status).toBe('completed');
  expect(await readFile(join(root, 'order'), 'utf8')).toBe('build\ntest\n');
});

it('does not silently fall back to the bundled example for missing explicit source projects', async () => {
  const root = await starter();
  await expect(run(root, ['run', '--source', '--project', 'missing.json'])).rejects.toThrow(/not found/);
  await expect(run(root, ['doctor', '--project', 'missing.json'])).rejects.toThrow(/not found/);
});