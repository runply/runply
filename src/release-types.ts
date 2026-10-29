import type { EnvironmentDefinition } from './project.js';

export interface SnapshotFile { path: string; source: string; sha256: string; bytes: number; executable: boolean }
export interface SnapshotLink { path: string; target: string }
export interface ReleasePayload {
  schemaVersion: 1;
  project: string;
  projectId: string;
  environment: string;
  entry: string;
  hostEntry: string;
  bindings: EnvironmentDefinition;
  node: { executable: string; version: string; platform: string; arch: string };
  packages: Array<{ name: string; version: string; path: string }>;
  files: SnapshotFile[];
  links: SnapshotLink[];
}
export interface Activation { revision: number; releaseId: string | null; paused: boolean }
export interface ReleasePlan {
  schemaVersion: 1;
  id: string;
  releaseId: string;
  scope: string;
  controlRoot: string;
  projectFile: string;
  environment: string;
  base: Activation;
  action: 'activate' | 'unchanged';
  secretReferences: Array<{ variable: string; source: string; available: boolean }>;
  payload: ReleasePayload;
  changes: Array<{ component: string; before?: unknown; after?: unknown; detail?: string }>;
}
export interface ReleaseRecord {
  id: string;
  createdAt: string;
  payload: ReleasePayload;
}