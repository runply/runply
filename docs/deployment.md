# Application → environment → release → run

The application owns behavior. An environment selects bindings. A release captures what will execute. A run belongs to one release from admission through completion.

The first target, `local-process`, uses the current host. It needs no account, daemon, queue, Docker installation, or hosted control plane. It is not a sandbox or a cloud provisioner. The target name selects an installed implementation; this version implements only local-process, not a permanent vendor restriction.

## Project definition

The starter generates this shape in `agent.project.json`:

```json
{
  "schemaVersion": 1,
  "name": "document-reviewer",
  "entry": "dist/app.js",
  "defaultEnvironment": "development",
  "environments": {
    "development": {
      "target": "local-process",
      "model": "offline",
      "state": { "path": ".runply/environments/development/runs.sqlite" },
      "artifacts": { "path": ".runply/environments/development/artifacts" },
      "requirements": { "persistentState": true, "artifacts": true }
    },
    "staging": {
      "target": "local-process",
      "model": "offline",
      "state": { "path": ".runply/environments/staging/runs.sqlite" },
      "artifacts": { "path": ".runply/environments/staging/artifacts" },
      "requirements": { "persistentState": true, "artifacts": true }
    }
  }
}
```

`entry` identifies a built module inside the npm package. Use npm's `files` field or ignore files to select code and assets. The starter selects its compiled output and documents. The CLI prepares a build by default; the read-only `planProject` library function does not. The inventory describes actual packaged bytes.

State and artifact paths resolve relative to the project file, or can be absolute. They are environment resources outside the release snapshot. A changed binding does not move or delete old data. Such changes are shown in `plan`; migrations are not implemented.

Model names refer to the optional `models` registry in the application's exported composition. The reserved `default` selection uses the existing `model` field, preserving 0.1 modules. The starter registers `offline`. Environment `permissions` and `providerOptions`, when supplied, replace the application's corresponding values rather than merging silently. Business tools and agent messages do not change when another binding is selected.

Other optional fields are `variables`, `secrets`, and target `requirements`. Variables are string values; secrets are references such as `"BOUND_API_KEY": { "env": "PROVIDER_KEY" }`. The same key cannot be defined in both. Reference names are stored, but secret values are resolved from the invoking process for preflight and execution, never written into the release manifest by the framework. Inherited process environment is retained; this target is not hermetic.

Target capabilities currently declare release snapshots, persistent state, and artifacts. Isolation and resumable runs are false. Unknown fields or unmet requirements fail explicitly.

## Review and apply

```sh
runply plan --env staging
runply deploy --env staging --expect-plan <plan-id>
```

`runply plan` first prepares the build through the application's configured task. `plan --no-build` skips that preparation. The inventory phase uses `npm-packlist` directly; it does not launch npm, execute lifecycle scripts, import the application, contact a model, or create deployment state. The library's `planProject` remains strictly read-only. It reads manifests/files, hashes bytes, checks target requirements, and reports secret-reference availability without printing values.

The plan shows previous and desired bindings, the selected model name, package inventory, storage locations, and effects. Actual model capability and tool-permission validation happen during staged preflight, before activation. The plan states that distinction rather than presenting declarations as verified provider behavior.

`--expect-plan` makes the reviewed plan a precondition and skips any further build. If package bytes, bindings, the Node runtime, or the active environment revision changed, deployment fails and asks for a new plan. Without the flag, the CLI prepares a build and applies a fresh plan; `--no-build` is available when preparation is managed elsewhere.

Deployment copies the package and installed production dependency closure. Peer and declared bundled dependencies are included; optional missing dependencies are skipped as npm permits. A private directory layout with relative package links prevents normal package imports from resolving back into the editable project. License files selected by npm's packaging rules travel with dependencies. No dependency installation or lifecycle script runs during deployment.

The release records hashes, executable flags, Node version/path, host platform/architecture, the framework package, application entry, bindings, and package versions. This is a local snapshot of the installed tree, not a remote rebuild or a proof that the installed tree matches a registry lockfile. The Node executable itself and external host commands are not copied. Package binaries are not added to a new PATH catalog; explicit host executables remain host dependencies.

Preflight imports the trusted application module in a separate process, selects the model binding, and validates options, capabilities, and permissions. No framework model/tool invocation occurs. Application top-level code must be declarative: arbitrary code in an import can have its own effects. Snapshot integrity is checked again after preflight to catch changes before activation.

A SQLite transaction selects the release for new admissions with an expected revision. Two deployments based on the same reviewed revision cannot both activate. A failed preflight leaves the prior active release selected and removes its preparation directory. A process killed mid-preparation may leave an unreferenced directory; there is no automatic destructive cleanup.

## Execute and inspect

```sh
runply run --env staging
runply inspect <run-id> --env staging
runply status --env staging
```

A run selects the active release once. That selection is its admission boundary. Snapshot hashes, file inventory, internal dependency links, and manifest are checked before launch. A fresh child Node process executes the selected entry with its saved bindings; subsequent source edits or a new activation do not alter it.

The existing run record gains optional release metadata: release ID, environment, and project ID. `inspect` reads this along with the event timeline. Non-deployed 0.1-style runs still work without release metadata. The run store remains schema 1 because records are JSON with optional additive fields; the separate control database has its own schema 1.

Plain `run` inside a project now builds and runs current source in a fresh process. `run --app` retains the original module path for incremental adoption. `run --project` or `run --env` selects a deployed release unless `--source` is supplied. Explicit app/data overrides cannot be combined ambiguously with release bindings. `doctor` diagnoses source configuration; `status --env` reports the active release.

An explicit `--env` lets an active release run even while the source project file is invalid or has been removed. Without it, the CLI reads the source's default environment. Local project identity is based on the canonical project-file location; relocating a project does not automatically transfer its control database identity.

## Pause and shutdown

```sh
runply pause --env staging
```

Pause closes new admissions. Already admitted runs, including a child that has not finished starting, keep their selected release and may finish. It does not suspend processes, cancel tools, or replay work. A subsequent deployment resumes admission. It does not migrate data or roll back side effects.

SIGINT/SIGTERM on the run CLI propagates cancellation to the child. Cancellation remains cooperative for trusted code. A forced process exit can leave run state requiring the existing explicit recovery workflow. No scheduler, durable queue, automatic retry, worker pool, or cross-host lease is implemented.

## Evidence

The release suite holds an old run at a test-controlled gate, activates a changed package, starts a new run, pauses admission, then lets the old run complete. The new run returns version two; the old one reads version one from its own snapshot. Another test removes the source dependency directory and edits/removes source configuration while the deployed application keeps running with an explicit environment.

Other checks cover stale plans, competing activations, failed/mutating preflight, secret references, tampered/new snapshot files, large IPC inputs, and cancellation. [Verification](verification.md) records the actual runtime versions and measured starter journey.