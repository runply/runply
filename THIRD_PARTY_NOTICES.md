# Third-party notices

Runply's original code and starter are MIT-licensed. Dependencies are not relicensed by that choice. The TypeScript build leaves dependency imports external; the npm tarball does not bundle their implementation code.

The following table records the original runtime dependency set and the direct additions. The lockfile is the complete version inventory, including the MCP SDK's transitive dependencies.

| Package | Locked version | Declared license |
| --- | --- | --- |
| ai | 7.0.155 | Apache-2.0 |
| @ai-sdk/provider | 4.0.34 | Apache-2.0 |
| @ai-sdk/provider-utils | 5.0.70 | Apache-2.0 |
| @ai-sdk/gateway | 4.0.128 | Apache-2.0 |
| @vercel/oidc | 3.2.0 | Apache-2.0 |
| @workflow/serde | 4.1.0 | Apache-2.0 |
| @standard-schema/spec | 1.1.0 | MIT |
| eventsource-parser | 3.1.1 | MIT |
| json-schema | 0.4.0 | AFL-2.1 OR BSD-3-Clause |
| undici | 7.30.1 | MIT |
| zod | 4.6.7 | MIT |
| npm-packlist | 10.0.4 | ISC |
| ignore-walk | 8.0.0 | ISC |
| proc-log | 6.1.0 | ISC |
| minimatch | 10.2.6 | BlueOak-1.0.0 |
| brace-expansion | 5.0.12 | MIT |
| balanced-match | 4.0.4 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| ajv | 8.20.0 | MIT |
| chokidar | 4.0.3 | MIT |

The installed OpenAI and Anthropic provider adapters are development/test dependencies and declare Apache-2.0. TypeScript declares Apache-2.0; Vitest and Node type declarations declare MIT. Development dependencies are not installed as production dependencies of this package.

Keep the upstream copyright/license notices, and any upstream NOTICE files, when redistributing dependencies. Apache-2.0 dependencies include explicit patent terms; MIT licensing of the framework does not remove them. `json-schema` offers a license choice; downstream redistributors must comply with the license they choose, such as BSD-3-Clause. Service terms and model-weight licenses are separate from SDK licensing.

The presence of the AI SDK gateway package as a transitive dependency does not require using its service. This framework passes explicit model implementations to the SDK. The bundled model and default tests do not use a gateway or any model provider.

Version 0.2 adds npm-packlist to select application/dependency files without invoking npm lifecycle scripts. Local release directories contain copied dependency package files and their upstream notices; these local snapshots differ from the framework's npm tarball, whose imports remain external. ISC, BlueOak, MIT, and Apache-2.0 dependency terms remain applicable to their respective packages.

The 0.3 lockfile contains 112 non-development package entries: 91 MIT, 10 ISC, 6 Apache-2.0, 2 BSD-3-Clause, 1 BSD-2-Clause, 1 BlueOak-1.0.0, and 1 dual AFL-2.1/BSD-3-Clause entry. No undeclared license was found in that metadata check. This is an inventory, not a substitute for preserving upstream license/notice files. Playwright 1.64.1 is a development-only Apache-2.0 dependency.