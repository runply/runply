import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadApplicationConfiguration } from './application-config.js';
import { runApplication, validateCapabilities, harnessCapabilities } from './runtime.js';
import { SQLiteRunStore } from './store.js';
import { LocalWorkspace } from './workspace.js';
import { parseProviderOptions } from './model.js';
import { FrameworkError } from './errors.js';
import type { ReleasePayload } from './release-types.js';

const [mode, manifest, releaseId] = process.argv.slice(2);
const controller = new AbortController();
const cancel = () => controller.abort(new FrameworkError('CANCELLED', 'Release run cancelled by its controller.'));
let start: Promise<unknown> | undefined;
if (mode === 'run') {
  start = new Promise(accept => process.on('message', message => {
    const data = message as { type: string; input?: unknown };
    if (data.type === 'start') accept(data.input);
    if (data.type === 'cancel') { cancel(); accept(undefined); }
  }));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  process.once('disconnect', cancel);
}

async function send(message: unknown) {
  if (process.connected && process.send) await new Promise<void>((accept, reject) => process.send!(message as object, error => error ? reject(error) : accept()));
}

async function main() {
  if (!manifest || !['probe', 'run'].includes(mode ?? '')) throw new FrameworkError('CONFIGURATION_ERROR', 'Internal release host requires a mode and manifest.');
  const payload = JSON.parse(await readFile(manifest, 'utf8')) as ReleasePayload;
  if (process.version !== payload.node.version) throw new FrameworkError('CAPABILITY_MISMATCH', 'Release Node version changed. Prepare a release with this runtime.');
  const root = dirname(manifest);
  const config = await loadApplicationConfiguration(join(root, payload.entry), payload.bindings);
  const workspace = new LocalWorkspace(payload.bindings.artifacts.path);
  validateCapabilities(config.application, { model: config.model, workspace });
  parseProviderOptions(config.model, config.providerOptions);
  const missing = Object.entries(config.application.tools).flatMap(([tool, definition]) => definition.permissions.filter(permission => !config.permissions?.includes(permission)).map(permission => `${tool}:${permission}`));
  if (missing.length) throw new FrameworkError('PERMISSION_DENIED', `Missing declared tool permissions: ${missing.join(', ')}.`);
  if (mode === 'probe') {
    console.log(JSON.stringify({ status: 'validated', model: config.model.id, harness: harnessCapabilities, components: config.components?.map(component => ({ id: component.id, status: 'configured; not connected' })), contactedProvider: false }));
    return;
  }
  if (!releaseId) throw new FrameworkError('CONFIGURATION_ERROR', 'Release identity is required.');
  const requested = await start;
  const store = new SQLiteRunStore(payload.bindings.state.path);
  try {
    const result = await runApplication(config.application, requested === undefined ? config.input : requested, {
      ...config, store, workspace, signal: controller.signal,
      release: { id: releaseId, environment: payload.environment, projectId: payload.projectId },
    });
    await send({ type: 'result', result: { ...result, error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : undefined } });
    if (result.status !== 'succeeded') process.exitCode = 1;
  } finally { store.close(); await workspace.close(); }
}

main().catch(async error => {
  await send({ type: 'error', error: { code: error instanceof FrameworkError ? error.code : 'CONFIGURATION_ERROR', message: error instanceof Error ? error.message : String(error) } });
  console.error(JSON.stringify({ code: error instanceof FrameworkError ? error.code : 'CONFIGURATION_ERROR', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}).finally(() => {
  if (process.connected) process.disconnect();
});