# Contributing

Use Node 24 LTS. Install with `npm ci`, then run `npm run check`. The tests do not require provider keys. `npm run acceptance` checks the packed package from a fresh starter directory; npm may download dependencies but no model provider is contacted.

Type checking builds the production entry points first: integration tests intentionally import compiled modules. The `pretypecheck` hook keeps `npm run check` valid on a clean checkout without an existing build directory.

These npm commands maintain the framework itself. Application-facing examples must use the Runply CLI. `npm run acceptance:inspector` exercises the actual browser UI, rebuild behavior, and artifact output. It uses an installed Chrome on macOS when present, or Playwright Chromium. The CI browser job installs Chromium separately and does not publish anything.

Application behavior and business tools live in `src/example.ts`. Framework contracts are in `src/contracts.ts`, execution in `src/runtime.ts`, and the CLI in `src/cli.ts`. Tests include real provider adapter code driven by local protocol fixtures, shared store contracts, and child-process interruption checks.

The release layer lives in `src/project.ts`, `src/releases.ts`, and `src/release-host.ts`. `src/snapshot.ts` uses npm-packlist rather than reimplementing npm's file-selection rules. Release tests use temporary packages and actual child processes; do not replace them with a mocked deployment result. Planning must not execute package lifecycle scripts or import application code.

The read-only constraint above applies to `planProject` and CLI `plan --no-build`; CLI build preparation is separate and visible. MCP tests use real stdio servers and a loopback HTTP server. Dev tests exercise Host/token/Origin handling, no-replay rebuilding, concurrent first runs, and process cleanup. Preserve those boundaries when extending the CLI.

For an adapter change, keep the same business application in the substitutability tests. Add evidence for new capability claims. A common method name is not evidence of equivalent security, recovery, model quality, or provider behavior.

Changes to public APIs need version-aligned documentation and a working example. Keep documentation in English. State what was executed, what was mocked, and what remains untested. Do not replace a failed assertion with a weaker capability declaration just to make the suite pass.

Do not add provider credentials, real customer documents, generated run stores, or build output to a contribution. Live provider tests, package publication, external deployment, and repository pushes require explicit maintainer authorization. The default test and CI path must remain offline with respect to model providers.

Before sending a change, run the production build as well as tests. Review the package contents using `npm pack --dry-run`. See [release practices](docs/releasing.md) and [security reporting](SECURITY.md).