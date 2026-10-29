#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { brand } from './brand.js';
import { runApplication, validateCapabilities, harnessCapabilities } from './runtime.js';
import { SQLiteRunStore } from './store.js';
import { LocalWorkspace } from './workspace.js';
import { FrameworkError } from './errors.js';
import { parseProviderOptions } from './model.js';
import type { Application, RuntimeOptions } from './contracts.js';
import { defaultProjectFile, planProject, describePlan, deployProject, releaseStatus, pauseEnvironment, runRelease } from './releases.js';
import { runProjectTask, generateTool, renderToolRegistry } from './tooling.js';
import { sourceInvocation, addMcp } from './cli-project.js';
import { invokeSource } from './source-run.js';
import { startDev } from './dev.js';
import { loadApplicationConfiguration } from './application-config.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string; version: string; dependencies: Record<string, string>; devDependencies: Record<string, string>;
};

interface AppConfiguration {
  application: Application;
  model: RuntimeOptions['model'];
  input: unknown;
  permissions?: readonly string[];
  providerOptions?: RuntimeOptions['providerOptions'];
}

async function configuration(path?: string): Promise<AppConfiguration> {
  if (path) {
    return loadApplicationConfiguration(path);
  }
  const example = (await import('./example.js')).default;
  return { ...example, application: example.application as Application, input: { ...example.input, documents: example.input.documents.map(path => join(packageRoot, 'templates', path)) } };
}

async function createStarter(target: string, packageSource: string | undefined, options: { install: boolean; build: boolean; signal: AbortSignal }) {
  const root = resolve(target);
  // Creating the root exclusively avoids overwriting even an empty existing project.
  await mkdir(root, { recursive: false });
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'src/tools'));
  await mkdir(join(root, 'documents'));
  const dependency = `file:${resolve(packageSource ?? packageRoot)}`;
  const app = "import { generatedTools } from './tools/index.js';\n" + (await readFile(join(packageRoot, 'src/example.ts'), 'utf8'))
    .replaceAll("'./tools.js'", `'${metadata.name}'`)
    .replaceAll("'./errors.js'", `'${metadata.name}'`)
    .replaceAll("'./testing/index.js'", `'${metadata.name}/testing'`)
    .replace('  tools: {', '  tools: {\n    ...generatedTools,');
  await writeFile(join(root, 'src/app.ts'), app, { flag: 'wx' });
  await writeFile(join(root, 'src/tools/index.ts'), renderToolRegistry([]), { flag: 'wx' });
  const test = (await readFile(join(packageRoot, 'templates/app.test.ts'), 'utf8')).replaceAll('__PACKAGE__', metadata.name);
  await writeFile(join(root, 'src/app.test.ts'), test, { flag: 'wx' });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'document-reviewer-app', version: '0.0.0', private: true, type: 'module', license: 'MIT',
    files: ['dist', 'documents'],
    engines: { node: '>=22.13.0' },
    scripts: {
      build: 'tsc',
      start: `${brand.command} run`,
      doctor: `${brand.command} doctor`,
      inspect: `${brand.command} inspect`,
      plan: `${brand.command} plan`,
      deploy: `${brand.command} deploy`,
      'start:deployed': `${brand.command} run --project ${defaultProjectFile}`,
      status: `${brand.command} status`,
      pause: `${brand.command} pause`,
      test: "node --test 'dist/**/*.test.js'",
    },
    dependencies: { [metadata.name]: dependency, zod: metadata.dependencies.zod },
    devDependencies: { typescript: metadata.devDependencies.typescript, '@types/node': metadata.devDependencies['@types/node'] },
  }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: ['node'],
    outDir: 'dist', rootDir: 'src', skipLibCheck: true,
  }, include: ['src/**/*.ts'] }, null, 2) + '\n', { flag: 'wx' });
  for (const path of ['documents/handbook.md', 'documents/security.md']) await copyFile(join(packageRoot, 'templates', path), join(root, path));
  await copyFile(join(packageRoot, 'LICENSE'), join(root, 'LICENSE'));
  await copyFile(join(packageRoot, 'templates/README.md'), join(root, 'README.md'));
  await writeFile(join(root, defaultProjectFile), JSON.stringify({
    schemaVersion: 1, name: 'document-reviewer', entry: 'dist/app.js', defaultEnvironment: 'development',
    environments: Object.fromEntries(['development', 'staging'].map(environment => [environment, {
      target: 'local-process', model: 'offline',
      state: { path: `${brand.dataDirectory}/environments/${environment}/runs.sqlite` },
      artifacts: { path: `${brand.dataDirectory}/environments/${environment}/artifacts` },
      requirements: { persistentState: true, artifacts: true },
    }])),
  }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(root, '.gitignore'), `node_modules/\ndist/\n${brand.dataDirectory}/\n.env\n`, { flag: 'wx' });
  if (options.install) await runProjectTask('install', root, options);
  if (options.build) await runProjectTask('build', root, options);
  console.log(JSON.stringify({ created: root, profile: 'offline:scripted', dependency, installed: options.install, built: options.build,
    next: options.build ? [`cd ${root}`, `${brand.command} dev`, `${brand.command} run`, `${brand.command} test`] : [`cd ${root}`, `${brand.command} install`, `${brand.command} build`] }, null, 2));
}

