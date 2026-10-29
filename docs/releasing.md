# Release practices

Nothing in this repository publishes automatically. Package publication, external deployment, and pushing to a hosted repository require explicit authorization.

Before a release, run `npm ci`, `npm run check`, and `npm run acceptance` on the supported runtime matrix. The acceptance script inspects and installs a local tarball; it does not publish it. Review the packed file list for secrets, run databases, and dependency directories.

For the dev surface, also run `npm run acceptance:inspector` with an available Chromium/Chrome. Application examples and acceptance steps after packaging use Runply CLI commands, not a manual npm workflow. Publishing remains the maintainer's action; no publication workflow is configured.

Update the package version, lockfile, compatibility matrix, and migration notes together. Record offline fixture results separately from any explicitly authorized live tests. Keep unsupported capabilities labeled. Review transitive licenses and vulnerabilities at the locked versions; preserve upstream license and NOTICE files when redistributing dependencies.

The source repository is [runply/runply](https://github.com/runply/runply). GitHub releases distribute npm-compatible archives and checksums; they are separate from npm registry publication. Runply is the chosen project name, not a claimed npm namespace or domain allocation. Configure a public security-reporting channel before making a public release; the current reporting guidance is in SECURITY.md.

CI uses read-only repository permissions and has no publishing credentials. Before enabling public release automation, pin actions to reviewed commit SHAs and set the publishing workflow separately from tests.