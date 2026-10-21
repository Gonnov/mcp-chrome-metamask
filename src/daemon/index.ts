import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { RigError } from '../types.js';
import { busy, launch, onBrowserClosed } from './browser.js';
import { config, idleExpired, idleLimitMinutes, parseLaunchArgs, setLaunchArgs } from '../config.js';
import { boot } from './dispatch.js';
import { idleMs, markReady, startServer, touch } from './server.js';
import { shutdown } from './lifecycle.js';
import { alive } from '../util.js';
import {
  DAEMON_FILE,
  clearDaemon,
  ensureDirs,
  env,
  readDaemon,
  readState,
  walletPassword,
  writeDaemon,
} from './state.js';
import { DEFAULT_MM_VERSION, assertVersion, fetchAuto } from '../metamask/fetch.js';
import { probe } from '../launcher.js';

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new RigError('BAD_ARGS', `RIG_PORT must be a port number, got "${raw}"`);
  }
  return n;
}

let record: { port: number; token: string; headless: boolean; startedAt: number } | null = null;

function saveRecord(flags: { booting?: boolean; stopping?: boolean } = {}): void {
  if (!record) return;
  // Never overwrite a record that a newer daemon owns.
  const current = readDaemon();
  if (current && current.pid !== process.pid && alive(current.pid) && !flags.booting) return;
  writeDaemon({ pid: process.pid, ...record, ...flags });
}

/** Leave nothing behind that names this process: a stale record sends clients to a dead port. */
function releaseRecord(): void {
  clearDaemon(process.pid);
}

/**
 * A forgotten daemon is a whole Chromium (often gigabytes) sitting in RAM for
 * nothing, and headless it is invisible. Nobody reliably runs `stop` at the end
 * of a test run, so the daemon times itself out; the next call relaunches it.
 */
function startIdleWatchdog(): void {
  const limit = idleLimitMinutes();
  if (limit <= 0) return;
  touch();
  const timer = setInterval(() => {
    const idle = idleMs();
    if (!idleExpired(idle, limit, busy())) return;
    clearInterval(timer);
    console.log(JSON.stringify({ idleExit: true, pid: process.pid, idleSec: Math.round(idle / 1000), limitMinutes: limit }));
    shutdown(0);
  }, 30_000);
  // The watchdog must never be what keeps the process alive.
  timer.unref();
}

async function main(): Promise<void> {
  ensureDirs();
  setLaunchArgs(parseLaunchArgs(process.argv.slice(2)));
  const headless = process.argv.includes('--headless') || config().headless === true;
  // A stable port keeps client configuration simple. If it is taken, the
  // server falls back to any free port; either way the choice lands in
  // .rig/daemon.json.
  const wantPort = parsePort(env('RIG_PORT', '7331'));

  const existing = readDaemon();
  if (existing && alive(existing.pid)) {
    const state = await probe(existing);
    if (state !== 'down') {
      // Never echo the token: this line lands in daemon.log.
      console.log(JSON.stringify({ alreadyRunning: true, pid: existing.pid, port: existing.port, state }));
      return;
    }
  }

  // Listen first and claim the record at once, flagged as booting. From here a
  // second launcher waits for this process instead of starting its own; the
  // browser profile can only be held by one.
  const token = randomBytes(16).toString('hex');
  const port = await startServer(wantPort, token);
  if (port !== wantPort) {
    // The preferred port was taken. If that is another daemon of this
    // checkout that claimed the record a moment ago, it wins.
    const rival = readDaemon();
    if (rival && rival.pid !== process.pid && alive(rival.pid)) {
      console.log(JSON.stringify({ alreadyRunning: true, pid: rival.pid, port: rival.port, state: 'claimed' }));
      return;
    }
  }
  record = { port, token, headless, startedAt: Date.now() };
  saveRecord({ booting: true });

  // The recorded path is absolute, so moving or renaming the project breaks it.
  // Re-stage rather than failing with a path the user never typed. This can
  // take minutes; the record above keeps a second launcher waiting meanwhile.
  const staged = readState().metamaskDir;
  if (!staged || !existsSync(staged)) {
    const version = env('RIG_MM_VERSION', DEFAULT_MM_VERSION);
    assertVersion(version);
    await fetchAuto(version);
  }

  const bail = (why: string, code: number): void => {
    console.error(JSON.stringify({ error: why, code: 'FATAL' }));
    releaseRecord();
    process.exit(code);
  };
  process.on('uncaughtException', (err: Error) => bail(`uncaught exception: ${err.message}`, 1));
  process.on('unhandledRejection', (err: unknown) => bail(`unhandled rejection: ${String(err)}`, 1));
  onBrowserClosed(() => bail('browser closed from outside the rig', 2));

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // Make sure the unlock password has its mirror file before anything can
  // rewrite state.json; losing it would lock the vault for good.
  walletPassword();

  const launchedAt = Date.now();
  const { extensionId } = await launch({ headless });
  const launchMs = Date.now() - launchedAt;
  // Boot BEFORE announcing readiness. It closes extension pages, so a client
  // that connects mid-boot can have the page it is using shut underneath it.
  const booted = await boot().catch((e: Error) => ({ booted: false, error: e.message }));
  markReady();
  saveRecord();
  startIdleWatchdog();

  console.log(
    JSON.stringify({
      started: true,
      port,
      pid: process.pid,
      extensionId,
      headless,
      launchMs,
      booted,
      idleMinutes: idleLimitMinutes(),
      daemonFile: DAEMON_FILE,
    }),
  );
}

main().catch((err: Error) => {
  const code = err instanceof RigError ? err.code : 'FATAL';
  console.error(JSON.stringify({ error: err.message, code }));
  releaseRecord();
  process.exit(1);
});
