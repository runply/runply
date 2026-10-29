# MCP connections

Runply uses the official TypeScript MCP SDK. It does not define a competing tool protocol. Acquired connections belong to a run and are closed in reverse acquisition order before terminal status. If an acquisition returns after cancellation, its late resource is closed without appending new events to the terminal run.

## Configure through the CLI

For a server already present in the application package:

```sh
runply add mcp documents --command node --arg dist/mcp-server.js
runply run
```

For a Streamable HTTP endpoint:

```sh
runply add mcp documents --url https://your-server.example/mcp --header-env Authorization=MCP_AUTH
```

The examples are connection shapes, not hosted services provided by this project. Supply your own server and set the referenced environment value yourself. `MCP_AUTH` must contain the full header value, including any required scheme. Secrets do not go in CLI arguments or project header values.

`add mcp` writes the selected environment's `mcp` map; `--env` selects another environment. It never starts the executable or makes an HTTP request. Duplicate names fail without replacing the old configuration. Stdio arguments use repeated `--arg`; values containing spaces remain one argument. The command does not install a third-party server package on your behalf.

## Run behavior

When execution starts, each component connects and lists tools, following pagination. A tool named `read` from the `documents` connection becomes `documents__read`. Collisions with application or component tools fail before model dispatch.

The original JSON Schema is forwarded at the model boundary. Ajv validates arguments without coercing values, applying defaults, or stripping additional properties. Draft 2019-09 and 2020-12 schemas are recognized. JSON Schema format is annotation-only in this implementation. Unknown external schema references are not fetched.

MCP content blocks, structured content, and metadata stay in the returned envelope. `isError` and invalid structured output become explicit tool errors. Discovery does not execute tools. A model's request for an MCP tool goes through the same runtime permission, approval, cancellation, and event path as a business tool.

The local configuration controls `permissions`, `approval`, `sideEffect`, and `idempotent`. Defaults are no additional permission names, no mandatory approval, external effect, and non-idempotent. Remote annotations are preserved as informational metadata and never grant authority or weaken those local settings. Adding a connection makes its discovered tools available to that run's model; configure the application policy accordingly.

Connection, discovery, and calls use the SDK request timeout (currently 60 seconds) unless `timeoutMs` is configured. Cancellation closes owned resources. Failed acquisitions clean up partial transports. There are no automatic task retries or reconnect-and-reexecute attempts. A remote effect may have happened before a lost response; the runtime retains its existing uncertain/interrupted semantics for external-effect tools.

## Resources, prompts, and ownership

The library exports `openMcpConnection`, with native `listResources`, `readResource`, `listPrompts`, and `getPrompt` operations. Pagination and protocol envelopes are retained. A caller opening this connection directly owns `close()`. `createMcpComponent` instead returns a run component whose close is owned by `runApplication`.

Connection configuration can be bound in the project environment or supplied as `components` in the application's exported composition. Stdio processes inherit host privileges and environment unless overridden. They are not sandboxes. A configured absolute cwd remains a host dependency; relative executable arguments run from the source/release application directory.

Planning and release preflight validate configuration only; neither opens MCP connections. A deployed run opens its saved connection configuration after admission. Server binaries, packages, and assets must either be present in the application's captured dependency tree or be explicitly supplied host dependencies.

## Verified scope

Tests exercise real stdio child servers, native resources/prompts, schema preservation, transport errors, pagination, timeout/cancellation, and cleanup. A local HTTP test uses the official Streamable HTTP server and client, including an environment-referenced header and a real tool call returning 42. No external MCP service, production OAuth flow, or model provider was contacted. OAuth onboarding, task-required MCP tools, and automatic server package installation are not implemented.