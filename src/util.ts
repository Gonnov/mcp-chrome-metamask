/** Small helpers shared by every layer. No imports from the project. */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First line of an error message: Playwright appends a multi-line call log. */
export function errLine(err: unknown): string {
  return errMessage(err).split('\n')[0] ?? '';
}

/** Whether a process id is alive (signal 0). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isHttpUrl(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Request ids for the page bridge: time-ordered, with enough randomness that ids minted in one millisecond never collide. */
export function newReqId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** The wire shape of an error, identical on the daemon's HTTP API and the MCP tools. */
export interface ErrorBody {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

export function toErrorBody(err: unknown): ErrorBody {
  const e = (err ?? {}) as { code?: unknown; details?: unknown; name?: unknown };
  const code =
    typeof e.code === 'string' ? e.code : err instanceof Error && err.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR';
  const details = e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : undefined;
  return { error: errMessage(err), code, ...(details ? { details } : {}) };
}
