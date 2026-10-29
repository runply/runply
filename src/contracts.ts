import type { LanguageModelV4, SharedV4ProviderOptions as ProviderOptions, JSONSchema7 } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import type { ZodType } from 'zod';

export type RunStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type EventType =
  | 'run.started' | 'run.status' | 'model.started' | 'model.completed' | 'model.failed'
  | 'tool.started' | 'tool.completed' | 'tool.failed' | 'approval.requested'
  | 'state.changed' | 'artifact.created';
export type ComponentEventType = 'component.connecting' | 'component.ready' | 'component.failed' | 'component.closed';

export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  timestamp: string;
  type: EventType | ComponentEventType;
  stepId?: string;
  parentId?: string;
  data: unknown;
}

export interface RunRecord {
  id: string;
  application: string;
  model: string;
  status: RunStatus;
  version: number;
  owner: string;
  createdAt: string;
  updatedAt: string;
  release?: { id: string; environment: string; projectId: string };
}

export interface RunStore {
  readonly capabilities: { persistent: boolean; continuation: false };
  create(run: Omit<RunRecord, 'version' | 'status' | 'createdAt' | 'updatedAt'>): RunRecord;
  get(id: string): RunRecord;
  list(): RunRecord[];
  events(id: string): RunEvent[];
  /** Atomically append an event and optionally update status using optimistic concurrency. */
  append(id: string, owner: string, version: number, event: Omit<RunEvent, 'schemaVersion' | 'runId' | 'sequence' | 'timestamp'>, status?: RunStatus): RunRecord;
  /** Explicit interruption marking only. Never resumes or re-executes work. */
  interrupt(id: string, expectedVersion: number, reason: string): RunRecord;
  close(): void;
}

export interface ModelCapabilities {
  tools: boolean;
  streaming: boolean;
  /** Native schema-constrained generation, not local JSON validation. */
  structuredOutput: boolean;
}

export interface ModelAdapter {
  id: string;
  model: LanguageModelV4;
  capabilities: ModelCapabilities;
  /** Validate extension options before dispatch. Strict schemas prevent silent dropping. */
  providerOptionsSchema: ZodType<ProviderOptions>;
}

export interface RunState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface ToolContext {
  runId: string;
  toolCallId: string;
  signal: AbortSignal;
  input: unknown;
  state: RunState;
}

export interface AppTool {
  description: string;
  inputSchema: ZodType;
  /** Keep the original protocol schema when validation is implemented by a bridge. */
  inputJsonSchema?: JSONSchema7;
  sideEffect: 'none' | 'external';
  idempotent: boolean;
  permissions: readonly string[];
  approval: boolean;
  invoke(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface Artifact {
  name: string;
  mediaType: string;
  content: string;
}

export interface Workspace {
  readonly capabilities: { files: boolean; artifacts: boolean; execution: boolean; isolation: boolean };
  /** Publishes a complete artifact directory. Implementations must not overwrite an existing run. */
  publish(runId: string, artifacts: readonly Artifact[]): Promise<Array<{ name: string; path: string; sha256: string; bytes: number }>>;
  close(): Promise<void>;
}

export interface Application<I = unknown, O = unknown> {
  name: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  tools: Record<string, AppTool>;
  requirements?: Partial<ModelCapabilities>;
  workspaceRequirements?: Partial<Workspace['capabilities']>;
  messages(input: I): ModelMessage[];
  /** Business validation and artifact rendering are application-controlled, not model tool calls. */
  finalize(output: O, context: { input: I; state: RunState; signal: AbortSignal }): Promise<Artifact[]> | Artifact[];
}

export interface RuntimeOptions {
  model: ModelAdapter;
  store: RunStore;
  workspace: Workspace;
  permissions?: readonly string[];
  providerOptions?: ProviderOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxSteps?: number;
  approve?: (request: { runId: string; toolCallId: string; tool: string; input: unknown; signal: AbortSignal }) => Promise<boolean>;
  /** Payloads are omitted by default. Secrets in arbitrary text need application-specific redaction. */
  captureContent?: boolean;
  redact?: (value: unknown) => unknown;
  release?: RunRecord['release'];
  components?: readonly RunComponent[];
}

/** A run owns the acquired resources. Failed acquisition must clean up its own partial resources. */
export interface RunComponent {
  id: string;
  open(context: { runId: string; signal: AbortSignal }): Promise<{
    tools: Record<string, AppTool>;
    close(): Promise<void>;
  }>;
}