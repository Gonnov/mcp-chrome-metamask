import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { DAEMON_LOG, ROOT, ensureDirs, readDaemon } from './daemon/state.js';
import type { CmdResult, DaemonInfo } from './types.js';
import { alive, sleep } from './util.js';

const ENTRY = resolve(ROOT, 'src/daemon/index.ts');
const LOADER = resolve(ROOT, 'node_modules/tsx/dist/loader.mjs');

/** argv for `node` to run the daemon from source through the tsx loader. */
export function daemonSpawnArgs(headless: boolean, extra: string[] = []): string[] {
  return ['--import', LOADER, ENTRY, ...(headless ? ['--headless'] : []), ...extra];
}

/** An error from the daemon, with its code and details intact for the caller. */
export class DaemonError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
    if (details) this.details = details;
  }
}

export type DaemonState = 'ready' | 'booting' | 'stopping' | 'down';

/** Ask a recorded daemon how it is doing, without ever hanging on it. */
export async function probe(info: DaemonInfo | null, timeoutMs = 3000): Promise<DaemonState> {
  if (!info?.port || !info.token) return 'down';
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { 'x-rig-token': info.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return 'ready';
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { booting?: boolean; stopping?: boolean };
      if (body.stopping) return 'stopping';
      if (body.booting) return 'booting';
    }
    return 'down';
  } catch {
    return 'down';
  }
}

/**
 * Start the browser daemon if it is not already answering, and wait until it
 * is. Detached with its output on a log file: callers may be speaking a
 * protocol on stdio, so nothing may leak into their stream.
 *
 * A daemon that is booting or shutting down is waited for, never duplicated:
 * two daemons cannot share the browser profile, and the loser would wipe the
 * winner's record on its way out.
 */
export async function ensureDaemon(headless = false, extraArgs: string[] = []): Promise<DaemonInfo> {
  ensureDirs();
  let spawned: ReturnType<typeof spawn> | null = null;
  let exitCode: number | null = null;
  const deadline = Date.now() + 150_000;
  // A record whose process is alive but never answers is a hung daemon or a
  // reused pid after a reboot; wait a little, then take over.
  const aliveGrace = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const info = readDaemon();
    const state = await probe(info);
    if (state === 'ready') return info as DaemonInfo;
    if (state === 'booting' || state === 'stopping') {
      await sleep(1000);
      continue;
    }
    // Down. A record whose process is alive but not answering is a daemon
    // between listen and its first status; give it a moment.
    if (info && alive(info.pid) && !spawned && Date.now() < aliveGrace) {
      await sleep(1000);
      continue;
    }
    if (!spawned) {
      const log = openSync(DAEMON_LOG, 'a', 0o600);
      spawned = spawn(process.execPath, daemonSpawnArgs(headless, extraArgs), {
        detached: true,
        stdio: ['ignore', log, log],
      });
      spawned.on('exit', (code) => {
        exitCode = code ?? 1;
      });
      spawned.unref();
      closeSync(log);
    } else if (exitCode !== null && exitCode !== 0) {
      throw new DaemonError('NO_DAEMON', `daemon exited with code ${exitCode} before becoming ready; see .rig/daemon.log`);
    }
    await sleep(1000);
  }
  throw new DaemonError('NO_DAEMON', 'daemon did not become ready in time; see .rig/daemon.log');
}

export async function callDaemon(
  cmd: string,
  args: Record<string, unknown> = {},
  opts: { autoStart?: boolean } = {},
): Promise<CmdResult> {
  let info = readDaemon();
  if ((await probe(info)) !== 'ready') {
    if (opts.autoStart === false) throw new DaemonError('NO_DAEMON', 'daemon is not running');
    info = await ensureDaemon();
  }
  const live = info as DaemonInfo;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${live.port}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rig-token': live.token },
      body: JSON.stringify({ cmd, args }),
    });
  } catch (err) {
    throw new DaemonError('NO_DAEMON', `daemon on port ${live.port} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json().catch(() => ({ error: 'bad response from daemon', code: 'BAD_RESPONSE' }))) as CmdResult;
  if (!res.ok) {
    throw new DaemonError(
      String(body['code'] ?? 'ERROR'),
      String(body['error'] ?? 'command failed'),
      body['details'] as Record<string, unknown> | undefined,
    );
  }
  return body;
}
