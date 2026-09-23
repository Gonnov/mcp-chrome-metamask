import type { Page } from 'playwright';
import { classify, livePages, pageId } from '../daemon/browser.js';
import { walletPassword } from '../daemon/state.js';
import { RigError } from '../types.js';
import { UNLOCK } from './selectors.js';
import { fillOrThrow, clickOrThrow, gone, shown } from './dom.js';

/** MetaMask re-renders after Unlock once the vault is decrypted; a cold profile can take seconds. */
const UNLOCK_SETTLE_MS = 1200;
const UNLOCK_DEADLINE_MS = 8000;

/** Any MetaMask surface can show the unlock form; clear it before acting. */
export async function ensureUnlocked(page: Page): Promise<boolean> {
  if (!(await shown(page, UNLOCK.password))) return false;
  await fillOrThrow(page.locator(UNLOCK.password), walletPassword(), 'NO_ACTION', 'the unlock password field');
  await clickOrThrow(page.locator(UNLOCK.submit), 'NO_ACTION', 'Unlock');
  await page.waitForTimeout(UNLOCK_SETTLE_MS);
  if (!(await gone(page, UNLOCK.password, UNLOCK_DEADLINE_MS))) {
    throw new RigError('NO_ACTION', 'the wallet did not accept the stored password');
  }
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
