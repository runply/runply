import { access, mkdir, mkdtemp, readFile, writeFile, rename, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { brand } from './brand.js';
import { FrameworkError } from './errors.js';
import type { ErrorCode } from './errors.js';
import { loadProject, bindProcessEnvironment, localTargetCapabilities } from './project.js';
import { canonical, collectSnapshot, sha256, snapshotPath, verifySnapshot } from './snapshot.js';
import { ReleaseStore } from './release-store.js';
import type { ReleasePayload, ReleasePlan } from './release-types.js';
import type { RunResult } from './runtime.js';

const exec = promisify(execFile);
const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultProjectFile = 'agent.project.json';

export async function projectLocation(projectFile = defaultProjectFile, environment?: string, controlRoot?: string) {
  const loaded = await loadProject(projectFile, environment);
  const projectId = sha256(loaded.projectFile);
  return { ...loaded, projectId, scope: sha256(`${projectId}:${loaded.environment}`), controlRoot: resolve(controlRoot ?? join(loaded.root, brand.dataDirectory, 'control')) };
}

/** Active releases are identified independently of unbuilt or invalid source settings. */
async function releaseLocation(options: { projectFile?: string; environment?: string; controlRoot?: string }) {
  const requested = resolve(options.projectFile ?? defaultProjectFile);
  let projectFile: string;
  try { projectFile = await realpath(requested); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    projectFile = join(await realpath(dirname(requested)), basename(requested));
  }
  const environment: unknown = options.environment ?? (JSON.parse(await readFile(projectFile, 'utf8')) as { defaultEnvironment?: unknown }).defaultEnvironment;
  if (typeof environment !== 'string' || !environment) throw new FrameworkError('CONFIGURATION_ERROR', 'Select an environment explicitly when the source project has no default.');
  const projectId = sha256(projectFile);
  return { environment, scope: sha256(`${projectId}:${environment}`), controlRoot: resolve(options.controlRoot ?? join(dirname(projectFile), brand.dataDirectory, 'control')) };
}

/** Planning reads package inventories and local declarations; it never imports application code. */
export async function planProject(options: { projectFile?: string; environment?: string; controlRoot?: string } = {}): Promise<ReleasePlan> {
  const location = await projectLocation(options.projectFile, options.environment, options.controlRoot);
  const { bindings, root, projectFile, environment, projectId, scope, controlRoot } = location;
  const snapshot = await collectSnapshot(root, hostRoot, [controlRoot, bindings.state.path, bindings.artifacts.path]);
  if (!snapshot.files.some(file => file.path === `app/${location.entry}`)) throw new FrameworkError('CONFIGURATION_ERROR', `Built entry ${location.entry} is not in the npm package. Build the application and include its entry/assets with npm files before planning.`);
  const payload: ReleasePayload = {
    schemaVersion: 1, project: location.project.name, projectId, environment, entry: `app/${location.entry}`,
    bindings, node: { executable: process.execPath, version: process.version, platform: process.platform, arch: process.arch }, ...snapshot,
  };
  const releaseId = sha256(canonical(payload));
  const store = new ReleaseStore(controlRoot, true);
  let base;
  let previous: ReleasePayload | undefined;
  try { base = store.active(scope); previous = base.releaseId ? store.release(base.releaseId).payload : undefined; }
  finally { store.close(); }
  const changes: ReleasePlan['changes'] = [];
  for (const component of ['model', 'state', 'artifacts', 'permissions'] as const) {
    if (canonical(previous?.bindings[component]) !== canonical(bindings[component])) changes.push({ component, before: previous?.bindings[component], after: bindings[component], ...(component === 'state' || component === 'artifacts' ? { detail: 'Existing data stays in place; no data migration or deletion.' } : {}) });
  }
  if (!previous || canonical(previous.files) !== canonical(payload.files)) changes.push({ component: 'package', detail: 'A new snapshot of packaged code, assets, and installed dependencies will be used.' });
  if (!previous || canonical(previous.node) !== canonical(payload.node)) changes.push({ component: 'node', before: previous?.node.version, after: payload.node.version });
  if (canonical(previous?.bindings.providerOptions) !== canonical(bindings.providerOptions)) changes.push({ component: 'provider-options', detail: 'Validated provider options changed; values are not shown.' });
  if (canonical(previous?.bindings.mcp) !== canonical(bindings.mcp)) changes.push({ component: 'mcp', detail: 'MCP connection configuration changed; connections will open when a run starts, not during planning or preflight.' });
  if (canonical(previous?.bindings.variables) !== canonical(bindings.variables) || canonical(previous?.bindings.secrets) !== canonical(bindings.secrets)) changes.push({ component: 'process-environment', detail: 'Variable values or secret references changed; values are not shown.' });
  return {
    schemaVersion: 1, id: sha256(canonical({ releaseId, base, controlRoot, scope })), releaseId, scope, controlRoot, projectFile, environment,
    base, action: base.releaseId === releaseId && !base.paused ? 'unchanged' : 'activate', payload, changes,
    secretReferences: Object.entries(bindings.secrets).map(([variable, reference]) => ({ variable, source: reference.env, available: Object.hasOwn(process.env, reference.env) })),
  };
}

export function describePlan(plan: ReleasePlan) {
  return {
    planId: plan.id, releaseId: plan.releaseId, application: plan.payload.project, environment: plan.environment,
    target: { name: 'local-process', capabilities: localTargetCapabilities }, action: plan.action,
    previousRelease: plan.base.releaseId, expectedRevision: plan.base.revision,
    changes: plan.changes,
    package: { fileCount: plan.payload.files.length, bytes: plan.payload.files.reduce((sum, file) => sum + file.bytes, 0), dependencies: plan.payload.packages },
    bindings: { model: plan.payload.bindings.model, state: plan.payload.bindings.state, artifacts: plan.payload.bindings.artifacts, permissions: plan.payload.bindings.permissions ?? 'application-default', variableNames: Object.keys(plan.payload.bindings.variables), secretReferences: plan.secretReferences },
    effects: { snapshot: join(plan.controlRoot, 'releases', plan.releaseId), activateForNewRuns: plan.action === 'activate', existingRuns: 'continue-on-their-release', createCloudResources: false, executeModelCalls: false, deleteData: false },
    validation: { package: 'hashed', targetCapabilities: 'checked', application: 'checked-on-staged-release-before-activation', secrets: 'references-only; values are resolved at execution' },
  };
}

async function materialize(directory: string, payload: ReleasePayload): Promise<void> {
  for (const file of payload.files) {
    const target = snapshotPath(directory, file.path);
    const bytes = await readFile(file.source);
    if (sha256(bytes) !== file.sha256) throw new FrameworkError('CONFLICT', `Source changed after planning: ${file.path}. Generate a new plan.`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
    if (file.executable) await chmod(target, 0o755);
  }
  for (const link of payload.links) {
    const target = snapshotPath(directory, link.path);
    await mkdir(dirname(target), { recursive: true });
    await symlink(link.target, target, 'dir');
  }
  await writeFile(join(directory, 'release.json'), JSON.stringify(payload), { flag: 'wx' });
}

export async function deployProject(options: { projectFile?: string; environment?: string; controlRoot?: string; expectedPlan?: string } = {}) {
  const plan = await planProject(options);
  if (options.expectedPlan && options.expectedPlan !== plan.id) throw new FrameworkError('CONFLICT', 'Plan no longer matches the project or environment. Review a new plan before deploying.');
  const env = bindProcessEnvironment(plan.payload.bindings);
  if (plan.action === 'unchanged') {
    await verifySnapshot(join(plan.controlRoot, 'releases', plan.releaseId), plan.payload);
    return { releaseId: plan.releaseId, environment: plan.environment, action: 'unchanged', revision: plan.base.revision };
  }
  const releases = join(plan.controlRoot, 'releases');
  await mkdir(releases, { recursive: true });
  const temporary = await mkdtemp(join(releases, '.preparing-'));
  const destination = join(releases, plan.releaseId);
  try {
    await materialize(temporary, plan.payload);
    await verifySnapshot(temporary, plan.payload);
    // Trusted app import/validation only. No model generation or app tool executes.
    await exec(plan.payload.node.executable, [join(temporary, plan.payload.hostEntry), 'probe', join(temporary, 'release.json')], {
      cwd: join(temporary, 'app'), env, maxBuffer: 4 * 1024 * 1024,
    });
    await verifySnapshot(temporary, plan.payload);
    try { await rename(temporary, destination); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifySnapshot(destination, plan.payload);
    }
    // Activation is the only admission switch. Preparing a release never changes it.
    const store = new ReleaseStore(plan.controlRoot);
    try {
      const activated = store.activate(plan.scope, plan.base.revision, { id: plan.releaseId, createdAt: new Date().toISOString(), payload: plan.payload });
      return { releaseId: plan.releaseId, environment: plan.environment, action: 'activated', revision: activated.revision };
    } finally { store.close(); }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function releaseStatus(options: { projectFile?: string; environment?: string; controlRoot?: string } = {}) {
  const location = await releaseLocation(options);
  const store = new ReleaseStore(location.controlRoot, true);
  try {
    const active = store.active(location.scope);
    const release = active.releaseId ? store.release(active.releaseId) : null;
    return { environment: location.environment, ...active, release, controlRoot: location.controlRoot };
  } finally { store.close(); }
}

export async function pauseEnvironment(options: { projectFile?: string; environment?: string; controlRoot?: string } = {}) {
  const location = await releaseLocation(options);
  await access(join(location.controlRoot, 'releases.sqlite'));
  const store = new ReleaseStore(location.controlRoot);
  try { return { environment: location.environment, ...store.pause(location.scope), existingRuns: 'draining-without-cancellation' }; }
  finally { store.close(); }
}

/** Select one admitted release before spawning. Later activations cannot change this child. */
export async function runRelease(options: { projectFile?: string; environment?: string; controlRoot?: string; input?: unknown; signal?: AbortSignal } = {}): Promise<RunResult<unknown>> {
  const status = await releaseStatus(options);
  if (!status.release) throw new FrameworkError('NOT_FOUND', 'No release is active. Plan and deploy this environment first.');
  if (status.paused) throw new FrameworkError('CONFLICT', 'Environment is paused; new runs are not admitted. Deploy to resume admission.');
  const release = status.release;
  const directory = join(status.controlRoot, 'releases', release.id);
  if (release.payload.node.platform !== process.platform || release.payload.node.arch !== process.arch) throw new FrameworkError('CAPABILITY_MISMATCH', 'This local-process release belongs to a different platform or architecture.');
  await verifySnapshot(directory, release.payload);
  options.signal?.throwIfAborted();
  const env = bindProcessEnvironment(release.payload.bindings);
  return new Promise((accept, reject) => {
    let result: RunResult<unknown> | undefined;
    const child = fork(join(directory, release.payload.hostEntry), ['run', join(directory, 'release.json'), release.id], {
      execPath: release.payload.node.executable, cwd: join(directory, 'app'), env,
      execArgv: [], serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const cancel = () => { if (child.connected) child.send({ type: 'cancel' }, () => {}); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.once('spawn', () => {
      try {
        // false means queued/backpressure, not failure; completion is reported by the callback.
        child.send({ type: 'start', input: options.input }, error => {
          if (error) { reject(new FrameworkError('INVALID_INPUT', 'Run input could not be transferred to the release process.', { cause: error })); cancel(); }
        });
      } catch (error) { reject(new FrameworkError('INVALID_INPUT', 'Run input is not serializable for a release process.', { cause: error })); cancel(); }
      if (options.signal?.aborted) cancel();
    });
    child.on('message', message => {
      const data = message as { type: string; result?: RunResult<unknown>; error?: { code: ErrorCode; message: string } };
      if (data.type === 'result' && data.result) result = { ...data.result, error: data.result.error ? new FrameworkError(data.result.error.code, data.result.error.message) : undefined };
      if (data.type === 'error') reject(new FrameworkError(data.error?.code ?? 'CONFIGURATION_ERROR', data.error?.message ?? 'Release host failed.'));
    });
    child.once('error', error => { options.signal?.removeEventListener('abort', cancel); reject(error); });
    child.once('exit', (code, signal) => {
      options.signal?.removeEventListener('abort', cancel);
      if (result) accept(result);
      else reject(new FrameworkError('MODEL_ERROR', `Release process exited before reporting its run (code=${code}, signal=${signal}). Inspect persisted run state; nothing was replayed.`));
    });
  });
}