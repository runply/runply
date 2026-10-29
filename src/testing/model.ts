import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4Content } from '@ai-sdk/provider';
import { FrameworkError } from '../errors.js';
import { aiSdkModel } from '../model.js';

export function modelResponse(content: string | LanguageModelV4Content[], finishReason: LanguageModelV4GenerateResult['finishReason']['unified'] = 'stop'): LanguageModelV4GenerateResult {
  return {
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
}

export function toolResponse(name: string, input: unknown, id: string): LanguageModelV4GenerateResult {
  return modelResponse([{ type: 'tool-call', toolName: name, toolCallId: id, input: JSON.stringify(input) }], 'tool-calls');
}

/** A scripted model: real tools execute, but no model inference or network calls occur. */
export function fakeModel(respond: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult> | LanguageModelV4GenerateResult) {
  return aiSdkModel({
    id: 'offline:scripted',
    capabilities: { tools: true, streaming: false, structuredOutput: false },
    model: {
      specificationVersion: 'v4', provider: 'offline', modelId: 'scripted', supportedUrls: {},
      async doGenerate(options) { options.abortSignal?.throwIfAborted(); return respond(options); },
      doStream() { throw new FrameworkError('CAPABILITY_MISMATCH', 'Scripted model does not implement token streaming.'); },
    },
  });
}