import { fork } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvironmentDefinition } from './project.js';
import type { RunResult } from './runtime.js';
import { FrameworkError, type ErrorCode } from './errors.js';

export interface SourceInvocation {
  app: string;
  root: string;
  database: string;
  artifacts: string;
  input?: unknown;
  bindings?: EnvironmentDefinition;
  captureContent?: boolean;
  mode?: 'run' | 'doctor';
}

/** Fresh module graph per invocation; JSON results use IPC, application logs do not. */
export async function invokeSource(invocation: SourceInvocation, options: { signal?: AbortSignal; onOutput?: (text: string) => void } = {}): Promise<RunResult<unknown> | Record<string, unknown>> {
  options.signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    let result: RunResult<unknown> | Record<string, unknown> | undefined;
    let failure: Error | undefined;
    const child = fork(join(dirname(fileURLToPath(import.meta.url)), 'source-host.js'), [], {
      cwd: resolve(invocation.root), execPath: process.execPath, execArgv: [], serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const log = (chunk: Buffer) => { if (options.onOutput) options.onOutput(chunk.toString()); else process.stderr.write(chunk); };
    child.stdout?.on('data', log); child.stderr?.on('data', log);
    const cancel = () => { if (child.connected) child.send({ type: 'cancel' }, () => {}); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.once('spawn', () => {
      try { child.send({ type: 'start', invocation }, error => { if (error) { failure = error; cancel(); } }); }
      catch (error) { failure = new FrameworkError('INVALID_INPUT', 'Application input could not be transferred.', { cause: error }); cancel(); }
      if (options.signal?.aborted) cancel();
    });
    child.on('message', message => {
      const data = message as { type: string; result?: typeof result; error?: { code: ErrorCode; message: string } };
      if (data.type === 'result') result = data.result;
      if (data.type === 'error') failure = new FrameworkError(data.error?.code ?? 'CONFIGURATION_ERROR', data.error?.message ?? 'Application host failed.');
    });
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      options.signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (result) accept(result);
      else reject(new FrameworkError(options.signal?.aborted ? 'CANCELLED' : 'CONFIGURATION_ERROR', `Application process exited without a result (${signal ?? code}).`));
    });
  });
}