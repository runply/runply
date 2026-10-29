# One application CLI

After installing Runply once, use its CLI for the application workflow. The framework's contributor build scripts are a different concern; generated applications do not need a sequence of manual npm commands.

| Command | Behavior |
| --- | --- |
| `runply new <directory>` | Generate, install, and build a working starter |
| `runply install` | Run the selected dependency installation command |
| `runply build` | Run the application's build task |
| `runply test` | Build, then run the application's test task |
| `runply generate tool <name>` | Create and register a tool and its behavior test |
| `runply add mcp <name> ...` | Add connection configuration, without connecting |
| `runply dev` | Watch/build and serve the local inspector |
| `runply run` | Build and run the current source project |
| `runply doctor` | Build and diagnose source configuration without calling models or opening MCP |
| `runply inspect [run-id]` | Read source-run records and event details |
| `runply plan --env staging` | Prepare build, then show a deployment plan |
| `runply deploy --env staging --expect-plan <id>` | Apply reviewed bytes without another build |
| `runply run --env staging` | Run the environment's active release |
| `runply status --env staging` | Show activation and binding state |
| `runply pause --env staging` | Close new release admissions without cancelling accepted work |

`--project` selects a project file. A project/environment flag on `run` selects its active release; add `--source` to run current source with those bindings. Outside a project, plain `run` keeps the bundled offline example. An explicitly requested missing source project is an error, not a fallback to the example.

## Build boundaries

By default, tasks use the project's npm scripts; custom commands can be supplied in the project definition's optional `tooling` object. Each command has `command` and an optional `args` array. The framework spawns these without a shell; if npm is selected, npm applies its own normal script semantics. There is no fixed vendor list.

The optional `tooling.watch` array selects paths for development watching. Defaults cover source, documents, package metadata, TypeScript configuration, and the project definition. Values are paths, not a promise to interpret every shell glob syntax.

`test --no-build`, `run --no-build`, `doctor --no-build`, and `plan --no-build` skip build preparation. `dev --no-build` watches and refreshes source configuration without invoking the build command. A missing build command is valid for an already runnable JavaScript project; a missing test command is a diagnostic error.

`planProject` in the library does not run build scripts. The CLI explicitly performs build preparation before calling it. Use `plan --no-build` when inspection must be strictly read-only. Deployment with `--expect-plan` does not rebuild; deployment without it prepares a build by default. Build logs go to stderr and the final structured command result goes to stdout.

## Generated tools

The starter spreads `generatedTools` into the application's tool map. `generate tool` adds a module, a test, and an import in the generated registry. It refuses to overwrite existing files or a user-edited registry. Put custom registry code outside the generated region rather than having a generator rewrite it.

Generated tools initially echo a typed text input and have explicit no-side-effect/idempotent metadata. Replace that implementation and metadata with the real business behavior. The generated behavior test is picked up by `runply test`. Existing starters must deliberately update their generated registry when adopting Runply; see [rename guidance](compatibility.md#renaming-the-working-build). The generator does not migrate old registries automatically.

## Development inspector

`dev` prints its loopback URL. The default port is 3005; `--port` can select another port. It displays build status, model and environment selection, configured components, run history, event details, and artifact downloads. Run creation and cancellation remain explicit. Multiple runs may be active; the current Cancel action requests cancellation of all active inspector invocations.

Changes rebuild the project and refresh configuration in a fresh process. They never trigger model inference or replay tool effects. Builds are serialized with another pass if changes arrive during a build; new source runs are not accepted against a half-written build. Existing source runs are not release snapshots—use deployed runs for code/version pinning.

The inspector uses the existing run store, not another telemetry database. API responses are uncached; event and artifact contents are treated as data. It binds to loopback, checks the local Host header, requires a per-session token for mutation, and checks browser Origin when supplied. These controls protect a local developer surface; they are not hosted authentication or sandbox isolation.

Payload capture remains off by default. The UI labels omitted content rather than reconstructing it. Application configuration imports and build scripts are trusted code; keep imports declarative. This version has no interactive approval inbox—approval-required tools still need an application approval handler and otherwise fail closed.