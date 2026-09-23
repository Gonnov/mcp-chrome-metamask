/** Orderly daemon shutdown, shared by `stop`, signals and crash handlers. */
import { close } from './browser.js';
import { markStopping } from './server.js';
import { clearDaemon, readDaemon, writeDaemon } from './state.js';

/**
 * Flag the record as stopping, synchronously, so no launcher starts a twin
 * while the profile is still held and every probe from now on says so.
 */
export function beginShutdown(): void {
  markStopping();
  const current = readDaemon();
  if (current && current.pid === process.pid) writeDaemon({ ...current, stopping: true });
}

/** Flush and close the browser, then remove the record and exit. */
export function finishShutdown(exitCode = 0): void {
  void close()
    .catch(() => undefined)
    .finally(() => {
      clearDaemon(process.pid);
      process.exit(exitCode);
    });
}

export function shutdown(exitCode = 0): void {
  beginShutdown();
  finishShutdown(exitCode);
}
