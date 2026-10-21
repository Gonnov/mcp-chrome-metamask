import type { Page } from 'playwright';
import { classify, livePages, pageId } from '../daemon/browser.js';
import { walletPassword } from '../daemon/state.js';
import { RigError } from '../types.js';
import { UNLOCK } from './selectors.js';
import { fillOrThrow, clickOrThrow, gone, shown } from './dom.js';
import { waitUiFacts } from './uistate.js';

/** Vault decryption on a cold profile can take seconds; the form leaves once it is done. */
const UNLOCK_DEADLINE_MS = 8000;
/** How long a freshly opened wallet page may take to start its UI and report its state. */
const UI_START_MS = 5000;

/**
 * The lock state the rig last saw on any wallet page, so a status read does
 * not have to open one. MetaMask locks only on a browser restart or after its
 * auto-lock timer, which the rig reads from the wallet's settings.
 */
let lastSeen: { unlocked: boolean; at: number } | null = null;

export function noteLockState(unlocked: boolean): void {
  lastSeen = { unlocked, at: Date.now() };
}

export function lastLockState(): { unlocked: boolean; at: number } | null {
  return lastSeen;
}

/**
 * Any MetaMask surface can show the unlock form; clear it before acting.
 * The page's own state says whether it is locked, so an unlocked wallet costs
 * no probe timeout; a page with no readable state falls back to looking for
 * the form.
 */
export async function ensureUnlocked(page: Page): Promise<boolean> {
  const facts = await waitUiFacts(page, UI_START_MS);
  // Before onboarding there is no vault: nothing to unlock, whatever the flag says.
  if (facts && !facts.onboarded) return false;
  const locked = facts ? !facts.unlocked : await shown(page, UNLOCK.password);
  if (!locked) {
    if (facts) noteLockState(true);
    return false;
  }
  noteLockState(false);
  if (!(await shown(page, UNLOCK.password, UI_START_MS))) {
    throw new RigError('NO_ACTION', 'the wallet reports itself locked but shows no unlock form');
  }
  await fillOrThrow(page.locator(UNLOCK.password), walletPassword(), 'NO_ACTION', 'the unlock password field');
  await clickOrThrow(page.locator(UNLOCK.submit), 'NO_ACTION', 'Unlock');
  if (!(await gone(page, UNLOCK.password, UNLOCK_DEADLINE_MS))) {
    throw new RigError('NO_ACTION', 'the wallet did not accept the stored password');
  }
  noteLockState(true);
  return true;
}

/** Unlock wherever MetaMask is showing the form: popup first, then home. */
export async function unlockAnywhere(): Promise<{ unlocked: boolean; where?: number }> {
  const candidates = livePages().filter((p) => classify(p) === 'popup' || classify(p) === 'mm');
  for (const page of candidates) {
    if (await ensureUnlocked(page)) return { unlocked: true, where: pageId(page) };
  }
  return { unlocked: false };
}
