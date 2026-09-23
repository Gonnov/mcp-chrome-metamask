/** Daemon-level commands: boot, status, stop, and the wallet home page they share. */
import type { Page } from 'playwright';
import type { CmdResult } from '../../types.js';
import * as chain from '../../chain.js';
import { busy, classify, closeOrBlank, ensurePage, getRig, listPages, livePages } from '../browser.js';
import { env, readState, writeState } from '../state.js';
import { getPort } from '../server.js';
import { config } from '../../config.js';
import { listPopups } from '../../metamask/notification.js';
import { ensureUnlocked } from '../../metamask/unlock.js';
import { dismissNags } from '../../metamask/onboard.js';
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
 */
export async function boot(): Promise<CmdResult> {
  const state = readState();

  // MetaMask opens its own tab a beat after launch; reuse it instead of racing.
  for (let i = 0; i < 20; i++) {
    if (livePages().some((p) => classify(p) === 'mm')) break;
    await sleep(300);
  }
  const page = await mmHomePage();
  await page.waitForTimeout(1200);

  const locked = await shown(page, UNLOCK.password, 2500);
  if (locked) await ensureUnlocked(page);

  const onHome = await shown(page, HOME.accountMenu, 4000);
  if (onHome) {
    await dismissNags(page);
    if (!state.onboarded) writeState({ onboarded: true });
  }

  // Closing extension pages is what keeps MetaMask's approvals working, but
  // before the wallet exists the only extension page is its own onboarding tab.
  const onboarded = onHome || (state.onboarded ?? false);
  const closed = onboarded ? await closeExtensionPages() : 0;
  return { booted: true, wasLocked: locked, onHome, closed, onboarded };
}

/**
 * Cheap and never blocked: this is the liveness probe, so it must not queue
 * behind a long command. It reports `busy` instead. The staged MetaMask path is
 * deliberately left out; it names the project root.
 */
export async function status(): Promise<CmdResult> {
  const state = readState();
  const out: CmdResult = {
    daemon: { pid: process.pid, port: getPort(), uptimeSec: Math.round(process.uptime()), busy: busy() },
    extensionId: state.extensionId,
    metamask: { version: state.metamaskVersion, source: state.metamaskSource },
    onboarded: state.onboarded ?? false,
    importedAddress: state.importedAddress,
    walletAddress: state.importedAddress ?? state.walletAddress,
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
