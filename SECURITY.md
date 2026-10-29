# Security reporting and current boundaries

Report a security issue privately to the maintainer through the private channel already used for this project. Do not post credentials, customer documents, or exploitable details in a public issue.

This repository has no configured public reporting address or published repository advisory channel yet. The maintainer must establish one before public release. No response-time promise is made during this local development stage.

Include the affected version, minimal reproduction, expected boundary, actual behavior, and whether an external side effect occurred. Use synthetic data. A useful report can show a violated permission, an incorrectly claimed isolation guarantee, credential exposure, an unexpected replay, or corrupted run state.

Tools, application modules, and finalizers are trusted code running in the Node process. The local workspace is an artifact directory, not a sandbox. Importing an application module executes its top-level code. `inspect` deliberately does not import it.

Local deployment uses a separate process and verifies release-file hashes and dependency links; it does not establish a security boundary against the host owner. Code and dependencies are copied, while Node and external host commands remain host resources. A release must not include credentials in packaged files. Keep secrets in environment references, not ordinary configuration values. Release planning does not import code; deployment preflight does, so top-level application code must not make external calls or changes unexpectedly.

Payload capture is disabled by default. Structured secret-key masking is not a general secret detector. Artifact files and returned application errors can contain sensitive data; storage permissions, retention, and any encryption policy belong to the deploying application.

Cancellation stops waiting and fences event writes. It cannot forcibly stop arbitrary trusted code or roll back an external service. Interrupted operations require application-specific reconciliation. Recovery never replays an external action automatically.

The development inspector listens on loopback and uses a session token for mutation plus Host/Origin checks. It is not a hosted management API. Artifact responses are downloads rather than executable pages; event content is inserted as text. Payload capture remains off by default. Rebuilding never automatically creates another run.

MCP connections inherit their configured server/host privileges. Remote tool annotations do not grant local permission, prove idempotency, or establish isolation. Header secrets use environment references. Review the server package and endpoint you configure; the framework does not certify arbitrary MCP services. Connection failure or cancellation does not prove that an external side effect was rolled back.