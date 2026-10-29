# Verification record

## Runply package validation

The framework is now Runply at version 0.3.0. Package/CLI names, starter imports, generated tools, MCP client identity, and inspector labels/session headers were updated. Existing data directories and stored release snapshots were left in place.

Node 24.22.1 and Node 22.23.2 each passed **351 tests across 16 files**, type checking, and the production build on macOS arm64. The extra legacy-data case verifies that old Karateke run data remains readable through an explicit path without migration. An initial broad test run reported a plan mismatch; the isolated scenario and both subsequent complete suites passed without changing the stale-plan checks.

Packed `runply@0.3.0` starter acceptance passed on both runtimes, including generated-tool testing, local MCP connection lifecycle, and plan/deploy/run/inspect. Chrome/Playwright acceptance passed with the Runply inspector at desktop 1440×1100 and mobile 390×844, with no browser errors or external browser requests. These checks used local/scripted model execution, not a live model provider.

Single-sample first-useful-run times were 3,858 ms on Node 24 and 2,190 ms on Node 22 with npm cache retained, using two application CLI operations after CLI availability. These are not cold-cache measurements. A local distribution archive is prepared separately; no npm publication, GitHub push, or external transfer is performed.

The sections below retain their original names and measurements as historical records.

## Version 0.3: one CLI, MCP, and the dev inspector

On macOS arm64, Node 24.22.1 and Node 22.23.2 each passed **350 tests across 16 files**, type checking, and the production build. Packed-starter acceptance passed on both runtimes. Application steps after packaging used Karateke commands only: new/install/build, run, inspect, doctor, generate tool, test, add MCP, plan, deploy, and release execution.

MCP validation used real local stdio child processes and an official SDK Streamable HTTP server on loopback. The tests cover paginated tools, original schema forwarding, native resources/prompts, structured output, failures, cancellation, and cleanup. The HTTP fixture independently checks that doubling 21 returns 42 and that the referenced authorization header reaches the local server. No external MCP service or model provider was contacted.

The real-browser acceptance used Chrome through Playwright on Node 24. It ran the application, inspected its timeline and artifact links, changed a document, observed a rebuild with no extra run, explicitly ran again, and verified the changed report. Desktop 1440×1100 and mobile 390×844 layouts passed; there were no page errors or external browser requests. The final screenshot was visually inspected. CI has a browser job definition but has not been run on GitHub.

Single-sample CLI-only measurements with npm cache retained:

| Step | Node 24 | Node 22 |
| --- | --- | --- |
| `new` including install/build | 3,146 ms | 1,769 ms |
| First explicit source run | 504 ms | 459 ms |
| Creation through useful result | 3,651 ms | 2,228 ms |
| Generate tool | 114 ms | 109 ms |
| Build and test starter | 603 ms | 592 ms |
| Add local MCP configuration | 113 ms | 126 ms |
| Build and plan staging | 1,951 ms | 1,971 ms |
| Deploy reviewed release | 3,876 ms | 4,236 ms |
| Release run including MCP lifecycle | 1,017 ms | 1,271 ms |

Two CLI operations (`new`, `run`) produced the first useful result after CLI installation, with zero manual configuration edits or provider credentials. This excludes obtaining/installing Node and the CLI, framework packing, and changing directories. It is not a cold-cache benchmark. The plan measurement now includes build preparation, unlike the 0.2 read-only plan measurement below. The tested release contained 5,427 files and 32,498,000 bytes before filesystem overhead.

A cold-start race surfaced when two Node 22 processes initialized a new SQLite database at once. Busy timeout alone did not handle WAL-mode promotion, which can return SQLITE_BUSY immediately. Only that idempotent setup statement now retries within the existing five-second connection wait budget. Runs, model calls, and tools are not retried. The failing concurrent-run regression then passed repeatedly and in both full suites. The initial failure remains part of this record rather than being treated as a successful first attempt.

