export type ErrorCode =
  | 'INVALID_INPUT' | 'INVALID_OUTPUT' | 'CAPABILITY_MISMATCH' | 'UNSUPPORTED_OPTIONS'
  | 'MODEL_ERROR' | 'TOOL_ERROR' | 'TOOL_UNAVAILABLE' | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED' | 'CANCELLED' | 'TIMED_OUT' | 'CONFLICT'
  | 'NOT_FOUND' | 'STEP_LIMIT' | 'WORKSPACE_ERROR' | 'CONFIGURATION_ERROR';

export class FrameworkError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameworkError';
  }
}

export function normalizeError(error: unknown, fallback: ErrorCode = 'MODEL_ERROR'): FrameworkError {
  if (error instanceof FrameworkError) return error;
  return new FrameworkError(fallback, error instanceof Error ? error.message : String(error), { cause: error });
}

/** Stop waiting on non-cooperative implementations, without claiming to stop their side effects. */
export async function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}