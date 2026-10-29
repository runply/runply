import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'chokidar';
import { sourceInvocation } from './cli-project.js';
import { invokeSource } from './source-run.js';
import { runProjectTask } from './tooling.js';
import { loadProject, isWithin } from './project.js';
import { SQLiteRunStore } from './store.js';
import { FrameworkError } from './errors.js';

export interface DevOptions { projectFile: string; environment?: string; port?: number; build?: boolean; signal?: AbortSignal }
export interface DevServer { url: string; close(): Promise<void>; closed: Promise<void> }

export async function startDev(options: DevOptions): Promise<DevServer> {
  const projectFile = resolve(options.projectFile);
  const root = dirname(projectFile);
  const loaded = await loadProject(projectFile, options.environment);
  const token = randomBytes(32).toString('hex');
  const lifetime = new AbortController();
  let buildState: 'building' | 'ready' | 'failed' = 'building';
  let buildError: string | undefined;
  let lastBuild: string | undefined;
  let generation = 0;
  let pendingBuild = false;
  let buildJob: Promise<void> | undefined;
  const active = new Map<string, { controller: AbortController; work: Promise<unknown> }>();
  let disposed = false;
  const diagnostics: Record<string, unknown> = {};

  const rebuild = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (buildJob) { pendingBuild = true; return buildJob; }
    buildJob = (async () => {
      do {
        pendingBuild = false; buildState = 'building'; buildError = undefined;
        try {
          if (options.build !== false) await runProjectTask('build', root, { projectFile, signal: lifetime.signal });
          const invocation = await sourceInvocation(projectFile, options.environment);
          Object.assign(diagnostics, await invokeSource({ ...invocation, mode: 'doctor' }, { signal: lifetime.signal }));
          buildState = 'ready'; generation++; lastBuild = new Date().toISOString();
        } catch (error) { buildState = 'failed'; buildError = error instanceof Error ? error.message : String(error); }
      } while (pendingBuild && !disposed);
    })().finally(() => { buildJob = undefined; });
    return buildJob;
  };
  const status = () => ({ build: buildState, buildError, generation, lastBuild, running: active.size > 0, activeInvocations: [...active.keys()], environment: options.environment ?? loaded.environment, components: diagnostics, automaticReexecution: false });
  const readStore = async <T>(read: (store: SQLiteRunStore) => T, missing: T): Promise<T> => {
    const invocation = await sourceInvocation(projectFile, options.environment);
    try { await access(invocation.database); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing; throw error; }
    const store = new SQLiteRunStore(invocation.database, { readOnly: true });
    try { return read(store); } finally { store.close(); }
  };
  let base = '';
  function reply(response: ServerResponse, code: number, value: unknown) {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  }
  function permitted(request: IncomingMessage): boolean {
    const actual = request.headers['x-runply-token'];
    return typeof actual === 'string' && actual.length === token.length && timingSafeEqual(Buffer.from(actual), Buffer.from(token));
  }
  async function route(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== new URL(base).host) { reply(response, 403, { error: 'Invalid local inspector host.' }); return; }
    const url = new URL(request.url ?? '/', base);
    if (request.method === 'POST' && (!permitted(request) || request.headers.origin && request.headers.origin !== base)) { reply(response, 403, { error: 'Local inspector session token required.' }); return; }
    if (request.method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(18).toString('base64');
      const html = (await readFile(join(dirname(fileURLToPath(import.meta.url)), '../templates/inspector.html'), 'utf8')).replaceAll('__NONCE__', nonce).replaceAll('__TOKEN__', token);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`,
      }); response.end(html); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/status') { reply(response, 200, status()); return; }
    if (request.method === 'GET' && url.pathname === '/api/runs') { reply(response, 200, await readStore(store => store.list(), [])); return; }
    const match = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && match) {
      const id = decodeURIComponent(match[1]!);
      const run = await readStore(store => ({ run: store.get(id), events: store.events(id) }), null);
      reply(response, run ? 200 : 404, run ?? { error: 'Run not found.' }); return;
    }
    const artifact = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && artifact) {
      const id = decodeURIComponent(artifact[1]!); const name = decodeURIComponent(artifact[2]!);
      if ([id, name].some(value => value.includes('/') || value.includes('\\') || value === '..' || value === '.')) { reply(response, 400, { error: 'Invalid artifact path.' }); return; }
      const recorded = await readStore(store => store.events(id).some(event => event.type === 'artifact.created' && (event.data as { name?: string })?.name === name), false);
      if (!recorded) { reply(response, 404, { error: 'Artifact not recorded.' }); return; }
      const invocation = await sourceInvocation(projectFile, options.environment);
      const artifactRoot = await realpath(invocation.artifacts);
      const path = await realpath(join(artifactRoot, id, name));
      if (!isWithin(artifactRoot, path)) { reply(response, 403, { error: 'Artifact is outside its workspace.' }); return; }
      // Download as plain bytes: never execute model-generated HTML in the inspector origin.
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'X-Content-Type-Options': 'nosniff' });
      response.end(await readFile(path)); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/run') {
      if (buildState !== 'ready' || disposed) { reply(response, 409, { error: 'Wait for the current build to finish.' }); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let payload: { input?: unknown };
      try { payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: unknown } : {}; }
      catch { reply(response, 400, { error: 'Run input must be JSON.' }); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { reply(response, 400, { error: 'Expected a JSON request object.' }); return; }
      const controller = new AbortController();
      const invocation = await sourceInvocation(projectFile, options.environment);
      if (disposed || buildState !== 'ready') { reply(response, 409, { error: 'The application build changed; try again when ready.' }); return; }
      const invocationId = randomBytes(16).toString('hex');
      const work = invokeSource({ ...invocation, input: payload.input }, { signal: AbortSignal.any([controller.signal, lifetime.signal]) });
      active.set(invocationId, { controller, work });
      void work.catch(error => { buildError = error instanceof Error ? error.message : String(error); }).finally(() => { active.delete(invocationId); });
      reply(response, 202, { accepted: true, invocationId }); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/cancel') { const count = active.size; for (const entry of active.values()) entry.controller.abort(); reply(response, 202, { requested: count }); return; }
    reply(response, 404, { error: 'Not found.' });
  }
  const server = createServer((request, response) => { void route(request, response).catch(error => reply(response, error instanceof FrameworkError && error.code === 'NOT_FOUND' ? 404 : 500, { error: error instanceof Error ? error.message : String(error) })); });
  const port = options.port ?? 3005;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FrameworkError('CONFIGURATION_ERROR', 'Inspector port must be a valid TCP port.');
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); accept(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new FrameworkError('CONFIGURATION_ERROR', 'Inspector did not get a TCP address.');
  base = `http://127.0.0.1:${address.port}`;
  const watcher = watch((loaded.project.tooling?.watch ?? ['src', 'documents', 'package.json', 'tsconfig.json', projectFile]).map(path => resolve(root, path)), { ignoreInitial: true });
  watcher.on('all', () => { void rebuild(); });
  watcher.on('error', error => { buildState = 'failed'; buildError = `File watcher failed: ${error instanceof Error ? error.message : String(error)}`; });
  let finish!: () => void;
  const closed = new Promise<void>(accept => { finish = accept; });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    disposed = true; lifetime.abort(new FrameworkError('CANCELLED', 'Development server closed.')); for (const entry of active.values()) entry.controller.abort();
    options.signal?.removeEventListener('abort', onAbort);
    await watcher.close(); await Promise.allSettled([buildJob, ...[...active.values()].map(entry => entry.work)].filter(Boolean));
    await new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); }); finish();
  })();
  const onAbort = () => { void close(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) await close(); else await rebuild();
  return { url: base, close, closed };
}