Current gaps: interactive approval UI, provider preset installation, OAuth onboarding, external MCP service interoperability, token streaming, native model schema output, execution isolation, cloud targets, OTel export, caches, and durable session continuation are not established by this slice. Publishing and hosted deployment remain the maintainer's actions. No package publication, GitHub push, or billable provider verification was performed.

Earlier sections below are historical results from their named versions, not the current feature inventory.

## Karateke naming validation

The framework name, package, command, and new default data directory were updated to Karateke without changing the event or database schemas. The existing Switchlane routing product was not modified.

After the rename, Node 24.22.1 and Node 22.23.2 each passed **185 tests across 10 files**, type checking, and the production build on macOS arm64. Packed-starter acceptance passed under `karateke@0.2.0` on both runtimes, including local plan/deploy/run/inspect. New regression tests verify package/lockfile/CLI name alignment and explicit read-only access to legacy run data without moving it. No registry publication or package-name availability check was performed.

The measurements below describe earlier validation runs; they are retained as history rather than relabeled as new measurements.

## Version 0.2: local release lifecycle

Executed on macOS arm64 using Node 24.22.1 and Node 22.23.2. Both passed the production build, type check, and **182 tests across 9 files**. Both also passed packed-package starter acceptance through plan, deploy, separate-process run, release-aware inspect, and status. GitHub CI has not been executed.

The release suite contains 14 integration scenarios using actual temporary package snapshots and child processes. It verifies an in-flight run staying on version one while new work uses version two, pause/drain behavior, failed and mutating preflight preserving the active release, competing reviewed deployments, source/dependency removal, secret references, stale plans, file tampering/injection, a 2 MB IPC input, and cancellation. Project and control-store tests add arbitrary environment names, path resolution, strict settings, schema versions, revisions, and rollback checks.

The quote application's provider substitution tests remain unchanged in purpose: real adapter code, local HTTP fixtures, no provider inference. The new environment test also selects another scripted model binding and storage path without editing the business module.

Single-sample packed-starter measurements, with npm cache retained:

| Step | Node 24 | Node 22 |
| --- | --- | --- |
| Creation through first useful source run | 2,311 ms | 1,625 ms |
| Read-only staging plan | 814 ms | 870 ms |
| Local staging deployment | 1,830 ms | 1,893 ms |
| Run from staged release | 549 ms | 571 ms |
| Inspect deployed run | 153 ms | 149 ms |

The generated starter needed no configuration edits or credentials for either path. The measured release snapshot contained 2,575 files and 20,893,567 bytes before filesystem overhead, including production dependencies. This target uses full local copies, not a deduplicating image store. Each successful document review still performed three scripted model steps, two real tool calls, and published two artifacts. The state record was checked against the activated release ID and staging environment.

These timings exclude Node installation and are not a cold-cache benchmark, cloud deployment benchmark, or comparison between Node versions. Deployment runs locally and performs no framework model/tool calls. No external resources were provisioned, packages published, or repository changes pushed.

A planning regression was found and fixed during implementation: the installed npm CLI invoked a dependency's `prepare` script even in the attempted dry-run/ignore-scripts path. Planning now calls npm-packlist directly and is tested against a package whose prepare script would fail if executed. It does not launch npm or import application code. Ordinary build and installation commands remain explicit developer operations.

The release host is a process boundary, not isolation. Cloud targets, build automation, external resource provisioning, distributed scheduling, sandboxing, durable resumption, and rollback/data migration remain outside this slice. Web inspector and MCP integration are still planned.

## Version 0.1: initial application slice

Local validation: macOS arm64, October 27, 2026. These are executed checks, not release-readiness claims.

| Check | Node 24.22.1 | Node 22.23.2 |
| --- | --- | --- |
| Type check and production build | Passed | Passed |
| Offline framework suite | 100 passed, 6 files | 100 passed, 6 files |
| Packed-package starter installation/build | Passed | Passed |
| Generated starter behavior test | Passed | Passed |
| Run, inspect, doctor and artifact hashes | Passed | Passed |

