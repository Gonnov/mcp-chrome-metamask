/**
 * Reading the wallet's own account from its home page. Needed when no site is
 * open to ask `eth_accounts`: right after setup, before anything is funded.
 */
import type { Page } from 'playwright';
import { writeState } from '../daemon/state.js';
import { dismissNags } from './onboard.js';
import { ACCOUNT } from './selectors.js';
import { clickIfShown } from './dom.js';
import { gotoHome, withHome } from './ui.js';

export interface AddressRead {
  address?: string;
  addressShort?: string;
  source: 'qr' | 'short' | 'none';
  note?: string;
}

const FULL = /^0x[0-9a-fA-F]{40}$/;

/**
 * The full checksum address only renders in the address QR modal. Fall back to
 * the truncated header text, clearly labelled, rather than guessing.
 */
export async function readAddress(getHome: () => Promise<Page>, opts: { keep?: boolean } = {}): Promise<AddressRead> {
  return withHome(getHome, async (home) => {
    await gotoHome(home, '/', 800);
    await dismissNags(home);

    if (await clickIfShown(home, ACCOUNT.addressMenuButton, 2500)) {
      await home.waitForTimeout(600);
      const rows = home.locator(ACCOUNT.qrRowButton);
      const n = Math.min(await rows.count().catch(() => 0), 4);
      for (let i = 0; i < n; i++) {
        await rows.nth(i).click({ timeout: 5000 }).catch(() => undefined);
        await home.waitForTimeout(500);
        const raw = await home.locator(ACCOUNT.qrAddress).first().innerText({ timeout: 2500 }).catch(() => '');
        const text = raw.replace(/\s+/g, '');
        // Leave the modal; the back button returns to the row list.
        if (!(await clickIfShown(home, ACCOUNT.qrBack, 800))) await home.keyboard.press('Escape').catch(() => undefined);
        await home.waitForTimeout(300);
        if (FULL.test(text)) {
          writeState({ walletAddress: text });
          return { address: text, source: 'qr' };
        }
      }
      await home.keyboard.press('Escape').catch(() => undefined);
    }

    const short = (await home.locator(ACCOUNT.addressContainer).first().innerText({ timeout: 1500 }).catch(() => ''))
      .trim();
    if (short) {
      return {
        addressShort: short,
        source: 'short',
        note: 'only the truncated address could be read from the wallet; open the site under test and use eth_accounts, or the QR modal, for the full one',
      };
    }
    return { source: 'none', note: 'could not read an address from the wallet home page' };
  }, opts);
}
