# Document reviewer

This application uses a scripted offline model. Documents are read and tools run for real; no model inference or network request occurs. The checks are literal-term matches, not semantic compliance assessments.

`runply new` installs and builds this project. Use `runply dev` for the local inspector, `runply run` for an explicit run, and `runply test` for behavior tests. `runply doctor` diagnoses configuration without contacting a model provider or MCP server. `runply inspect <run-id>` prints the stored event timeline.

Use `runply generate tool <name>` to create a registered tool and test. `runply add mcp <name> --command <executable> --arg <argument>` adds a local MCP connection; `--url` selects HTTP instead. Adding configuration does not connect or execute a tool. Replace generated business logic with your own.

The application source contains the instructions, input/output schemas, and business tools. Change these to implement your application. The framework owns tool dispatch, permission checks, run identity, recording, and artifact publication.

The framework dependency points to the local directory or tarball used to generate this starter. No published package or account is required. If you move the source package, update that dependency path.

## Local releases

The generated project definition has development and staging environments with separate state/artifact locations. Both bind the offline model. `runply plan --env staging` prepares a build and shows its plan; add `--no-build` for strictly read-only planning. Apply reviewed bytes with `runply deploy --env staging --expect-plan <plan-id>`.

`runply run --env staging` starts a run from the selected release snapshot in a new process. `runply inspect <run-id> --env staging` reads its recorded release and events. `runply status --env staging` reports activation state. `runply pause --env staging` stops new admissions without cancelling existing work; deploy again to resume admission. `runply run --source --env staging` uses current source and staging bindings instead.

The inventory phase uses npm package file-selection rules without executing scripts or importing the application; CLI build preparation is a separate preceding step. Deployment copies code/dependencies and activates locally without framework model/tool calls or cloud provisioning. An old in-flight run keeps its old release. `dev` rebuilds changes without automatically replaying runs or external effects.

Runs and artifacts are stored locally under `.runply/` by default. Existing `.karateke/` and `.switchlane/` data are neither migrated nor deleted. Read old source-run records with `runply inspect --data .karateke` or `runply inspect --data .switchlane`. For old deployed environments, retain their explicit state/artifact bindings, original project location, and environment; select `--control .karateke/control` or `--control .switchlane/control` explicitly. Tool and model payloads are omitted from traces by default; the final application output is printed by the CLI. The local workspace is not a sandbox.

To replace the model, supply an `aiSdkModel` adapter in the exported configuration. Declare only verified capabilities and validate provider-specific options using a strict schema. Keep tests offline. A shared contract does not establish equivalent model quality.