Node 22 emitted the built-in SQLite experimental warning. It was not hidden. Linux/macOS CI jobs have been defined but have not been run on GitHub. Windows and the exact minimum Node patch version have not been tested locally.

## What the suite exercised

The same quote application ran through OpenAI Chat and Anthropic Messages adapter implementations using local HTTP response fixtures: 22 tests. Provider option mapping, known usage totals, tool results in the next request, malformed output, incorrect business totals, HTTP errors, and zero automatic retries were checked. These are protocol-fixture results, not live provider certification or model-quality measurements.

Runtime tests cover permissions, approvals, cancellation before/during execution, timeouts, missing tools, malformed arguments, output validation, duplicate call IDs, configurable step budgets, secret-key masking, concurrent run isolation, and late completions. Additional finalization tests check non-cooperative hooks, uncertain artifact publication, and model capabilities that the harness cannot fulfill. A schema that strips a provider option is rejected before dispatch.

The memory and SQLite stores pass the same contract suite. SQLite also passes reopen, separate-connection stale-write, read-only inspection, and newer-schema rejection tests. Workspace tests independently recalculate artifact sizes and SHA-256 values and exercise concurrent publication.

The interruption check starts a real child process. A test-owned external-effect tool appends one line to a file, then the parent kills the process with SIGKILL. The run stays nonterminal until explicit recovery marks it interrupted. Inspection and recovery leave the file with exactly one line: no implicit re-execution.

Two assertions were added after code review: cancellation during artifact-event recording must preserve the event, and finalization errors must not publish output. Both pass. The review's suspected artifact-event loss in that synchronous section was not reproduced; cancellation during unfinished publication is instead explicitly recorded as an unknown outcome.

## Developer-experience observations

A local tarball was installed into a newly generated temporary application, rather than testing against an accidentally linked source checkout. The starter needed zero configuration edits and zero provider credentials. Creation, dependency installation, application build, and first run took four commands.

Single-sample timings with an already populated npm cache:

| Step | Node 24 | Node 22 |
| --- | --- | --- |
| Starter generation | 63 ms | 64 ms |
| Dependency installation | 649 ms | 652 ms |
| Starter build | 577 ms | 612 ms |
| First useful run | 299 ms | 310 ms |
| Total creation through useful result | 1,588 ms | 1,638 ms |
| Read-only run inspection | 146 ms | 144 ms |
| Configuration diagnosis | 138 ms | 146 ms |

The total excludes Node installation, obtaining/building the framework source, and tarball packing. Cache state was not reset, and these numbers are not a cold-start benchmark or a comparison between Node versions. A useful run means three scripted model steps, two actual tool calls, and two verified artifacts. The expected literal-term results were independently asserted as found / absent / found.

A final Node 24 rerun after documentation updates also passed: 1,939 ms from starter creation through the useful result, with the npm cache retained. Fourteen local documentation links were checked for existing targets.

Switching between the two tested provider implementations changed only the model factory and provider-specific fixture/options setup; the quote application and business tool were unchanged. That is a tested substitution, not a measured human migration time. For failure diagnosis, CLI tests verified actionable errors for unsupported flags and attempts to recover a still-live process, while the run timeline retained the last tool start after a killed process. No human usability timing was measured.

## Scope still planned

The web inspector, MCP integration, OpenTelemetry export, token streaming, native schema-constrained output, execution sandboxes, caches, durable session continuation, mocked replay, and re-execution tooling are not implemented in this slice. No cross-harness portability, security-equivalence, or production-readiness claim is made.

No live provider API call, credit-consuming verification, package publication, external deployment, or repository push was performed. Package installation used npm; all model execution in validation was scripted or fixture-backed. The installed dependency audit initially reported zero known vulnerabilities; that is a point-in-time tool result, not a security certification.