# Runply

An application framework for agents. Write application behavior and business tools; let the framework connect model execution, permissions, run records, and artifacts.

Version 0.3 puts the application workflow behind one CLI and adds MCP connections plus a local web inspector. Local releases remain available; no hosted platform or account is required.

## Create, develop, run

Use Node 24 LTS; see [compatibility](docs/compatibility.md) for tested versions. Install the CLI once from the npm-compatible archive attached to a [GitHub release](https://github.com/runply/runply/releases), then use Runply commands for application development. The package is not published to the npm registry.

For version 0.3.0, download `runply-0.3.0.tgz` and its SHA-256 file from the release, verify the checksum, and install the archive:

```sh
npm install --global ./runply-0.3.0.tgz
```

```sh
runply new my-agent-app
cd my-agent-app
runply dev
```

`new` creates the starter, installs its dependencies, and builds it. `dev` opens a local inspector at the printed URL (port 3005 by default), watches the project, and rebuilds changes. It never re-executes the application automatically. Start a run explicitly in the inspector or from another terminal with `runply run`.

The document reviewer reads two local documents, executes `readDocuments` and `checkRequirements`, then writes Markdown and JSON reports. It checks literal terms, not semantic compliance. Its model is scripted; file reads, tools, state, and artifacts are real. No provider credentials, model downloads, accounts, or services are needed.

`inspect` only reads the stored trace. It does not load an application or execute a tool. Run data goes under `.runply/` by default; `--data` selects another directory. Tool/model contents are omitted from persisted traces by default. The CLI prints the final application output. Data from either prior working name is neither migrated nor deleted; see [renaming existing applications](docs/compatibility.md#renaming-the-working-build) for explicit legacy access.

## Keep the workflow in the CLI

```sh
runply generate tool check-policy
runply test
runply run
runply inspect <run-id>
runply doctor
```

The generated tool has a schema, implementation, and test and is connected through the starter's generated tool registry. Write business logic in that tool or in the application. Runply manages build/test commands underneath; you do not need to invoke the package manager for those operations. `runply install` and `runply build` are also available explicitly. Existing project commands can be selected through `tooling` configuration rather than replaced.

`new --package <local-tarball-or-directory>` uses a local framework package. `--no-install` leaves dependency setup to a later `runply install`; `--no-build` skips the initial build. These are optional paths, not separate frameworks. See [CLI and development](docs/cli.md).

## Add MCP

```sh
runply add mcp documents --command node --arg dist/mcp-server.js
runply run
```

The example assumes an existing server entry supplied by the application. `add mcp` writes a named connection without launching it. When a run starts, the framework connects, discovers tools, preserves their JSON schemas, records lifecycle events, and closes the connection at the end. HTTP connections and header environment references are also supported. See [MCP integration](docs/mcp.md).

## Plan, deploy, run

The starter includes `agent.project.json` with development and staging environments. Both use the local-process target; each has its own state/artifact paths. Environment names are application-defined, not a fixed list.

From a generated, installed, built starter:

```sh
runply plan --env staging
runply deploy --env staging --expect-plan <plan-id>
runply run --env staging
runply inspect <run-id> --env staging
runply status --env staging
```

The CLI prepares a build before planning. `plan --no-build` is the strictly read-only path, and the library's `planProject` remains read-only. `deploy --expect-plan` never rebuilds reviewed bytes. Deployment copies code and dependencies, validates trusted configuration, and selects a release for new runs; it does not invoke a model/tool or provision cloud resources.

Each deployed run executes in a fresh Node process from its selected snapshot. Deploying a new release does not modify a run already admitted on the old one. `runply pause --env staging` stops new admissions without cancelling existing work; deploy again to resume. `run --source --env staging` instead builds/runs the current source with staging bindings. See [deployment and ownership](docs/deployment.md).

The source of the example is [src/example.ts](src/example.ts). It shows the distinction between model decisions and application control: the model requests tools, while the application verifies the returned checks and renders the artifacts. The same library API can be called from an existing HTTP handler, job runner, or CLI without adopting the starter layout.

## What is here

| Capability | Status in this slice |
| --- | --- |
| Typed application and business tools | Implemented; offline-tested |
| AI SDK model adapter, namespaced provider options | Implemented; strict option schemas and local protocol fixtures tested |
| Agent tool loop | Reuses AI SDK; serial application-controlled tools |
| Permissions, in-process approvals, cancellation | Implemented; failure and late-completion tests |
| SQLite events and memory test store | Implemented; shared contract tests, reopen and stale-writer tests |
| Local artifact workspace | Implemented; hashes and concurrent publication tested; no isolation or process execution |
| `new`, `run`, `doctor`, `inspect`, `recover` | Implemented; subprocess tests |
| Project environments, `plan`, `deploy`, `status`, `pause` | Implemented for local-process; release-transition and concurrency tests |
| Release identity and dependency snapshots | Recorded with each deployed run; package integrity checked before activation and launch |
| OpenAI/Anthropic substitutability | Real provider adapters, mocked HTTP responses; not live-model testing |
| CLI build/test/install and tool generation | Implemented; command, cancellation, and non-overwrite tests |
| Local dev inspector | Implemented; loopback API tests and real browser acceptance |
| MCP tools, resources, prompts | Official SDK; stdio and local HTTP checks; resource/prompt access through library API |
| Token streaming, native schema output | Not implemented |
| Resumable sessions, cross-harness sessions, replay engine, caches, OTel export | Not implemented |

The underlying provider may support more than this harness. `doctor` reports model and harness capabilities separately. Requirements that the harness cannot fulfill fail before dispatch. No default model-call budget or timeout is imposed; applications may configure `maxSteps` and `timeoutMs`.

## Work on the framework

```sh
npm run check
npm run acceptance
npm run acceptance:inspector
```

These commands are for framework contributors, not application users. `check` type-checks, builds, and runs tests without external providers. `acceptance` uses only Runply commands after packaging to create/install/build a starter, generate a tool, test it, add local MCP, and plan/deploy/run staging. Browser acceptance exercises the inspector and verifies that rebuilding does not replay a run. Package installation may use npm; model validation is scripted or local-fixture based. Temporary projects are removed.

See [API and ownership](docs/architecture.md), [adapter guidance](docs/adapters.md), [verification](docs/verification.md), [contributing](CONTRIBUTING.md), and [security reporting](SECURITY.md).

## License

Runply and its starter code use [MIT](LICENSE). Dependencies retain their own licenses; the current AI SDK packages use Apache-2.0. See [third-party notices](THIRD_PARTY_NOTICES.md). No dependency is bundled into our JavaScript output.