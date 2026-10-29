# Writing and testing adapters

## Models

`aiSdkModel` accepts an AI SDK `LanguageModelV4`, an adapter ID, a capability declaration, and optionally a provider-options schema. Supply a provider object directly; the framework does not resolve a gateway model string for you.

The default options schema is `z.strictObject({})`: it accepts no provider options. To preserve an extension, declare its actual namespace and fields in a strict schema, then pass the validated object through `RuntimeOptions.providerOptions`. The framework also rejects schemas that silently remove input keys, including nested keys. Capability declarations are adapter claims; reusable tests and real-provider evidence must be reported separately.

The executable examples are in [the provider contract tests](../tests/providers.test.ts). One application runs against the installed OpenAI Chat and Anthropic Messages adapters. Both use injected local `fetch` implementations with dummy credentials. The tests assert the provider-specific option arrives in the request, the real tool result reaches the next turn, token usage is mapped, unknown options cause zero transport calls, and HTTP failures are not retried.

To add an adapter, add a factory and protocol fixtures to that parameterized suite. Keep the application and expected business result unchanged. Cover unsupported options, malformed output, unavailable tools, and the capabilities you declare. A passing fixture test says that the integration maps those fixtures correctly. It says nothing about live model quality, availability, or undocumented provider behavior.

## Stores

Implement `RunStore` and run the shared factory-based suite in [store tests](../tests/store.test.ts). It checks detached snapshots, per-run ordering, stale writers, owner checks, JSON persistence, terminal-state fencing, and explicit interruption. SQLite additionally tests reopening and read-only inspection.

The memory store is a supported test helper. It is not a persistent backend and does not claim recovery. Test helpers share the package's versioning policy, not the private API of an unrelated SDK.

## Workspaces

Implement `Workspace.publish` and declare what the backend actually provides. Artifact names in this interface are filenames, not arbitrary paths. The local implementation writes only to its configured artifact root, but it is trusted code on a shared host, not an isolation boundary.

The workspace tests check bytes, hashes, invalid names, duplicate publication, and competing writers. An adapter advertising process execution or isolation needs separate acceptance evidence for those properties; existing local tests cannot establish them.

## Existing projects considered

| Project | Role in the initial design |
| --- | --- |
| [AI SDK](https://ai-sdk.dev/docs/introduction) | Current dependency for provider access and the tool loop |
| [Mastra](https://mastra.ai/docs) | Alternative framework and reference for starter/development experience |
| [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) | Potential future runtime integration for checkpointed workflows |
| [MCP SDKs](https://modelcontextprotocol.io/docs/sdk) | Current dependency for tools, resources, prompts, stdio and Streamable HTTP |

These roles come from documentation review. No comparative performance benchmark has been run, and no superiority claim is made.