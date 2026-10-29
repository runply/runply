# Contracts and ownership

## The application is the unit of development

`defineApplication` contains the input/output schemas, tool definitions, messages, and finalization function. `runApplication` validates inputs, checks capabilities, invokes the AI SDK loop, verifies the final JSON output, calls finalization, and publishes artifacts.

The first harness uses `generateText` from AI SDK. It does not implement a second tool-calling algorithm. A small model wrapper records calls and rejects unavailable tools, malformed arguments, repeated call IDs, and unsupported provider warnings before local tool dispatch.

Version 0.2 adds a composition/deployment layer above this runtime: project definition → environment bindings → local release → run. It does not replace the application contract or move scheduling into model decisions. See [deployment](deployment.md).

Version 0.3 adds run-owned components, MCP integration, one application CLI, and a local dev inspector. Components acquire tools before model dispatch, emit connection events, and close in reverse order before terminal status. Discovery never bypasses the existing tool permission or approval checks.

The current harness generates text and validates JSON locally. It does not send a native response schema or expose token streaming. Requesting either capability fails even if the underlying model supports it. Applications can use the provider model outside this harness when they need provider features not yet integrated.

## Public entry points

| Export | Responsibility |
| --- | --- |
| `defineApplication`, `defineTool` | Typed application behavior and tool validation |
| `runApplication` | A single run's control lifecycle |
| `aiSdkModel` | AI SDK v4 model plus declared capabilities and validated provider options |
| `SQLiteRunStore`, `RunStore` | Run identity, versioned state transitions, persistent event ordering |
| `LocalWorkspace`, `Workspace` | Artifact publication and explicit resource capabilities |
| `FrameworkError` | Stable error category plus in-process original cause |
| `runply/testing` | Public offline test helpers: scripted model and memory store |
| `defineProject`, `projectSchema` | Validated environment composition |
| `planProject`, `deployProject`, `runRelease` | Reviewable package plan, local activation, and process-owned release execution |
| `releaseStatus`, `pauseEnvironment` | Current activation and admission control |
| `createMcpComponent`, `openMcpConnection` | Run-owned or explicitly caller-owned MCP connections |

`src/contracts.ts` is the canonical contract definition. There is no registry service, dependency-injection container, queue service, or mandatory hosted backend. CLI configuration is an ordinary built ESM module with a default export containing `application`, `model`, `input`, optional `permissions`, and optional `providerOptions`.

`doctor` validates declarations and options, not provider availability. It never guesses a provider or contacts one. CLI flags unsupported by a command are errors, not ignored settings.

## Tools and permissions

A tool declares an input/output schema, side-effect category, idempotency, required permission names, and whether application approval is required. Permission names belong to the application; there is no vendor or domain allowlist.

The runtime checks permissions and obtains approval before invoking the tool. Tools receive the run identity, tool-call identity, parsed application input, run-local state, and a cancellation signal. The current loop dispatches tools serially. Tools and finalization are trusted application code in the same Node process; this is not isolation for arbitrary code.

An approval handler receives a combined signal. The signal is aborted by the caller, a configured timeout, or a fatal execution error. `signal.reason` carries the reason; framework-triggered timeout and cancellation use `FrameworkError`. A denied approval is `PERMISSION_DENIED`. A missing handler is `APPROVAL_REQUIRED`. Waiting is in-process only, not a durable approval inbox.

The runtime does not retry model requests or tool invocations. `idempotent` is descriptive metadata, not proof that an operation is safe to repeat. A caller that wants retries must choose its policy and use the tool-call identity to implement idempotency in the external system. Repeated tool-call IDs in one run are rejected.

## State and lifetime

The caller owns the store and workspace and closes them. The runtime owns its abort controller and timer. The CLI closes the resources it creates and removes signal handlers when a run ends. For a deployed run, the release host owns these handles inside the child process. The release-control database owns activation revisions, not business data or tool scratch state.

There are three separate kinds of state:

- Application data stays with the application. The framework does not take over its database.
- Run records and ordered events persist in SQLite. Updates require the current owner token and version inside one transaction. SQLite schema version is 1; a newer schema is rejected without downgrade.
- Tool scratch state is a JSON snapshot map belonging to one run. State-change events persist, with values omitted unless content capture is enabled. The map is not a resumable checkpoint or long-term memory store.

The owner record contains a host, PID, and per-run token. It is not a distributed lease. Two connections cannot both commit an update based on a stale version. Multiple runs can share one store; they have separate owner tokens and scratch state.

Run statuses are `running`, `waiting_approval`, `succeeded`, `failed`, `cancelled`, and `interrupted`. Terminal runs reject further updates. The runtime fences late completions so a timed-out implementation cannot append another successful event.

## Interruption is not resumption

`recover` verifies that the recorded process on the local host has exited, then marks the run interrupted. It does not execute code or replay a tool. If the PID is still alive, including a reused PID, the CLI refuses to infer that the owner is dead. A remote host cannot be verified by this local CLI.

If cancellation happens while an external-effect tool is in flight, its outcome is unknown. The run is interrupted, not reported as safely rolled back. A non-cooperative implementation may continue running after the framework stops waiting. The same rule applies to unfinished artifact publication.

The artifact directory and SQLite event transaction are not one atomic commit. Publication prepares files in a staging directory, reserves a run directory, and renames the prepared directory into place. A process crash can leave a staging directory, an empty reservation, or published artifacts without their final events. Recovery must inspect these; it never deletes them or republishes automatically. Power-loss/fsync durability has not been certified.

Finalization should validate and render artifacts, not perform unrelated external side effects. It receives a signal and can be cancelled while the runtime waits. External effects belong in tools with explicit metadata.

## Events and privacy

Events carry `schemaVersion`, `runId`, a per-run sequence number, timestamp, type, and optional step/parent identities. Model records include duration, finish reason, warnings, and usage. Missing token counts are `null`, not zero. Prices and cost estimates are not invented.

Payload capture is off by default. `captureContent: true` enables model/tool/state/output capture. Known structured secret keys are masked; applications can provide `redact` for additional rules. Neither key matching nor this framework can reliably find credentials embedded in arbitrary prose. Do not enable content capture for sensitive documents without an application-specific policy. In-process error causes and CLI output may contain application data.

The event store is an audit trail, not an OpenTelemetry exporter or a replay engine. `inspect` is trace playback. Mocked replay and actual re-execution are distinct future features. The current fake model is a scripted test double, not recorded replay.

## Boundaries left deliberately small

Model messages and provider protocols reuse AI SDK types. Business tools use Zod; MCP bridges keep native JSON Schema and validate with Ajv. MCP uses the official protocol SDK. Model-response caching, tool-result caching, and engine KV caching remain separate concerns; none is implemented here.

Branding is centralized in `src/brand.ts` and package metadata. Event fields and store schema do not encode the brand. No cross-harness session portability is claimed.