import { loadApplicationConfiguration } from './application-config.js';
import { bindProcessEnvironment } from './project.js';
import { SQLiteRunStore } from './store.js';
import { LocalWorkspace } from './workspace.js';
import { runApplication, validateCapabilities, harnessCapabilities } from './runtime.js';
import { parseProviderOptions } from './model.js';
import { FrameworkError } from './errors.js';
import type { SourceInvocation } from './source-run.js';

const controller = new AbortController();
const cancel = () => controller.abort(new FrameworkError('CANCELLED', 'Source run cancelled.'));
const request = new Promise<SourceInvocation | undefined>(accept => process.on('message', message => {
  const data = message as { type: string; invocation?: SourceInvocation };
  if (data.type === 'start') accept(data.invocation);
  if (data.type === 'cancel') { cancel(); accept(undefined); }
}));
process.once('SIGINT', cancel); process.once('SIGTERM', cancel); process.once('disconnect', cancel);
async function send(value: object) { if (process.connected) await new Promise<void>((accept, reject) => process.send!(value, error => error ? reject(error) : accept())); }

async function main() {
  const invocation = await request;
  controller.signal.throwIfAborted();
  if (!invocation) throw new FrameworkError('INVALID_INPUT', 'No application invocation supplied.');
  if (invocation.bindings) Object.assign(process.env, bindProcessEnvironment(invocation.bindings));
  const config = await loadApplicationConfiguration(invocation.app, invocation.bindings);
  const workspace = new LocalWorkspace(invocation.artifacts);
  validateCapabilities(config.application, { model: config.model, workspace });
  parseProviderOptions(config.model, config.providerOptions);
  if (invocation.mode === 'doctor') {
    await send({ type: 'result', result: {
      application: config.application.name, model: { id: config.model.id, capabilities: config.model.capabilities, status: 'configured; not contacted' },
      harness: harnessCapabilities, workspace: workspace.capabilities,
      tools: Object.keys(config.application.tools), components: config.components?.map(component => ({ id: component.id, status: 'configured; not connected' })) ?? [],
    } }); return;
  }
  const store = new SQLiteRunStore(invocation.database);
  try {
    const result = await runApplication(config.application, invocation.input === undefined ? config.input : invocation.input, { ...config, store, workspace, signal: controller.signal, captureContent: invocation.captureContent });
    await send({ type: 'result', result: { ...result, error: result.error ? { code: result.error.code, message: result.error.message } : undefined } });
    if (result.status !== 'succeeded') process.exitCode = 1;
  } finally { store.close(); await workspace.close(); }
}
main().catch(async error => {
  await send({ type: 'error', error: { code: error instanceof FrameworkError ? error.code : 'CONFIGURATION_ERROR', message: error instanceof Error ? error.message : String(error) } });
  process.exitCode = 1;
}).finally(() => { if (process.connected) process.disconnect(); });