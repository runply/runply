import { describe, expect, it, vi } from 'vitest';
import { request, type IncomingHttpHeaders } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { RunEvent, RunRecord } from '../src/contracts.js';
// Forked hosts require the existing compiled sibling modules; do not rebuild here.
import { startDev, type DevServer } from '../dist/dev.js';

// Keep real filesystem events, but expose readiness so edits never race watcher setup.
const watchers = vi.hoisted(() => ({ ready: [] as Array<{ value: boolean }> }));
vi.mock('chokidar', async importOriginal => {
  const original = await importOriginal<typeof import('chokidar')>();
  return { ...original, watch: (...args: Parameters<typeof original.watch>) => {
    const state = { value: false };
    watchers.ready.push(state);
    const watcher = original.watch(...args);
    watcher.once('ready', () => { state.value = true; });
    return watcher;
  } };
});

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactName = '<tag>.html';
const artifactContent = '<tag data-fixture="offline">Harmless model output & text</tag>';
type Status = {
  build: 'building' | 'ready' | 'failed'; buildError?: string; generation: number;
  lastBuild?: string; running: boolean; activeInvocations: string[];
  environment: string; automaticReexecution: boolean;
  components: { application: string; model: { id: string; status: string }; tools: string[] };
};
type Trace = { run: RunRecord; events: RunEvent[] };
type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
type Fixture = { root: string; project: string; projectFile: string; server: DevServer; token: string };

