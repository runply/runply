import { it, expect, afterEach } from 'vitest';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRunStore } from '../src/store.js';

const exec = promisify(execFile);
const cli = resolve('dist/cli.js');
const roots: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), 'agent-cli-')); roots.push(dir); return dir; }
async function command(args: string[], cwd = process.cwd()) {
  const { stdout } = await exec(process.execPath, [cli, ...args], { cwd });
  return JSON.parse(stdout) as Record<string, any>;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('runs bundled documents, persists state, and inspects without loading an app', async () => {
  const data = await root();
  const result = await command(['run', '--data', data]);
  expect(result.status).toBe('succeeded');
  // Independent expected result from the fixture documents: retention is absent.
  expect(result.output.checks.map((check: { found: boolean }) => check.found)).toEqual([true, false, true]);
  const artifact = JSON.parse(await readFile(result.artifacts[1].path, 'utf8'));
  expect(artifact).toEqual(result.output);
  const before = await readFile(join(data, 'runs.sqlite'));
  const trace = await command(['inspect', result.runId, '--data', data]);
  expect(trace.mode).toBe('trace-playback');
  expect(trace.events.filter((event: { type: string }) => event.type === 'model.completed')).toHaveLength(3);
  expect(trace.events.filter((event: { type: string }) => event.type === 'tool.completed')).toHaveLength(2);
  expect(await readFile(join(data, 'runs.sqlite'))).toEqual(before);
});

it('doctor validates configuration without creating a data directory', async () => {
  const cwd = await root();
  const result = await command(['doctor'], cwd);
  expect(result.model.status).toContain('not contacted');
  expect(await readdir(cwd)).toEqual([]);
});

it('uses Runply in command help', async () => {
  const { stdout } = await exec(process.execPath, [cli, '--help']);
  expect(stdout).toContain('Runply');
  expect(stdout).toContain('runply new');
  expect(stdout).toContain('runply deploy');
  expect(stdout.toLowerCase()).not.toContain('karateke');
  expect(stdout.toLowerCase()).not.toContain('switchlane');
});

it.each(['.switchlane', '.karateke'])('reads legacy %s run data only through an explicit path without moving it', async directory => {
  const cwd = await root();
  const data = join(cwd, directory);
  const database = join(data, 'runs.sqlite');
  const store = new SQLiteRunStore(database);
  store.create({ id: 'legacy-run', application: 'legacy-app', model: 'offline', owner: 'fixture' });
  store.append('legacy-run', 'fixture', 0, { type: 'run.status', data: { status: 'succeeded' } }, 'succeeded');
  store.close();
  const before = await readFile(database);
  const trace = await command(['inspect', 'legacy-run', '--data', data], cwd);
  expect(trace.run.status).toBe('succeeded');
  expect(await readFile(database)).toEqual(before);
  expect(await readdir(cwd)).toEqual([directory]);
});

it('new generates editable behavior and will not overwrite an existing project', async () => {
  const cwd = await root();
  const target = join(cwd, 'app');
  await command(['new', target, '--no-install', '--no-build']);
  const source = await readFile(join(target, 'src/app.ts'), 'utf8');
  expect(source).toContain("from 'runply'");
  expect(source).toContain('checkRequirements');
  await expect(command(['new', target, '--no-install', '--no-build'])).rejects.toThrow();
  expect(await readFile(join(target, 'src/app.ts'), 'utf8')).toBe(source);
});

it('rejects unsupported flags rather than silently ignoring them', async () => {
  await expect(command(['inspect', '--app', 'does-not-exist.js'])).rejects.toThrow(/not supported/);
  await expect(command(['run', 'unexpected'])).rejects.toThrow(/positional/);
});

it('recovers a killed process without replaying the external side effect', async () => {
  const data = await root();
  const database = join(data, 'runs.sqlite');
  const marker = join(data, 'effect.txt');
  const child = fork(resolve('tests/fixtures/interrupted.mjs'), [database, join(data, 'artifacts'), marker], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    const runId = await new Promise<string>((resolve, reject) => {
      child.once('message', message => resolve((message as { runId: string }).runId));
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Child exited before tool start: ${code} ${stderr}`)));
    });
    await expect(command(['recover', runId, '--data', data])).rejects.toThrow(/still alive/);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
    const store = new SQLiteRunStore(database);
    expect(store.get(runId).status).toBe('running');
    expect(store.events(runId).at(-1)!.type).toBe('tool.started');
    store.close();
    const recovered = await command(['recover', runId, '--data', data]);
    expect(recovered.status).toBe('interrupted');
    await command(['inspect', runId, '--data', data]);
    expect(await readFile(marker, 'utf8')).toBe('one execution\n');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});