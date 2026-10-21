/** Daemon-level commands: boot, status, stop, and the wallet home page they share. */
import type { Page } from 'playwright';
import type { CmdResult } from '../../types.js';
import * as chain from '../../chain.js';
import { busy, classify, closeOrBlank, ensurePage, getRig, listPages, livePages } from '../browser.js';

function rigLowMemory(): boolean | null {
  try {
    return getRig().lowMemory;
  } catch {
    return null;
  }
}
import { env, readDaemon, readState, writeState } from '../state.js';
import { getPort, idleMs } from '../server.js';
import { config, idleLimitMinutes } from '../../config.js';
import { listPopups } from '../../metamask/notification.js';
import { ensureUnlocked } from '../../metamask/unlock.js';
import { waitUiFacts } from '../../metamask/uistate.js';
import { shown } from '../../metamask/dom.js';
import { HOME, UNLOCK } from '../../metamask/selectors.js';
import { beginShutdown, finishShutdown } from '../lifecycle.js';
import { sleep } from '../../util.js';

export async function mmHomePage(): Promise<Page> {
  const { extensionId } = getRig();
  return ensurePage(`chrome-extension://${extensionId}/home.html`, 'mm');
}

/** Any open extension page suppresses MetaMask's approval flow; clear them. */
export async function closeExtensionPages(): Promise<number> {
  let n = 0;
  for (const page of livePages()) {
    const kind = classify(page);
    if (kind === 'mm' || kind === 'popup') {
      await closeOrBlank(page);
      n++;
    }
  }
  return n;
}

/**
 * Bring a freshly launched browser to a known state: unlocked, no nags, and no
 * extension page left open (an open one suppresses MetaMask's approvals).
 * Every step waits for the wallet to say it is done rather than for a fixed
 * time; `ms` reports where the time went.
 */
export async function boot(): Promise<CmdResult> {
  const t0 = Date.now();
  const ms: Record<string, number> = {};
  const lap = (k: string): void => {
    ms[k] = Date.now() - t0;
  };
  const state = readState();

  // MetaMask opens its own tab a beat after launch; reuse it instead of racing.
  for (let deadline = Date.now() + 6000; Date.now() < deadline; await sleep(100)) {
    if (livePages().some((p) => classify(p) === 'mm')) break;
  }
  const page = await mmHomePage();
  lap('tab');

  // The page's own state says when the UI is up and whether it is locked.
  const facts = await waitUiFacts(page, 20_000);
  lap('ui');
  const locked = facts ? facts.onboarded && !facts.unlocked : await shown(page, UNLOCK.password, 2500);
  if (locked) await ensureUnlocked(page);
  lap('unlock');

  const onHome = await shown(page, HOME.accountMenu, facts?.onboarded === false ? 1000 : 8000);
  lap('home');
  // Nags are not dismissed here: the tab closes below, and the commands that
  // click on home (import, the address fallback) clear them themselves.
  if (onHome && !state.onboarded) writeState({ onboarded: true });

  // Closing extension pages is what keeps MetaMask's approvals working, but
  // before the wallet exists the only extension page is its own onboarding tab.
  const onboarded = onHome || (state.onboarded ?? false);
  const closed = onboarded ? await closeExtensionPages() : 0;
  lap('closed');
  return { booted: true, wasLocked: locked, onHome, closed, onboarded, ms };
}

/**
 * Cheap and never blocked: this is the liveness probe, so it must not queue
 * behind a long command. It reports `busy` instead. The staged MetaMask path is
 * deliberately left out; it names the project root.
 */
export async function status(): Promise<CmdResult> {
  const state = readState();
  const record = readDaemon();
  const port = record?.port ?? getPort();
  const headless = record?.headless ?? false;
  const out: CmdResult = {
    port,
    headless,
    daemon: {
      pid: process.pid,
      port,
      headless,
      uptimeSec: Math.round(process.uptime()),
      busy: busy(),
      // How long since the last command, and when the daemon will give up and exit.
      idleSec: Math.round(idleMs() / 1000),
      idleLimitMinutes: idleLimitMinutes(),
      // Low-end device mode: on when this browser started beside another rig browser.
      lowMemory: rigLowMemory(),
    },
    extensionId: state.extensionId,
    metamask: { version: state.metamaskVersion, source: state.metamaskSource },
    onboarded: state.onboarded ?? false,
    importedAddress: state.importedAddress,
    // The selected account as last read from the wallet; the last import is only a fallback.
    walletAddress: state.walletAddress ?? state.importedAddress,
  };
  try {
    out['pages'] = await listPages();
    out['popups'] = await listPopups();
  } catch (err) {
    out['browser'] = `unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
  const rpc = env('RIG_RPC_URL', '') || config().network?.rpcUrl || (readState().networks ?? []).at(-1)?.rpc;
  if (rpc) {
    out['chain'] = await chain.chainInfo(rpc, 3000).catch((err: Error) => ({ error: err.message }));
  }
  return out;
}

/** Flag stopping now; answer; then close and exit once the response has left. */
export function stop(): CmdResult {
  beginShutdown();
  setTimeout(() => finishShutdown(0), 50);
  return { stopping: true };
}
