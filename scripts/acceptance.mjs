import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'agent-acceptance-'));
const measurements = [];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function step(label, command, args, cwd = root) {
  const start = performance.now();
  try {
    const result = await exec(command, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    measurements.push({ step: label, milliseconds: Math.round(performance.now() - start) });
    return result.stdout;
  } catch (error) {
    throw new Error(`${label} failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error });
  }
}

function npmJson(text) { return JSON.parse(text.slice(text.indexOf('{'))); }

try {
  // Packing invokes prepack/build. No package is published.
  const packed = await step('pack-framework', npm, ['pack', '--json', '--pack-destination', temp]);
  const [manifest] = JSON.parse(packed.slice(packed.indexOf('[')));
  assert(manifest.files.some(file => file.path === 'LICENSE'));
  assert(manifest.files.some(file => file.path === 'src/example.ts'));
  assert.equal(manifest.name, 'runply');
  assert(!manifest.files.some(file => ['node_modules/', '.runply/', '.karateke/', '.switchlane/'].some(prefix => file.path.startsWith(prefix))));
  const target = join(temp, 'app');
  const started = performance.now();
  await step('new-install-build', process.execPath, [join(root, 'dist/cli.js'), 'new', target, '--package', join(temp, manifest.filename)]);
  const cli = join(target, 'node_modules', manifest.name, 'dist/cli.js');
  const result = npmJson(await step('first-useful-run', process.execPath, [cli, 'run'], target));
  const timeToFirstUsefulRunMs = Math.round(performance.now() - started);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output.checks.map(check => check.found), [true, false, true]);
  assert.equal(result.artifacts.length, 2);
  for (const artifact of result.artifacts) {
    const bytes = await readFile(artifact.path);
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  assert.deepEqual(JSON.parse(await readFile(result.artifacts[1].path, 'utf8')), result.output);
  const trace = npmJson(await step('inspect-run', process.execPath, [cli, 'inspect', result.runId], target));
  assert.equal(trace.mode, 'trace-playback');
  assert.equal(trace.events.filter(event => event.type === 'model.completed').length, 3);
  assert.equal(trace.events.filter(event => event.type === 'tool.completed').length, 2);
  assert.equal(trace.events.at(-1).data.status, 'succeeded');
  const diagnosis = npmJson(await step('doctor', process.execPath, [cli, 'doctor', '--no-build'], target));
  assert.equal(diagnosis.model.id, 'offline:scripted');
  assert.equal(diagnosis.workspace.isolation, false);
  await step('generate-tool', process.execPath, [cli, 'generate', 'tool', 'echo'], target);
  await step('starter-offline-test', process.execPath, [cli, 'test'], target);
  const connection = npmJson(await step('add-local-mcp', process.execPath, [cli, 'add', 'mcp', 'demo', '--command', process.execPath, '--arg', `node_modules/${manifest.name}/tests/fixtures/mcp-server.mjs`, '--env', 'staging'], target));
  assert.equal(connection.status, 'configured; not connected');
  const plan = npmJson(await step('plan-staging', process.execPath, [cli, 'plan', '--env', 'staging'], target));
  assert.equal(plan.effects.executeModelCalls, false);
  assert.equal(plan.target.capabilities.isolation, false);
  const deployment = npmJson(await step('deploy-staging', process.execPath, [cli, 'deploy', '--env', 'staging', '--expect-plan', plan.planId], target));
  const released = npmJson(await step('run-staging-release', process.execPath, [cli, 'run', '--env', 'staging'], target));
  assert.equal(released.status, 'succeeded');
  assert.deepEqual(released.output.checks.map(check => check.found), [true, false, true]);
  const releaseTrace = npmJson(await step('inspect-staging-release', process.execPath, [cli, 'inspect', released.runId, '--env', 'staging'], target));
  assert.equal(releaseTrace.run.release.id, deployment.releaseId);
  assert.equal(releaseTrace.run.release.environment, 'staging');
  assert(releaseTrace.events.some(event => event.type === 'component.ready' && event.data.component === 'demo'));
  assert(releaseTrace.events.some(event => event.type === 'component.closed' && event.data.component === 'demo'));
  const deployedStatus = npmJson(await step('status-staging', process.execPath, [cli, 'status', '--env', 'staging'], target));
  assert.equal(deployedStatus.releaseId, deployment.releaseId);
  console.log(JSON.stringify({
    status: 'passed', node: process.version, platform: platform(), arch: arch(),
    package: `${manifest.name}@${manifest.version}`, packageBytes: manifest.size,
    configurationEdits: 0, requiredProviderCredentials: 0, commandsToFirstUsefulRun: 2,
    timeToFirstUsefulRunMs, cache: 'npm cache not cleared; timing is not a cold-cache benchmark',
    modelCalls: trace.events.filter(event => event.type === 'model.completed').length,
    toolCalls: trace.events.filter(event => event.type === 'tool.completed').length,
    artifactCount: result.artifacts.length, modelProfile: diagnosis.model.id, measurements,
    deployment: { target: 'local-process', environment: 'staging', releaseId: deployment.releaseId, snapshotFiles: plan.package.fileCount, snapshotBytes: plan.package.bytes, modelCalls: releaseTrace.events.filter(event => event.type === 'model.completed').length },
  }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}