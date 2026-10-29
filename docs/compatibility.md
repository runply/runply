# Version compatibility

The current slice is version 0.3.0 and has not been published. Dependencies are pinned in the package and lockfile so examples and conformance fixtures target the same versions.

| Component | Version used |
| --- | --- |
| AI SDK | 7.0.155 |
| AI SDK provider contract | 4.0.34; `LanguageModelV4` |
| OpenAI adapter (fixture tests only) | 4.0.104 |
| Anthropic adapter (fixture tests only) | 4.0.90 |
| Zod | 4.6.7 |
| TypeScript | 7.0.2 |
| Vitest | 5.0.5 |
| SQLite run schema | 1, via Node's built-in SQLite |
| Local release control schema | 1, separate from the run database |
| npm-packlist | 10.0.4, ISC; package selection only, no lifecycle scripts |
| MCP TypeScript SDK | 1.32.2, MIT |
| Ajv | 8.20.0, MIT |
| Chokidar | 4.0.3, MIT |
| Playwright (development only) | 1.64.1, Apache-2.0 |

The runtime requires Node 22.13 or newer because this slice uses built-in SQLite without a command-line enable flag. Node 24 LTS is the recommended development runtime. Node 24.22.1 and Node 22.23.2 both passed the full suite and packed-starter acceptance locally on macOS arm64. The CI definition targets Node 22 and 24 on Linux and macOS. Actual local results, rather than configured CI jobs, are recorded in [verification](verification.md).

The compiler explicitly loads Node types. This matters with the installed TypeScript version: test imports can bring in Node declarations indirectly while a production-only build cannot.

Provider capabilities and harness capabilities are different. The first harness does not implement token streaming, native schema output, provider-executed tools, persisted approval continuation, or session resumption. JSON output is validated locally. The model protocol remains accessible through the adapter for integrations outside this harness.

## Upgrading

### From 0.2 to 0.3

Application use now goes through Runply commands. `new` installs/builds by default; `--no-install` and `--no-build` opt out. Plain `run` and `doctor` detect the current project and prepare a build. Existing `run --app` modules remain available. `run --env` still means a deployed release; add `--source` for current source with another environment's bindings.

CLI `plan` now prepares a build before the read-only inventory phase. Use `plan --no-build` to keep the entire operation read-only. `deploy --expect-plan` never rebuilds. The library's `planProject` behavior is unchanged.

New optional fields are project `tooling`, environment `mcp`, application `components`, and tool `inputJsonSchema`. Component lifecycle event types are additive; consumers should handle unknown event types rather than assume the original fixed list. Old run data and release snapshots are not rewritten.

An older starter's npm test script may already build; `runply test` can therefore build twice until that script is simplified or a `tooling.test` command is supplied. New starters use a test-only underlying task. Do not point an underlying build/test task directly back to the same Runply command.

### Renaming the working build

This framework is now Runply, following the prior working names Switchlane and Karateke. The original Switchlane router belongs to the maintainer and remains a separate, unchanged product. This is a local rename of the unpublished framework at version 0.3.0, not a release or migration of that router.

The npm package and command are `runply`; imports use `runply`, `runply/testing`, or `runply/example`. Existing starter projects from either prior working name need their dependency name, imports, and npm scripts updated when adopting this build. Newly generated starters use the new name. No registry publication or npm/domain name-availability check has been performed.

When adopting tool generation in an existing starter, deliberately update the generated registry marker from `// karateke generated tool registry v1: ` to `// runply generated tool registry v1: `, retaining its tool-name metadata and updating package imports. Review the registry against the new generated format; the generator requires an unchanged generated registry and does not migrate an old marker or custom registry automatically. Keep custom tools outside the generated registry.

The default data directory is now `.runply/`. Existing `.karateke/` and `.switchlane/` directories are neither migrated nor deleted. Use `runply inspect --data .karateke` or `runply inspect --data .switchlane` for old source-run records. For an existing deployed environment, keep its explicit state/artifact bindings and use `--control .karateke/control` or `--control .switchlane/control`, matching its existing control directory, with the original project location and environment. For example, `runply status --env staging --control .karateke/control` reads the old staging activation. Stored release code and dependency snapshots retain their original names and are not rewritten. The old release's recorded Node runtime must still be available. Event and database schemas are unchanged.

### From 0.1 to 0.2

Existing `run --app` modules and the core application/tool API remain supported. The optional run `release` field does not require changing old run records. To adopt deployment, add a project definition, include the built entry/assets in npm packaging, and select named model bindings in the exported composition. The new starter demonstrates this without changing business behavior. Existing SQLite run files are not migrated or moved automatically.

Deployment captures installed production dependencies and the exact Node version used for planning. Updating Node or any package requires a new plan/release. Native host tools and the Node binary itself are not included; the local target is not a cross-platform build artifact.

Update one dependency boundary at a time. Run type checking, the production build, offline conformance tests, and packed-starter acceptance. Inspect provider request fixtures rather than only updating expected snapshots. If an SDK changes warning or error semantics, verify that unsupported options still fail and no hidden retries appear.

Do not silently upgrade the run-store schema. Future migrations need versioned steps, fixtures from the previous schema, backup guidance, and interruption tests. This slice rejects a newer schema and has no downgrade path.

During 0.x, breaking public API changes require a minor-version change and migration notes. Patch releases preserve the documented API. Event and database schema versions are independent of package branding. A release matrix should distinguish compile-tested, fixture-tested, and live-tested adapter versions; currently the providers are fixture-tested only.