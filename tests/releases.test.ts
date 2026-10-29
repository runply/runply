import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, copyFile, rm, realpath, readdir, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planProject, deployProject, releaseStatus, runRelease, pauseEnvironment, describePlan } from '../src/releases.js';
import { SQLiteRunStore } from '../src/store.js';
import type { ProjectDefinition } from '../src/project.js';

const roots: string[] = [];
const exec = promisify(execFile);
const framework = resolve('.');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-release-'))); roots.push(root);
  await mkdir(join(root, 'node_modules')); await mkdir(join(root, 'assets'));
  await symlink(framework, join(root, 'node_modules/runply'), 'dir');
  await symlink(join(framework, 'node_modules/zod'), join(root, 'node_modules/zod'), 'dir');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'release-fixture', version: '1.0.0', type: 'module', files: ['app.mjs', 'assets'], dependencies: { runply: `file:${framework}`, zod: '4.6.7' } }));
  await copyFile(join(framework, 'tests/fixtures/release-app.mjs'), join(root, 'app.mjs'));
  await writeFile(join(root, 'assets/version.txt'), 'one\n');
  const project: ProjectDefinition = {
    schemaVersion: 1, name: 'reviewer', entry: 'app.mjs', defaultEnvironment: 'dev',
    environments: {
      dev: { model: 'first', state: { path: 'data/dev.sqlite' }, artifacts: { path: 'data/dev-artifacts' }, variables: { BIND_LABEL: 'development' } },
      staging: { model: 'second', state: { path: 'data/staging.sqlite' }, artifacts: { path: 'data/staging-artifacts' }, variables: { BIND_LABEL: 'staging' } },
    },
  };
  const projectFile = join(root, 'agent.project.json');
  const save = async () => writeFile(projectFile, JSON.stringify(project)); await save();
  return { root, projectFile, project, save };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function appeared(path: string) {
  await new Promise<void>((accept, reject) => {
    const watcher = watch(dirname(path), check);
    async function check() {
      try { await access(path); watcher.close(); accept(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { watcher.close(); reject(error); } }
    }
    void check();
  });
}

describe('local-process release lifecycle', () => {
  it('plans without importing application code or creating control/data directories', async () => {
    const f = await fixture(); const marker = join(f.root, 'probe.txt');
    f.project.environments.dev!.variables = { PROBE_MARKER: marker }; await f.save();
    const packagePath = join(f.root, 'package.json');
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    manifest.scripts = { prepare: 'node -e "throw new Error(\'prepare must never execute while planning\')"' };
    await writeFile(packagePath, JSON.stringify(manifest));
    const before = await readdir(f.root);
    const one = await planProject(f); const two = await planProject(f);
    expect(one.id).toBe(two.id);
    expect(one.releaseId).toBe(two.releaseId);
    expect(await readdir(f.root)).toEqual(before);
    await expect(access(marker)).rejects.toThrow();
    expect(describePlan(one)).toMatchObject({ action: 'activate', effects: { createCloudResources: false, executeModelCalls: false, deleteData: false } });
    expect(one.payload.packages.some(pkg => pkg.name === 'ai')).toBe(true);
  }, 120_000);

  it('deploys a snapshot and binds the same business code to another environment/model', async () => {
    const f = await fixture();
    const before = await readFile(join(f.root, 'app.mjs'));
    const plan = await planProject(f);
    const deployed = await deployProject({ ...f, expectedPlan: plan.id });
    const result = await runRelease(f);
    expect(result.status, result.error?.message).toBe('succeeded');
    expect(result.output).toEqual({ version: 'one', binding: 'development', model: 'fixture:first', secretPresent: false });
    const store = new SQLiteRunStore(join(f.root, 'data/dev.sqlite'), { readOnly: true });
    expect(store.get(result.runId).release).toMatchObject({ id: deployed.releaseId, environment: 'dev' }); store.close();
    await deployProject({ ...f, environment: 'staging' });
    const staging = await runRelease({ ...f, environment: 'staging' });
    expect(staging.output).toMatchObject({ binding: 'staging', model: 'fixture:second' });
    expect(await readFile(join(f.root, 'app.mjs'))).toEqual(before);
    expect((await deployProject(f)).action).toBe('unchanged');
  }, 120_000);

  it('rejects a stale reviewed plan when package bytes or settings changed', async () => {
    const f = await fixture(); const plan = await planProject(f);
    await writeFile(join(f.root, 'assets/version.txt'), 'two\n');
    const changed = describePlan(await planProject(f));
    expect(changed.changes.some(change => change.component === 'package')).toBe(true);
    await expect(deployProject({ ...f, expectedPlan: plan.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await releaseStatus(f)).releaseId).toBeNull();
  }, 120_000);

  it('preserves the active release after failed preflight', async () => {
    const f = await fixture(); const first = await deployProject(f);
    f.project.environments.dev!.variables = { FAIL_IMPORT: 'yes' }; await f.save();
    await expect(deployProject(f)).rejects.toThrow(/intentional preflight failure/);
    expect((await releaseStatus(f)).releaseId).toBe(first.releaseId);
    expect((await readdir(join(f.root, '.runply/control/releases'))).filter(name => name.startsWith('.preparing-'))).toEqual([]);
    expect((await runRelease(f)).output).toMatchObject({ version: 'one' });
  }, 120_000);

  it('keeps an in-flight run on its release, activates new runs, and drains when paused', async () => {
    const f = await fixture(); const first = await deployProject(f);
    const started = join(f.root, 'started'); const gate = join(f.root, 'gate');
    const inFlight = runRelease({ ...f, input: { started, gate } });
    await appeared(started);
    try {
      await writeFile(join(f.root, 'assets/version.txt'), 'two\n');
      const second = await deployProject(f); expect(second.releaseId).not.toBe(first.releaseId);
      expect((await runRelease(f)).output).toMatchObject({ version: 'two' });
      await pauseEnvironment(f);
      await expect(runRelease(f)).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally { await writeFile(gate, 'continue'); }
    const finished = await inFlight;
    expect(finished.status).toBe('succeeded');
    expect(finished.output).toMatchObject({ version: 'one' });
    const store = new SQLiteRunStore(join(f.root, 'data/dev.sqlite'), { readOnly: true });
    expect(store.get(finished.runId).release?.id).toBe(first.releaseId); store.close();
    await deployProject(f);
    expect((await releaseStatus(f)).paused).toBe(false);
  }, 120_000);

  it('runs without consulting changed source or the installed dependency directory', async () => {
    const f = await fixture(); await deployProject(f);
    await writeFile(join(f.root, 'app.mjs'), 'throw new Error("source must not be imported");');
    await writeFile(join(f.root, 'assets/version.txt'), 'mutated');
    await rm(join(f.root, 'node_modules'), { recursive: true });
    expect((await runRelease(f)).output).toMatchObject({ version: 'one' });
    await writeFile(f.projectFile, 'source JSON is being edited');
    expect((await runRelease({ ...f, environment: 'dev' })).output).toMatchObject({ version: 'one' });
    await rm(f.projectFile);
    expect((await runRelease({ ...f, environment: 'dev' })).output).toMatchObject({ version: 'one' });
  }, 120_000);

  it('detects mutated published bytes instead of running them', async () => {
    const f = await fixture(); const release = await deployProject(f);
    const status = await releaseStatus(f);
    await writeFile(join(status.controlRoot, 'releases', release.releaseId, 'app/assets/version.txt'), 'tampered');
    await expect(runRelease(f)).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);

  it('rejects new files injected into a published snapshot', async () => {
    const f = await fixture(); const release = await deployProject(f);
    const status = await releaseStatus(f);
    await writeFile(join(status.controlRoot, 'releases', release.releaseId, 'app/assets/unplanned.txt'), 'not in the release manifest');
    await expect(runRelease(f)).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);

  it('passes secret values only at execution and does not store them in the manifest', async () => {
    const f = await fixture(); const secret = 'synthetic-release-secret';
    const original = process.env.TEST_RELEASE_SECRET; process.env.TEST_RELEASE_SECRET = secret;
    try {
      f.project.environments.dev!.secrets = { BOUND_TEST_SECRET: { env: 'TEST_RELEASE_SECRET' } }; await f.save();
      const plan = await planProject(f);
      expect(JSON.stringify(plan)).not.toContain(secret);
      const release = await deployProject(f);
      const status = await releaseStatus(f);
      expect(await readFile(join(status.controlRoot, 'releases', release.releaseId, 'release.json'), 'utf8')).not.toContain(secret);
      expect((await runRelease(f)).output).toMatchObject({ secretPresent: true });
      delete process.env.TEST_RELEASE_SECRET;
      await expect(runRelease(f)).rejects.toThrow(/TEST_RELEASE_SECRET/);
    } finally { if (original === undefined) delete process.env.TEST_RELEASE_SECRET; else process.env.TEST_RELEASE_SECRET = original; }
  }, 120_000);

  it('rejects an unregistered model binding without altering an active release', async () => {
    const f = await fixture(); const first = await deployProject(f);
    f.project.environments.dev!.model = 'not-installed'; await f.save();
    await expect(deployProject(f)).rejects.toThrow(/not registered/);
    expect((await releaseStatus(f)).releaseId).toBe(first.releaseId);
  }, 120_000);

  it('rejects preflight mutation before switching the active release', async () => {
    const f = await fixture(); const first = await deployProject(f);
    f.project.environments.dev!.variables = { MUTATE_RELEASE: 'yes' }; await f.save();
    await expect(deployProject(f)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await releaseStatus(f)).releaseId).toBe(first.releaseId);
  }, 120_000);

  it('supports the CLI plan/deploy/run/inspect/status/pause journey', async () => {
    const f = await fixture();
    async function cli(...args: string[]) {
      const result = await exec(process.execPath, [join(framework, 'dist/cli.js'), ...args, '--project', f.projectFile], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(result.stdout);
    }
    const plan = await cli('plan');
    const deployed = await cli('deploy', '--expect-plan', plan.planId);
    const result = await cli('run'); expect(result.status).toBe('succeeded');
    const trace = await cli('inspect', result.runId);
    expect(trace.run.release.id).toBe(deployed.releaseId);
    expect((await cli('status')).releaseId).toBe(deployed.releaseId);
    expect((await cli('pause')).paused).toBe(true);
  }, 120_000);

  it('allows only one activation from two concurrent reviewed deployments', async () => {
    const f = await fixture(); const plan = await planProject(f);
    const outcomes = await Promise.allSettled([deployProject({ ...f, expectedPlan: plan.id }), deployProject({ ...f, expectedPlan: plan.id })]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect((await releaseStatus(f)).revision).toBe(1);
    expect((await runRelease(f)).status).toBe('succeeded');
  }, 120_000);

  it('transfers large inputs without replay and propagates cancellation to the process', async () => {
    const f = await fixture(); await deployProject(f);
    const large = await runRelease({ ...f, input: { additional: 'x'.repeat(2_000_000) } });
    expect(large.status).toBe('succeeded');
    const started = join(f.root, 'cancel-started'); const gate = join(f.root, 'never-opened');
    const controller = new AbortController();
    const running = runRelease({ ...f, input: { started, gate }, signal: controller.signal });
    await appeared(started); controller.abort();
    const cancelled = await running;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error?.code).toBe('CANCELLED');
  }, 120_000);
});