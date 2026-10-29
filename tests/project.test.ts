import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bindProcessEnvironment, defineProject, loadProject, projectSchema, type ProjectDefinition } from '../src/project.js';

const roots: string[] = [];
function definition(): ProjectDefinition {
  return {
    schemaVersion: 1, name: 'fixture', entry: './src/app.ts', defaultEnvironment: 'review/eu-west',
    environments: {
      'review/eu-west': { state: { path: '.state/runs.sqlite' }, artifacts: { path: 'output' } },
      'customer-demo.42': { state: { path: '.demo/runs.sqlite' }, artifacts: { path: 'demo-output' }, variables: { REGION: 'demo' } },
    },
  };
}
function fixture(project: unknown = definition()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runply-project-')));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), 'export default {};\n');
  const file = join(root, 'project.json');
  writeFileSync(file, JSON.stringify(project));
  return { root, file };
}
function directorySnapshot(root: string): Record<string, unknown> {
  return Object.fromEntries(readdirSync(root).sort().map(name => {
    const path = join(root, name);
    const stat = statSync(path);
    return [name, {
      mode: stat.mode, mtime: stat.mtimeMs,
      content: stat.isDirectory() ? directorySnapshot(path) : readFileSync(path).toString('base64'),
    }];
  }));
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('strict project schema', () => {
  it('applies environment defaults without changing the input', () => {
    const input = definition();
    const before = structuredClone(input);
    expect(defineProject(input).environments['review/eu-west']).toEqual({
      target: 'local-process', model: 'default', state: { path: '.state/runs.sqlite' },
      artifacts: { path: 'output' }, variables: {}, secrets: {}, requirements: {},
    });
    expect(input).toEqual(before);
  });

  it.each(['schemaVersion', 'name', 'entry', 'defaultEnvironment', 'environments'])('rejects missing %s', key => {
    const input: Record<string, unknown> = { ...definition() };
    delete input[key];
    expect(projectSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ['schemaVersion', 2], ['schemaVersion', '1'], ['name', ''], ['entry', ''],
    ['defaultEnvironment', ''], ['environments', []],
  ])('rejects invalid %s = %j', (key, value) => {
    expect(projectSchema.safeParse({ ...definition(), [key]: value }).success).toBe(false);
  });

  it.each([
    ['project', { ...definition(), extra: true }],
    ...Object.entries({
      environment: { extra: true },
      state: { state: { path: 'state.sqlite', extra: true } },
      artifacts: { artifacts: { path: 'output', extra: true } },
      requirements: { requirements: { extra: true } },
      secret: { secrets: { API_KEY: { env: 'SOURCE_KEY', value: 'inline-secret' } } },
    }).map(([name, extra]) => [name, {
      ...definition(), environments: { test: { state: { path: 'state.sqlite' }, artifacts: { path: 'output' }, ...extra } },
    }] as const),
  ] satisfies Array<readonly [string, unknown]>)('rejects unknown fields in %s', async (_name, input) => {
    expect(projectSchema.safeParse(input).success).toBe(false);
    await expect(loadProject(fixture(input).file, 'test')).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it.each([
    { state: { path: '' } }, { artifacts: { path: '' } }, { variables: { COUNT: 1 } },
    { secrets: { API_KEY: 'inline-secret' } }, { secrets: { API_KEY: { env: '' } } },
    { requirements: { isolation: 'true' } }, { providerOptions: { vendor: 'not-an-options-object' } },
  ])('rejects malformed environment bindings %j', extra => {
    expect(projectSchema.safeParse({
      ...definition(), environments: { test: { state: { path: 'state.sqlite' }, artifacts: { path: 'output' }, ...extra } },
    }).success).toBe(false);
  });
});

describe('loadProject', () => {
  it('uses the declared default environment and normalizes the entry', async () => {
    const { file, root } = fixture();
    const loaded = await loadProject(file);
    expect(loaded.environment).toBe('review/eu-west');
    expect(loaded.entry).toBe('src/app.ts');
    expect(loaded.root).toBe(root);
    expect(loaded.projectFile).toBe(file);
  });

  it.each(['review/eu-west', 'customer-demo.42', 'QA_2026', '__proto__', 'constructor'])('resolves arbitrary named environment %s', async name => {
    const project = definition();
    project.environments = { [name]: { state: { path: 'state.sqlite' }, artifacts: { path: 'output' }, variables: { SELECTED: name } } };
    const loaded = await loadProject(fixture(project).file, name);
    expect(loaded.environment).toBe(name);
    expect(loaded.bindings.variables).toEqual({ SELECTED: name });
  });

  it('lets an explicit environment override the default', async () => {
    const loaded = await loadProject(fixture().file, 'customer-demo.42');
    expect(loaded.environment).toBe('customer-demo.42');
    expect(loaded.bindings.variables).toEqual({ REGION: 'demo' });
    expect(loaded.project.defaultEnvironment).toBe('review/eu-west');
  });

  it.each(['missing', '', 'toString'])('rejects an undefined explicit environment %j', async name => {
    await expect(loadProject(fixture().file, name)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('rejects a missing default environment', async () => {
    const project = definition();
    project.defaultEnvironment = 'absent';
    await expect(loadProject(fixture(project).file)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('resolves relative paths against the project directory without changing stored paths', async () => {
    const { file, root } = fixture();
    const loaded = await loadProject(file);
    expect(loaded.bindings.state.path).toBe(resolve(root, '.state/runs.sqlite'));
    expect(loaded.bindings.artifacts.path).toBe(resolve(root, 'output'));
    expect(loaded.project.environments['review/eu-west']!.state.path).toBe('.state/runs.sqlite');
  });

  it('preserves absolute state and artifact paths', async () => {
    const { file, root } = fixture();
    const project = definition();
    const state = join(root, 'external/state.sqlite');
    const artifacts = join(root, 'external/artifacts');
    project.environments['review/eu-west'] = { state: { path: state }, artifacts: { path: artifacts } };
    writeFileSync(file, JSON.stringify(project));
    const loaded = await loadProject(file);
    expect(loaded.bindings.state.path).toBe(state);
    expect(loaded.bindings.artifacts.path).toBe(artifacts);
  });

  it('accepts arbitrary model and provider option names rather than a vendor allowlist', async () => {
    const project = definition();
    const settings = project.environments['review/eu-west']!;
    settings.model = 'my-company/custom-model-v19';
    settings.providerOptions = { 'private-vendor-42': { mode: 'custom', nested: { enabled: true }, weights: [1, null, 2] } };
    const loaded = await loadProject(fixture(project).file);
    expect(loaded.bindings.model).toBe(settings.model);
    expect(loaded.bindings.providerOptions).toEqual(settings.providerOptions);
  });

  it('rejects an uninstalled target, not a model vendor', async () => {
    const project = definition();
    project.environments['review/eu-west']!.target = 'uninstalled-target';
    await expect(loadProject(fixture(project).file)).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR', message: expect.stringContaining('No implementation is installed for target uninstalled-target'),
    });
  });

  it.each(['isolation', 'resumableRuns'] as const)('rejects the actual local-process capability mismatch: %s', async capability => {
    const project = definition();
    project.environments['review/eu-west']!.requirements = { [capability]: true };
    await expect(loadProject(fixture(project).file)).rejects.toMatchObject({
      code: 'CAPABILITY_MISMATCH', message: expect.stringContaining(capability),
    });
  });

  it('accepts supported capabilities and explicitly unrequired capabilities', async () => {
    const project = definition();
    const requirements = { releaseSnapshots: true, persistentState: true, artifacts: true, isolation: false, resumableRuns: false };
    project.environments['review/eu-west']!.requirements = requirements;
    expect((await loadProject(fixture(project).file)).bindings.requirements).toEqual(requirements);
  });

  it.each(['../app.ts', 'src/../../app.ts', '/tmp/app.ts', '.', './', 'src\\..\\app.ts'])('rejects invalid entry path %j', async entry => {
    await expect(loadProject(fixture({ ...definition(), entry }).file)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('does not modify or create files when loading a read-only fixture directory', async () => {
    const { file, root } = fixture();
    chmodSync(root, 0o555);
    const before = directorySnapshot(root);
    await loadProject(file);
    await loadProject(file, 'customer-demo.42');
    expect(directorySnapshot(root)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(['project.json', 'src']);
  });
});

describe('secret references', () => {
  it('resolves values only into a detached child environment, never serialized project bindings', async () => {
    const project = definition();
    project.environments['review/eu-west']!.variables = { LOG_LEVEL: 'debug' };
    project.environments['review/eu-west']!.secrets = { API_KEY: { env: 'DEPLOY_KEY' } };
    const { file } = fixture(project);
    const loaded = await loadProject(file);
    const before = JSON.stringify(loaded);
    const source = { DEPLOY_KEY: 'secret-sentinel-4891', LOG_LEVEL: 'info', INHERITED: 'yes' };
    const original = { ...source };
    const child = bindProcessEnvironment(loaded.bindings, source);
    expect(child).toEqual({ ...source, LOG_LEVEL: 'debug', API_KEY: source.DEPLOY_KEY });
    expect(child).not.toBe(source);
    expect(source).toEqual(original);
    expect(JSON.stringify(loaded)).toBe(before);
    expect(before).toContain('DEPLOY_KEY');
    expect(before).not.toContain(source.DEPLOY_KEY);
    expect(readFileSync(file, 'utf8')).not.toContain(source.DEPLOY_KEY);
    child.API_KEY = 'changed';
    expect(source).toEqual(original);
    expect(loaded.bindings.secrets).toEqual({ API_KEY: { env: 'DEPLOY_KEY' } });
  });

  it('reports a missing reference without leaking an already resolved secret', async () => {
    const project = definition();
    project.environments['review/eu-west']!.secrets = { FIRST: { env: 'PRESENT' }, SECOND: { env: 'MISSING' } };
    const loaded = await loadProject(fixture(project).file);
    const source = { PRESENT: 'never-print-this-value', SECOND: 'do-not-use-destination-value' };
    let caught: unknown;
    try { bindProcessEnvironment(loaded.bindings, source); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'CONFIGURATION_ERROR', message: 'Missing secret environment reference MISSING for SECOND.' });
    expect(String(caught)).not.toContain(source.PRESENT);
    expect(String(caught)).not.toContain(source.SECOND);
    expect(JSON.stringify(caught)).not.toContain(source.PRESENT);
    expect(source).toEqual({ PRESENT: 'never-print-this-value', SECOND: 'do-not-use-destination-value' });
  });

  it('accepts a present empty secret and resolves from source rather than variable overrides', async () => {
    const project = definition();
    project.environments['review/eu-west']!.variables = { SOURCE: 'variable-value' };
    project.environments['review/eu-west']!.secrets = { KEY: { env: 'SOURCE' } };
    const loaded = await loadProject(fixture(project).file);
    expect(bindProcessEnvironment(loaded.bindings, { SOURCE: '' })).toEqual({ SOURCE: 'variable-value', KEY: '' });
    expect(() => bindProcessEnvironment(loaded.bindings, {})).toThrow(/Missing secret environment reference SOURCE/);
  });

  it('rejects a variable and secret destination collision', async () => {
    const project = definition();
    project.environments['review/eu-west']!.variables = { API_KEY: 'inline-value' };
    project.environments['review/eu-west']!.secrets = { API_KEY: { env: 'SOURCE' } };
    await expect(loadProject(fixture(project).file)).rejects.toMatchObject({
      code: 'CONFIGURATION_ERROR', message: 'Variable API_KEY is defined both as a value and a secret reference.',
    });
  });

  it.each(['', 'BAD=KEY', 'BAD\0KEY'])('rejects invalid process environment key %j', async key => {
    for (const field of ['variables', 'secrets'] as const) {
      const project = definition();
      const settings = project.environments['review/eu-west']!;
      if (field === 'variables') settings.variables = { [key]: 'value' };
      else settings.secrets = { [key]: { env: 'SOURCE' } };
      await expect(loadProject(fixture(project).file)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    }
  });
});