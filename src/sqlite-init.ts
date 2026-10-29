/** Retry only idempotent SQLite initialization, never a run, model call, or tool. */
export function initializeSQLite(action: () => void): void {
  // Match the existing connection busy timeout. WAL-mode promotion can return
  // SQLITE_BUSY immediately instead of invoking SQLite's busy handler.
  const deadline = performance.now() + 5_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { action(); return; }
    catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code !== 5 && code !== 6 || performance.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
}