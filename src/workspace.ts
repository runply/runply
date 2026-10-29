import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile, access } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import type { Artifact, Workspace } from './contracts.js';
import { FrameworkError } from './errors.js';

/** A trusted local artifact workspace. It is not a sandbox or a filesystem jail. */
export class LocalWorkspace implements Workspace {
  readonly capabilities = { files: false, artifacts: true, execution: false, isolation: false } as const;
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async publish(runId: string, artifacts: readonly Artifact[]) {
    if (!runId || basename(runId) !== runId || runId === '.' || runId === '..') throw new FrameworkError('WORKSPACE_ERROR', 'Invalid run directory name.');
    const names = new Set<string>();
    for (const artifact of artifacts) {
      if (!artifact.name || basename(artifact.name) !== artifact.name || ['.', '..'].includes(artifact.name) || names.has(artifact.name)) {
        throw new FrameworkError('WORKSPACE_ERROR', 'Artifact names must be distinct filenames, not paths.');
      }
      names.add(artifact.name);
    }
    await mkdir(this.root, { recursive: true });
    const destination = join(this.root, runId);
    let exists = false;
    try { await access(destination); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) throw new FrameworkError('CONFLICT', `Artifacts for ${runId} already exist.`);
    const staging = await mkdtemp(join(this.root, '.staging-'));
    let reserved = false;
    try {
      const entries = [];
      for (const artifact of artifacts) {
        await writeFile(join(staging, artifact.name), artifact.content, { flag: 'wx' });
        entries.push({ name: artifact.name, path: join(destination, artifact.name), sha256: createHash('sha256').update(artifact.content).digest('hex'), bytes: Buffer.byteLength(artifact.content) });
      }
      // Reserve the name exclusively, including when the artifact set is empty.
      // A crash can leave an empty reservation; it is never silently overwritten.
      await mkdir(destination);
      reserved = true;
      await rename(staging, destination);
      return entries;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (reserved) await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> { /* No owned process or persistent handle. */ }
}