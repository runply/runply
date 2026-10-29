import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'runply-browser-'));
const app = join(temp, 'app');
let server; let browser; let closed;
let stderr = '';
try {
  await exec(process.execPath, [join(root, 'dist/cli.js'), 'new', app, '--package', root], { maxBuffer: 4 * 1024 * 1024 });
  const cli = join(app, 'node_modules/runply/dist/cli.js');
  server = spawn(process.execPath, [cli, 'dev', '--port', '0'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => server.once('close', resolve));
  server.stderr.on('data', chunk => { stderr += String(chunk); });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += String(chunk);
      for (const line of output.split('\n')) {
        try { const message = JSON.parse(line); if (message.url) resolve(message.url); } catch {}
      }
    });
    server.once('error', reject);
    server.once('close', code => reject(new Error(`dev exited ${code}: ${stderr}`)));
  });
  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath && process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try { await access(chrome); executablePath = chrome; } catch {}
  }
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  const externalRequests = [];
  await page.route('**/*', route => {
    if (route.request().url().startsWith(url + '/')) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Follow the work.' })).toBeVisible();
  await expect(page.locator('#build')).toContainText('ready');
  assert.equal((await (await page.request.get(url + '/api/runs')).json()).length, 0);
  await page.getByRole('button', { name: 'Run application', exact: true }).click();
  await expect(page.locator('#run-status')).toHaveText('succeeded');
  await expect(page.getByRole('link', { name: 'report.md', exact: true })).toBeVisible();
  await expect(page.locator('#events')).toContainText('tool.completed');
  const oldId = await page.locator('#run-id').innerText();
  const before = await (await page.request.get(url + '/api/status')).json();
  const document = join(app, 'documents/security.md');
  await writeFile(document, await readFile(document, 'utf8') + '\nData retention is now present in this test document.\n');
  await expect.poll(async () => (await (await page.request.get(url + '/api/status')).json()).generation).toBeGreaterThan(before.generation);
  assert.equal((await (await page.request.get(url + '/api/runs')).json()).length, 1, 'rebuild must not replay a run');
  await page.getByRole('button', { name: 'Run application', exact: true }).click();
  await expect(page.locator('#run-id')).not.toHaveText(oldId);
  await expect(page.locator('#run-status')).toHaveText('succeeded');
  const artifactPath = await page.getByRole('link', { name: 'report.json', exact: true }).getAttribute('href');
  const output = await (await page.request.get(url + artifactPath)).json();
  assert(output.checks.every(check => check.found));
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  assert.deepEqual(externalRequests, []);
  if (process.env.RUNPLY_SCREENSHOT) {
    const path = resolve(process.env.RUNPLY_SCREENSHOT); await mkdir(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Run application', exact: true })).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log(JSON.stringify({ status: 'passed', node: process.version, runs: 2, rebuildReexecutedRuns: 0, browserErrors: pageErrors, externalRequests, desktop: '1440x1100', mobile: '390x844' }, null, 2));
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await closed; }
  await rm(temp, { recursive: true, force: true });
}