async function lines(path: string): Promise<string[]> {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do {
    last = await read();
    if (accepts(last)) return last;
    await delay(25);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function http(server: DevServer, path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {}): Promise<Reply> {
  const address = new URL(server.url);
  // Node's HTTP client preserves encoded traversal paths and permits a hostile Host header.
  return new Promise((accept, reject) => {
    const req = request({ hostname: address.hostname, port: address.port, path,
      method: options.method ?? 'GET', headers: options.headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => accept({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(2_000, () => req.destroy(new Error(`HTTP timeout: ${path}`)));
    req.on('error', reject);
    req.end(options.body);
  });
}

async function get<T>(server: DevServer, path: string): Promise<T> {
  const response = await http(server, path);
  expect(response.status, response.text).toBe(200);
  return JSON.parse(response.text) as T;
}
const status = (fixture: Fixture) => get<Status>(fixture.server, '/api/status');
const runs = (fixture: Fixture) => get<RunRecord[]>(fixture.server, '/api/runs');
const post = (fixture: Fixture, path: string, body = '{}') => http(fixture.server, path, {
  method: 'POST', body, headers: { 'content-type': 'application/json', 'x-runply-token': fixture.token, origin: fixture.server.url },
});

async function submit(fixture: Fixture, input?: unknown): Promise<string> {
  const response = await post(fixture, '/api/run', JSON.stringify(input === undefined ? {} : { input }));
  expect(response.status, response.text).toBe(202);
  const accepted = JSON.parse(response.text) as { accepted: boolean; invocationId: string };
  expect(accepted.accepted).toBe(true);
  expect(accepted.invocationId).toMatch(/^[a-f0-9]{32}$/);
  return accepted.invocationId;
}

async function finished(fixture: Fixture, count: number): Promise<RunRecord[]> {
  await until(() => status(fixture), value => !value.running, 'source processes to finish');
  const records = await runs(fixture);
  expect(records).toHaveLength(count);
  return records;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function withDev(build: boolean, test: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runply-dev-test-')));
  const project = join(root, 'npmfiles');
  const projectFile = join(project, 'agent.project.json');
  let server: DevServer | undefined;
  try {
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await symlink(repository, join(project, 'node_modules/runply'), 'dir');
    await symlink(join(repository, 'node_modules/zod'), join(project, 'node_modules/zod'), 'dir');
    await writeFile(join(project, 'package.json'), JSON.stringify({
      name: 'offline-dev-fixture', version: '1.0.0', type: 'module',
      files: ['app.mjs'], scripts: { build: 'node build.mjs' },
    }));
    await writeFile(projectFile, JSON.stringify({
      schemaVersion: 1, name: 'offline-dev-fixture', entry: 'app.mjs', defaultEnvironment: 'local',
      environments: { local: { state: { path: '../state/runs.sqlite' }, artifacts: { path: '../artifacts' },
        variables: { DEV_TEST_ROOT: root } } }, tooling: { watch: ['watched.txt'] },
    }));
    await writeFile(join(project, 'watched.txt'), 'initial\n');
    await writeFile(join(project, 'build.mjs'), `
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
appendFileSync('../build.log', process.pid + '\\n');
if (existsSync('../fail-build')) { console.error('fixture build failed'); process.exit(23); }
if (existsSync('../hold-build')) await setTimeout(8000);
`);
    await writeFile(join(project, 'app.mjs'), `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { defineApplication } from 'runply';
import { fakeModel, modelResponse } from 'runply/testing';
const root = process.env.DEV_TEST_ROOT;
const mark = (name, value) => appendFileSync(join(root, name), JSON.stringify(value) + '\\n');
process.once('exit', () => mark('exits.log', process.pid));
const application = defineApplication({
  name: 'offline-dev-<tag>', inputSchema: z.strictObject({ text: z.string(), hold: z.boolean().optional() }),
  outputSchema: z.strictObject({ html: z.string() }), tools: {},
  messages(input) { mark('runs.log', { pid: process.pid, input }); return [{ role: 'user', content: JSON.stringify(input) }]; },
  finalize(output) { return [{ name: ${JSON.stringify(artifactName)}, mediaType: 'text/html', content: output.html }]; },
});
const model = fakeModel(async ({ prompt, abortSignal }) => {
  mark('models.log', process.pid);
  const message = prompt.find(message => message.role === 'user');
  const input = JSON.parse(message.content.find(part => part.type === 'text').text);
  if (input.hold) {
    try { await setTimeout(8000, undefined, { signal: abortSignal }); }
    finally { mark('settled.log', process.pid); }
  }
  return modelResponse(JSON.stringify({ html: ${JSON.stringify(artifactContent)} }));
});
export default { application, model, input: { text: 'default input' } };
`);
    const watcherIndex = watchers.ready.length;
    server = await startDev({ projectFile, port: 0, build });
    expect(new URL(server.url).hostname).toBe('127.0.0.1');
    expect([3000, 5173, 5432, 5433]).not.toContain(Number(new URL(server.url).port));
    await until(async () => watchers.ready[watcherIndex]?.value, Boolean, 'real watcher readiness');
    const response = await http(server, '/');
    expect(response.status, response.text).toBe(200);
    const token = /const token=['"]([a-f0-9]{64})['"]/.exec(response.text)?.[1];
    expect(token).toBeDefined();
    const fixture = { root, project, projectFile, server, token: token! };
    const initial = await status(fixture);
    expect(initial.build, JSON.stringify(initial)).toBe('ready');
    await test(fixture);
  } finally {
    try { if (server) { await server.close(); await server.closed; } }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

describe('local development HTTP inspector', () => {
  it.each([true, false])('starts ready without running the application or model (build=%s)', async build => {
    await withDev(build, async fixture => {
      const current = await status(fixture);
      expect(current).toMatchObject({ build: 'ready', generation: 1, running: false, activeInvocations: [],
        environment: 'local', automaticReexecution: false,
        components: { application: 'offline-dev-<tag>', model: { id: 'offline:scripted', status: 'configured; not contacted' }, tools: [] } });
      expect(Number.isNaN(Date.parse(current.lastBuild!))).toBe(false);
      expect(current.buildError).toBeUndefined();
      expect(await runs(fixture)).toEqual([]);
      expect(await lines(join(fixture.root, 'runs.log'))).toEqual([]);
      expect(await lines(join(fixture.root, 'models.log'))).toEqual([]);
      expect(await lines(join(fixture.root, 'build.log'))).toHaveLength(build ? 1 : 0);
      await expect(readFile(join(fixture.root, 'state/runs.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('serves nonce-protected HTML with a stable session token and uncached API responses', async () => {
    await withDev(false, async fixture => {
      const first = await http(fixture.server, '/');
      const second = await http(fixture.server, '/');
      const nonce = /script-src 'nonce-([^']+)'/.exec(String(first.headers['content-security-policy']))?.[1];
      expect(nonce).toBeTruthy();
      expect(first.headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      for (const directive of ["default-src 'none'", `style-src 'nonce-${nonce}'`, "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
        expect(first.headers['content-security-policy']).toContain(directive);
      }
      expect(first.text).toContain(`<script nonce="${nonce}">`);
      expect(first.text).toContain(`<style nonce="${nonce}">`);
      expect(first.text).not.toMatch(/__TOKEN__|__NONCE__/);
      expect(first.text).toContain(fixture.token);
      expect(second.text).toContain(fixture.token);
      expect(second.headers['content-security-policy']).not.toBe(first.headers['content-security-policy']);
      for (const path of ['/api/status', '/api/runs']) {
        const response = await http(fixture.server, path);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.text).not.toContain(fixture.token);
      }
    });
  });

  it('rejects tokenless, incorrect-token, cross-origin, and DNS-rebinding requests without starting work', async () => {
    await withDev(false, async fixture => {
      for (const path of ['/api/run', '/api/cancel']) {
        for (const headers of [
          {}, { 'x-runply-token': 'incorrect' },
          { 'x-runply-token': 'z'.repeat(64) },
          { 'x-runply-token': 'é'.repeat(64) },
          { 'x-runply-token': fixture.token, origin: 'http://untrusted.invalid' },
          { 'x-runply-token': fixture.token, origin: 'null' },
        ] satisfies Array<Record<string, string>>) {
          const response = await http(fixture.server, path, { method: 'POST', headers, body: '{}' });
          expect(response.status, `${path}: ${response.text}`).toBe(403);
        }
      }
      for (const method of ['GET', 'POST']) {
        const response = await http(fixture.server, method === 'GET' ? '/api/status' : '/api/run', {
          method, headers: { host: 'rebound.invalid', 'x-runply-token': fixture.token },
        });
        expect(response.status).toBe(403);
        expect(response.text).toMatch(/host/i);
      }
      expect((await status(fixture)).running).toBe(false);
      expect(await runs(fixture)).toEqual([]);
      expect(await lines(join(fixture.root, 'models.log'))).toEqual([]);
    });
  });

  it('records explicit repeated runs, ordered traces, and harmless HTML artifacts downloaded as bytes', async () => {
    await withDev(false, async fixture => {
      const firstInvocation = await submit(fixture, { text: 'explicit override' });
      const [first] = await finished(fixture, 1);
      expect(first).toMatchObject({ application: 'offline-dev-<tag>', status: 'succeeded' });
      const trace = await get<Trace>(fixture.server, `/api/runs/${first!.id}`);
      expect(trace.run).toEqual(first);
      expect(trace.events.map(event => event.type)).toEqual(expect.arrayContaining(['run.started', 'model.started', 'model.completed', 'artifact.created', 'run.status']));
      expect(trace.events.every(event => event.runId === first!.id)).toBe(true);
      expect(trace.events.map(event => event.sequence)).toEqual(trace.events.map((_, index) => index + 1));
      const artifact = trace.events.find(event => event.type === 'artifact.created');
      expect(artifact?.data).toMatchObject({ name: artifactName, bytes: Buffer.byteLength(artifactContent),
        sha256: createHash('sha256').update(artifactContent).digest('hex') });
      const download = await http(fixture.server, `/api/runs/${first!.id}/artifacts/${encodeURIComponent(artifactName)}`);
      expect(download.status, download.text).toBe(200);
      expect(download.headers).toMatchObject({ 'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifactName)}`, 'x-content-type-options': 'nosniff' });
      expect(download.text).toBe(artifactContent);
      expect(await readFile(join(fixture.root, 'artifacts', first!.id, artifactName), 'utf8')).toBe(artifactContent);
      const secondInvocation = await submit(fixture);
      expect(secondInvocation).not.toBe(firstInvocation);
      const records = await finished(fixture, 2);
      expect(new Set(records.map(run => run.id)).size).toBe(2);
      expect(records.every(run => run.status === 'succeeded')).toBe(true);
      expect((await lines(join(fixture.root, 'runs.log'))).map(line => (JSON.parse(line) as { input: unknown }).input))
        .toEqual([{ text: 'explicit override' }, { text: 'default input' }]);
      expect(await lines(join(fixture.root, 'models.log'))).toHaveLength(2);
    });
  });

  it('rejects encoded artifact traversal, unrecorded files, and absent runs', async () => {
    await withDev(false, async fixture => {
      await submit(fixture);
      const [run] = await finished(fixture, 1);
      await writeFile(join(fixture.root, 'artifacts', run!.id, 'unrecorded.txt'), 'not a published artifact');
      for (const path of [
        `/api/runs/${run!.id}/artifacts/..%2Fsecret`,
        `/api/runs/${run!.id}/artifacts/..%5Csecret`,
        `/api/runs/${run!.id}/artifacts/%2e%2e%2f..%2fsecret`,
        `/api/runs/..%2Foutside/artifacts/${encodeURIComponent(artifactName)}`,
        `/api/runs/..%5Coutside/artifacts/${encodeURIComponent(artifactName)}`,
      ]) {
        const response = await http(fixture.server, path);
        expect(response.status, `${path}: ${response.text}`).toBe(400);
      }
      expect((await http(fixture.server, `/api/runs/${run!.id}/artifacts/unrecorded.txt`)).status).toBe(404);
      expect((await http(fixture.server, '/api/runs/absent-run')).status).toBe(404);
      expect((await http(fixture.server, '/no-such-route')).status).toBe(404);
    });
  });

  it('rejects malformed JSON and non-object request bodies without invoking the model', async () => {
    await withDev(false, async fixture => {
      for (const body of ['{', '{"input":', 'null', '[]', '"text"', '42']) {
        const response = await post(fixture, '/api/run', body);
        expect(response.status, `${body}: ${response.text}`).toBe(400);
        expect(JSON.parse(response.text)).toHaveProperty('error');
      }
      expect(await runs(fixture)).toEqual([]);
      expect(await lines(join(fixture.root, 'models.log'))).toEqual([]);
      expect((await status(fixture)).running).toBe(false);
    });
  });

  it('rebuilds watched changes without replay, exposes build failures, and permits runs after recovery', async () => {
    await withDev(true, async fixture => {
      await submit(fixture);
      await finished(fixture, 1);
      const before = await status(fixture);
      await appendFile(join(fixture.project, 'watched.txt'), 'rebuild\n');
      const rebuilt = await until(() => status(fixture), value => value.build === 'ready' && value.generation > before.generation, 'successful watched rebuild');
      expect(await lines(join(fixture.root, 'build.log'))).toHaveLength(rebuilt.generation);
      expect(await runs(fixture)).toHaveLength(1);
      expect(await lines(join(fixture.root, 'models.log'))).toHaveLength(1);
      await writeFile(join(fixture.root, 'fail-build'), 'fail');
      await appendFile(join(fixture.project, 'watched.txt'), 'failure\n');
      const failed = await until(() => status(fixture), value => value.build === 'failed', 'failed build status');
      expect(failed.buildError).toMatch(/build.*failed.*23/i);
      expect(failed.generation).toBe(rebuilt.generation);
      expect((await post(fixture, '/api/run')).status).toBe(409);
      expect(await runs(fixture)).toHaveLength(1);
      expect(await lines(join(fixture.root, 'models.log'))).toHaveLength(1);
      await rm(join(fixture.root, 'fail-build'));
      await appendFile(join(fixture.project, 'watched.txt'), 'recovery\n');
      const recovered = await until(() => status(fixture), value => value.build === 'ready' && value.generation > rebuilt.generation, 'build recovery');
      expect(recovered.buildError).toBeUndefined();
      expect(await lines(join(fixture.root, 'models.log'))).toHaveLength(1);
      await submit(fixture);
      expect((await finished(fixture, 2)).every(run => run.status === 'succeeded')).toBe(true);
    });
  }, 30_000);

  it('does not lose accepted concurrent runs when the state database is first created', async () => {
    await withDev(false, async fixture => {
      const ids = [await submit(fixture, { text: 'first', hold: true }), await submit(fixture, { text: 'second', hold: true })];
      const started = await until(async () => ({
        pids: await lines(join(fixture.root, 'models.log')), state: await status(fixture),
      }), value => value.pids.length === 2 || Boolean(value.state.buildError) || !value.state.running, 'both cold-start models');
      expect(started.pids, JSON.stringify(started.state)).toHaveLength(2);
      expect((await status(fixture)).activeInvocations.sort()).toEqual(ids.sort());
      expect(await runs(fixture)).toHaveLength(2);
    });
  }, 25_000);

  it('cancels every active explicit run and waits for its source processes to exit', async () => {
    await withDev(false, async fixture => {
      // Let the first host finish schema creation; cold-start contention is tested separately.
      const first = await submit(fixture, { text: 'first', hold: true });
      await until(() => lines(join(fixture.root, 'models.log')), value => value.length === 1, 'first active model');
      const second = await submit(fixture, { text: 'second', hold: true });
      const modelPids = (await until(() => lines(join(fixture.root, 'models.log')), value => value.length === 2, 'second active model')).map(Number);
      expect((await status(fixture)).activeInvocations.sort()).toEqual([first, second].sort());
      const cancelled = await post(fixture, '/api/cancel');
      expect(cancelled.status).toBe(202);
      expect(JSON.parse(cancelled.text)).toEqual({ requested: 2 });
      expect((await finished(fixture, 2)).map(run => run.status)).toEqual(['cancelled', 'cancelled']);
      for (const pid of modelPids) {
        expect(alive(pid)).toBe(false);
        expect(await lines(join(fixture.root, 'settled.log'))).toContain(String(pid));
        expect(await lines(join(fixture.root, 'exits.log'))).toContain(String(pid));
      }
      expect(JSON.parse((await post(fixture, '/api/cancel')).text)).toEqual({ requested: 0 });
      await submit(fixture);
      expect((await finished(fixture, 3)).filter(run => run.status === 'succeeded')).toHaveLength(1);
    });
  }, 30_000);

  it('close drains an active model process, settles closed, and is idempotent', async () => {
    await withDev(false, async fixture => {
      await submit(fixture, { text: 'close me', hold: true });
      const [pid] = (await until(() => lines(join(fixture.root, 'models.log')), value => value.length === 1, 'active model')).map(Number);
      expect(alive(pid!)).toBe(true);
      const closing = fixture.server.close();
      expect(fixture.server.close()).toBe(closing);
      await closing;
      await fixture.server.closed;
      expect(alive(pid!)).toBe(false);
      expect(await lines(join(fixture.root, 'settled.log'))).toContain(String(pid));
      expect(await lines(join(fixture.root, 'exits.log'))).toContain(String(pid));
      await expect(http(fixture.server, '/api/status')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });
  }, 25_000);

  it('blocks runs during a watched build and close terminates the owned build process', async () => {
    await withDev(true, async fixture => {
      await writeFile(join(fixture.root, 'hold-build'), 'hold');
      await appendFile(join(fixture.project, 'watched.txt'), 'long build\n');
      const pids = await until(() => lines(join(fixture.root, 'build.log')), value => value.length >= 2, 'watched build process');
      const pid = Number(pids.at(-1));
      expect((await status(fixture)).build).toBe('building');
      expect((await post(fixture, '/api/run')).status).toBe(409);
      expect(alive(pid)).toBe(true);
      await fixture.server.close();
      await fixture.server.closed;
      await until(async () => alive(pid), value => !value, 'build child exit');
      expect(await lines(join(fixture.root, 'models.log'))).toEqual([]);
    });
  }, 25_000);
});