const help = `${brand.name} ${metadata.version} — offline-first agent applications

${brand.command} new <directory> [--package <local-package-directory-or-tgz>] [--no-install] [--no-build]
${brand.command} install | build | test [--project <project.json>]
${brand.command} dev [--env <name>] [--port 3005]
${brand.command} generate tool <name>
${brand.command} add mcp <name> --command <executable> [--arg <argument>] [--env <name>]
${brand.command} add mcp <name> --url <HTTP-MCP-endpoint> [--header-env Authorization=TOKEN_ENV]
${brand.command} run [--app <built-module.js>] [--input <input.json>] [--data <directory>]
${brand.command} doctor [--app <built-module.js>]
${brand.command} inspect [run-id] [--data <directory>]
${brand.command} recover <run-id> [--data <directory>]
${brand.command} plan [--project <project.json>] [--env <name>] [--control <directory>]
${brand.command} deploy [--env <name>] [--expect-plan <plan-id>]
${brand.command} status [--env <name>]
${brand.command} pause [--env <name>]
${brand.command} run --env <name> [--input <input.json>]
${brand.command} inspect [run-id] --env <name>

run: builds and runs the current source project, or the bundled offline reviewer outside a project. --env/--project select a deployed release unless --source is set. Never selects a live provider implicitly.
inspect: read-only trace playback; no application module is loaded and no tools execute.
recover: marks a run interrupted only when its local owning process is no longer alive. Never resumes it.
Use the library API for approvals and additional runtime configuration.
plan prepares the build, then inventories package files without importing application code. --no-build is the read-only planning path. deploy with --expect-plan never rebuilds reviewed bytes. No framework model/tool calls or cloud resources are created by deployment.
run --env starts a fresh process from the admitted release. pause stops new admissions; existing runs continue. Redeploy to resume admission.
dev watches and rebuilds but never automatically re-executes a run. Token streaming and resumable sessions are not implemented.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      app: { type: 'string' }, input: { type: 'string' }, data: { type: 'string' }, package: { type: 'string' },
      project: { type: 'string' }, env: { type: 'string' }, control: { type: 'string' }, 'expect-plan': { type: 'string' },
      'no-install': { type: 'boolean' }, 'no-build': { type: 'boolean' }, source: { type: 'boolean' },
      port: { type: 'string' }, command: { type: 'string' }, arg: { type: 'string', multiple: true }, url: { type: 'string' },
      'header-env': { type: 'string', multiple: true }, permission: { type: 'string', multiple: true }, approval: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    },
  });
  if (values.version) { console.log(metadata.version); return; }
  const [command, argument, ...extra] = positionals;
  if (!command || values.help) { console.log(help); return; }
  if (extra.length && !['generate', 'add'].includes(command)) throw new FrameworkError('CONFIGURATION_ERROR', 'Unexpected positional arguments.');
  const accepted: Record<string, readonly string[]> = {
    new: ['package', 'no-install', 'no-build'], run: ['app', 'input', 'data', 'project', 'env', 'control', 'no-build', 'source'], doctor: ['app', 'project', 'env', 'no-build'], inspect: ['data', 'project', 'env', 'control'], recover: ['data', 'project', 'env', 'control'],
    plan: ['project', 'env', 'control', 'no-build'], deploy: ['project', 'env', 'control', 'expect-plan', 'no-build'], status: ['project', 'env', 'control'], pause: ['project', 'env', 'control'],
    install: ['project'], build: ['project'], test: ['project', 'no-build'], dev: ['project', 'env', 'port', 'no-build'],
    generate: ['project'], add: ['project', 'env', 'command', 'arg', 'url', 'header-env', 'permission', 'approval'],
  };
  if (!accepted[command]) throw new FrameworkError('CONFIGURATION_ERROR', `Unknown command ${command}. Use --help.`);
  for (const key of Object.keys(values)) if (!accepted[command].includes(key)) throw new FrameworkError('CONFIGURATION_ERROR', `--${key} is not supported for ${command}.`);
  if (argument && ['run', 'doctor', 'plan', 'deploy', 'status', 'pause', 'install', 'build', 'test', 'dev'].includes(command)) throw new FrameworkError('CONFIGURATION_ERROR', `${command} does not take a positional argument.`);
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new FrameworkError('CANCELLED', 'CLI operation cancelled.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
  const file = resolve(values.project ?? defaultProjectFile);
  const root = dirname(file);
  let hasProject = false;
  try { await access(file); hasProject = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!hasProject && (values.source || values.project && ['install', 'build', 'test', 'doctor', 'dev', 'generate', 'add'].includes(command) || command === 'doctor' && values.env)) throw new FrameworkError('CONFIGURATION_ERROR', `Project definition was not found: ${file}`);
  if (command === 'doctor' && values.app && (values.env || values.project)) throw new FrameworkError('CONFIGURATION_ERROR', 'Select either a source app module or project environment for diagnosis.');
  const build = () => runProjectTask('build', root, { signal: lifetime.signal, projectFile: file });
  if (command === 'install' || command === 'build' || command === 'test') {
    if (command === 'test' && !values['no-build']) await build();
    console.log(JSON.stringify(await runProjectTask(command, root, { signal: lifetime.signal, projectFile: file })));
    return;
  }
  if (command === 'generate') {
    if (argument !== 'tool' || extra.length !== 1) throw new FrameworkError('CONFIGURATION_ERROR', 'Use generate tool <name>.');
    console.log(JSON.stringify(await generateTool(root, extra[0]!), null, 2)); return;
  }
  if (command === 'add') {
    if (argument !== 'mcp' || extra.length !== 1) throw new FrameworkError('CONFIGURATION_ERROR', 'Use add mcp <name> with --command or --url.');
    if (Boolean(values.command) === Boolean(values.url)) throw new FrameworkError('CONFIGURATION_ERROR', 'Specify exactly one MCP transport: --command or --url.');
    if (values.command && values['header-env']?.length || values.url && values.arg?.length) throw new FrameworkError('CONFIGURATION_ERROR', 'MCP transport options do not match the selected transport.');
    const headers = Object.fromEntries((values['header-env'] ?? []).map(entry => {
      const separator = entry.indexOf('=');
      if (separator < 1 || separator === entry.length - 1) throw new FrameworkError('CONFIGURATION_ERROR', 'Header references use Header-Name=ENV_NAME, not a secret value.');
      return [entry.slice(0, separator), { env: entry.slice(separator + 1) }];
    }));
    const policy = { permissions: values.permission, approval: values.approval };
    console.log(JSON.stringify(await addMcp(file, values.env, extra[0]!, values.command
      ? { transport: 'stdio', command: values.command, args: values.arg, ...policy }
      : { transport: 'http', url: values.url!, headers, ...policy }), null, 2)); return;
  }
  if (command === 'dev') {
    const server = await startDev({ projectFile: file, environment: values.env, port: values.port === undefined ? 3005 : Number(values.port), build: !values['no-build'], signal: lifetime.signal });
    console.log(JSON.stringify({ status: 'ready', url: server.url, mode: 'local-development; no automatic run' }));
    await server.closed; return;
  }
  const projectOptions = { projectFile: values.project, environment: values.env, controlRoot: values.control };
  const useRelease = (values.env !== undefined || values.project !== undefined || values.control !== undefined) && !values.source && command !== 'doctor';
  if (values.source && (values.control || values.app)) throw new FrameworkError('CONFIGURATION_ERROR', '--source uses project bindings, not --control or --app.');
  if (useRelease && (values.app || values.data)) throw new FrameworkError('CONFIGURATION_ERROR', 'Environment bindings and explicit --app/--data cannot be combined; select one source of configuration.');
  if (command === 'plan') { if (!values['no-build']) await build(); console.log(JSON.stringify(describePlan(await planProject(projectOptions)), null, 2)); return; }
  if (command === 'deploy') { if (!values['no-build'] && !values['expect-plan']) await build(); console.log(JSON.stringify(await deployProject({ ...projectOptions, expectedPlan: values['expect-plan'] }), null, 2)); return; }
  if (command === 'pause') { console.log(JSON.stringify(await pauseEnvironment(projectOptions), null, 2)); return; }
  if (command === 'status') {
    const status = await releaseStatus(projectOptions);
    console.log(JSON.stringify({ environment: status.environment, releaseId: status.releaseId, revision: status.revision, paused: status.paused, admittedTarget: 'local-process', createdAt: status.release?.createdAt, bindings: status.release ? { model: status.release.payload.bindings.model, state: status.release.payload.bindings.state, artifacts: status.release.payload.bindings.artifacts } : null }, null, 2));
    return;
  }
  if (command === 'run' && useRelease) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const input: unknown = values.input ? JSON.parse(await readFile(resolve(values.input), 'utf8')) : undefined;
      const result = await runRelease({ ...projectOptions, input, signal: controller.signal });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'succeeded') process.exitCode = 1;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    return;
  }
  if (command === 'new') {
    if (!argument) throw new FrameworkError('CONFIGURATION_ERROR', 'new requires a target directory.');
    await createStarter(argument, values.package, { install: !values['no-install'], build: !values['no-build'] && !values['no-install'], signal: lifetime.signal });
    return;
  }
  if (hasProject && !values.app && (command === 'doctor' || command === 'run' && !useRelease)) {
    if (!values['no-build']) await build();
    const invocation = await sourceInvocation(file, values.env);
    if (values.data) { invocation.database = join(resolve(values.data), 'runs.sqlite'); invocation.artifacts = join(resolve(values.data), 'artifacts'); }
    if (values.input) invocation.input = JSON.parse(await readFile(resolve(values.input), 'utf8'));
    invocation.mode = command === 'doctor' ? 'doctor' : 'run';
    const result = await invokeSource(invocation, { signal: lifetime.signal });
    console.log(JSON.stringify(result, null, 2));
    if (result.status && result.status !== 'succeeded') process.exitCode = 1;
    return;
  }
  if (command === 'doctor') {
    const config = await configuration(values.app);
    const workspace = new LocalWorkspace(join(process.cwd(), brand.dataDirectory, 'artifacts'));
    // No database creation, model calls, or connection probing during diagnosis.
    validateCapabilities(config.application, { model: config.model, workspace });
    parseProviderOptions(config.model, config.providerOptions);
    const tools = Object.entries(config.application.tools).map(([name, tool]) => ({
      name, sideEffect: tool.sideEffect, permissions: tool.permissions,
      status: tool.permissions.every(permission => config.permissions?.includes(permission)) ? 'configured' : 'missing-permission',
      approval: tool.approval,
    }));
    console.log(JSON.stringify({ application: config.application.name, model: { id: config.model.id, capabilities: config.model.capabilities, status: 'configuration-validated; not contacted' }, harness: harnessCapabilities, workspace: workspace.capabilities, state: 'SQLite; run records persist; no session resume', tools, source: values.app ?? 'bundled-offline-starter' }, null, 2));
    if (tools.some(tool => tool.status !== 'configured')) process.exitCode = 1;
    return;
  }
  const data = resolve(values.data ?? brand.dataDirectory);
  let database = join(data, 'runs.sqlite');
  if (useRelease) {
    const status = await releaseStatus(projectOptions);
    if (!status.release) throw new FrameworkError('NOT_FOUND', 'No release is active for this environment.');
    database = status.release.payload.bindings.state.path;
  } else if (hasProject && !values.data) {
    database = (await sourceInvocation(file)).database;
  }
  if (command !== 'run') await access(database);
  const store = new SQLiteRunStore(database, { readOnly: command === 'inspect' });
  try {
    if (command === 'inspect') {
      console.log(JSON.stringify(argument ? { mode: 'trace-playback', run: store.get(argument), events: store.events(argument) } : store.list(), null, 2));
      return;
    }
    if (command === 'recover') {
      if (!argument) throw new FrameworkError('CONFIGURATION_ERROR', 'recover requires a run ID.');
      const run = store.get(argument);
      const owner = JSON.parse(run.owner) as { host: string; pid: number };
      if (owner.host !== hostname()) throw new FrameworkError('CONFLICT', 'Cannot verify another host process from this local CLI; no state was changed.');
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw new FrameworkError('CONFLICT', 'Owning process is still alive; no state was changed.');
      console.log(JSON.stringify(store.interrupt(run.id, run.version, 'Owning local process is no longer alive.'), null, 2));
      return;
    }
    const config = await configuration(values.app);
    const input: unknown = values.input ? JSON.parse(await readFile(resolve(values.input), 'utf8')) : config.input;
    const controller = new AbortController();
    const cancel = () => controller.abort(new FrameworkError('CANCELLED', 'Run cancelled by process signal.'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const workspace = new LocalWorkspace(join(data, 'artifacts'));
    try {
      const result = await runApplication(config.application, input, { ...config, store, workspace, signal: controller.signal });
      console.log(JSON.stringify({ runId: result.runId, status: result.status, output: result.output, artifacts: result.artifacts, error: result.error ? { code: result.error.code, message: result.error.message } : undefined }, null, 2));
      if (result.status !== 'succeeded') process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      await workspace.close();
    }
  } finally {
    store.close();
  }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

main().catch(error => {
  console.error(JSON.stringify({ code: error instanceof FrameworkError ? error.code : 'CLI_ERROR', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});