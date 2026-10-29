import { createHash } from 'node:crypto';
import { readFile, stat, realpath, access, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, posix } from 'node:path';
import { createRequire } from 'node:module';
import { FrameworkError } from './errors.js';
import { isWithin, projectRelativePath } from './project.js';
import type { SnapshotFile, SnapshotLink, ReleasePayload } from './release-types.js';

const packlist = createRequire(import.meta.url)('npm-packlist') as (tree: {
  path: string; package: Record<string, unknown>; isProjectRoot: boolean; edgesOut: Map<string, unknown>;
}) => Promise<string[]>;
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Use npm's file-selection library, not npm pack (which can execute prepare). */
async function packageFiles(root: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  // Capture dependency packages separately in the closure below, including bundles.
  const ownFiles = await packlist({ path: root, package: { ...manifest, bundleDependencies: [], bin: typeof manifest.bin === 'string' ? { executable: manifest.bin } : manifest.bin }, isProjectRoot: true, edgesOut: new Map() });
  const files = ownFiles.map(projectRelativePath);
  try { await access(join(root, 'package-lock.json')); files.push('package-lock.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return [...new Set(files)].sort();
}

async function locateDependency(root: string, name: string): Promise<string | undefined> {
  const search = createRequire(join(root, 'package.json')).resolve.paths(name) ?? [];
  for (const base of search) {
    const candidate = join(base, name);
    try { await access(join(candidate, 'package.json')); return await realpath(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Capture installed production dependency closure, including peer dependencies, without reinstalling it. */
export async function collectSnapshot(appRoot: string, hostRoot: string, forbiddenRoots: string[]) {
  const files: SnapshotFile[] = [];
  const links: SnapshotLink[] = [];
  const packages: ReleasePayload['packages'] = [];
  const visited = new Map<string, string>();
  const destinations = new Set<string>();
  async function capture(sourceRoot: string, destination: string): Promise<string> {
    const source = await realpath(sourceRoot);
    const previous = visited.get(source);
    if (previous) return previous;
    visited.set(source, destination);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
      name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      bundleDependencies?: string[] | boolean; bundledDependencies?: string[] | boolean;
    };
    packages.push({ name: manifest.name, version: manifest.version, path: destination });
    for (const file of await packageFiles(source)) {
      const original = await realpath(join(source, file));
      if (forbiddenRoots.some(root => isWithin(root, original))) throw new FrameworkError('CONFIGURATION_ERROR', `Package selection includes deployment state: ${file}. Exclude state and control directories using npm files/.npmignore.`);
      const bytes = await readFile(original);
      const info = await stat(original);
      if (!info.isFile()) throw new FrameworkError('CONFIGURATION_ERROR', `Package entry is not a regular file: ${file}`);
      const path = `${destination}/${file}`;
      if (destinations.has(path)) throw new FrameworkError('CONFIGURATION_ERROR', `Duplicate packaged file: ${path}`);
      destinations.add(path);
      files.push({ path, source: original, sha256: sha256(bytes), bytes: bytes.length, executable: Boolean(info.mode & 0o111) });
    }
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies, ...Object.fromEntries(Array.isArray(bundled) ? bundled.map(name => [name, '*']) : []) };
    for (const name of Object.keys(dependencies).sort()) {
      const dependencyRoot = await locateDependency(source, name);
      if (!dependencyRoot) {
        if (Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional) continue;
        throw new FrameworkError('CONFIGURATION_ERROR', `Installed dependency ${name} is missing from ${manifest.name}. Install dependencies before planning.`);
      }
      const target = await capture(dependencyRoot, `packages/${visited.size}`);
      const path = `${destination}/node_modules/${name}`;
      // npm may have already included a bundled dependency and its closure.
      if (![...destinations].some(file => file.startsWith(`${path}/`))) links.push({ path, target: posix.relative(posix.dirname(path), target) });
    }
    return destination;
  }
  await capture(appRoot, 'app');
  const hostDestination = await capture(hostRoot, 'host');
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    links: links.sort((a, b) => a.path.localeCompare(b.path)),
    packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
    hostEntry: `${hostDestination}/dist/release-host.js`,
  };
}

export function snapshotPath(root: string, path: string): string {
  const result = resolve(root, projectRelativePath(path));
  if (!isWithin(root, result)) throw new FrameworkError('CONFIGURATION_ERROR', 'Snapshot path escapes the release directory.');
  return result;
}

export async function verifySnapshot(root: string, payload: ReleasePayload): Promise<void> {
  root = await realpath(root);
  if (!isWithin(root, await realpath(join(root, 'release.json')))) throw new FrameworkError('CONFLICT', 'Release manifest points outside its snapshot.');
  if (canonical(JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))) !== canonical(payload)) throw new FrameworkError('CONFLICT', 'Release manifest was changed.');
  const expected = new Set(['release.json', ...payload.files.map(file => file.path), ...payload.links.map(link => link.path)]);
  const directories = new Set<string>();
  for (const path of expected) {
    let parent = posix.dirname(path);
    while (parent !== '.') { directories.add(parent); parent = posix.dirname(parent); }
  }
  async function inspect(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!directories.has(path)) throw new FrameworkError('CONFLICT', `Unexpected release directory: ${path}`);
        await inspect(join(directory, entry.name), path);
      } else if (!expected.has(path)) throw new FrameworkError('CONFLICT', `Unexpected release file: ${path}`);
    }
  }
  await inspect(root);
  for (const file of payload.files) {
    const path = snapshotPath(root, file.path);
    const actual = await realpath(path);
    const executable = Boolean((await stat(path)).mode & 0o111);
    if (!isWithin(root, actual) || sha256(await readFile(path)) !== file.sha256 || executable !== file.executable) throw new FrameworkError('CONFLICT', `Release file was changed: ${file.path}`);
  }
  for (const link of payload.links) {
    const actual = await realpath(snapshotPath(root, link.path));
    const expected = resolve(dirname(snapshotPath(root, link.path)), link.target);
    if (!isWithin(root, actual) || relative(expected, actual)) throw new FrameworkError('CONFLICT', `Release dependency link was changed: ${link.path}`);
  }
}