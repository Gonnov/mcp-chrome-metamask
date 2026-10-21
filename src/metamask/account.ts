/**
 * Reading the wallet's own account from its home page. Needed when no site is
 * open to ask `eth_accounts`: right after setup, before anything is funded.
 */
import type { Page } from 'playwright';
import { readState, writeState } from '../daemon/state.js';
import { dismissNags } from './onboard.js';
import { ACCOUNT } from './selectors.js';
import { clickIfShown } from './dom.js';
import { gotoHome, withHome } from './ui.js';
import { walletFacts } from './background.js';

export interface AddressRead {
  address?: string;
  addressShort?: string;
  source: 'wallet' | 'qr' | 'text' | 'known' | 'short' | 'none';
  note?: string;
}

/** EIP-55 form of an address. viem is loaded on first use only: the daemon rarely needs it. */
export async function checksum(address: string): Promise<string> {
  const { getAddress } = await import('viem');
  return getAddress(address);
}

const FULL = /^0x[0-9a-fA-F]{40}$/;
const FULL_ANYWHERE = /0x[0-9a-fA-F]{40}/;

/** Any full address rendered on the page, whatever element holds it. */
async function scanForAddress(home: Page): Promise<string | null> {
  const text = await home.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return FULL_ANYWHERE.exec(text.replace(/\s+/g, ''))?.[0] ?? null;
}

/**
 * Resolve a truncated header address ("0x1234...cdef") against the full
 * addresses the rig already knows. The wallet shows the short form on every
 * screen, so a known account does not need the site under test to be
 * connected before `mm address` can answer in full.
 */
export function matchKnown(short: string, known: (string | undefined)[]): string | null {
  const parts = short.replace(/\s+/g, '').split(/\.{3}|…/);
  const head = (parts[0] ?? '').toLowerCase();
  const tail = (parts[1] ?? '').toLowerCase();
  if (!head.startsWith('0x') || head.length < 4) return null;
  for (const candidate of known) {
    if (!candidate || !FULL.test(candidate)) continue;
    const lower = candidate.toLowerCase();
    if (lower.startsWith(head) && (tail === '' || lower.endsWith(tail))) return candidate;
  }
  return null;
}

/**
 * The full checksum address renders in the address QR modal. When that modal
 * cannot be reached, the ladder is: any full address on the page that agrees
 * with the truncated header, then a known account the header matches, then the
 * truncated text itself, clearly labelled. Nothing is guessed: a candidate
 * that disagrees with the header is dropped.
 */
export async function readAddress(getHome: () => Promise<Page>, opts: { keep?: boolean } = {}): Promise<AddressRead> {
  // The wallet's own state names the selected account in full, without a tab.
  const facts = await walletFacts();
  if (facts?.selected) {
    const address = await checksum(facts.selected);
    if (readState().walletAddress !== address) writeState({ walletAddress: address });
    return { address, source: 'wallet' };
  }
  return withHome(getHome, async (home) => {
    // No fixed settle: the header read below waits for the page to render it.
    await gotoHome(home, '/', 0);

    // Read the header first: it is always there, and it is what every other
    // candidate has to agree with.
    const short = (await home.locator(ACCOUNT.addressContainer).first().innerText({ timeout: 3000 }).catch(() => ''))
      .trim();

    // A header that matches an account the rig imported is already a full
    // answer; the QR modal below costs seconds of clicking for the same string.
    if (short) {
      const state = readState();
      const known = matchKnown(short, [state.importedAddress, state.walletAddress, ...(state.importedAddresses ?? [])]);
      if (known) return { address: known, addressShort: short, source: 'known' };
    }
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

    // The QR modal is the designed route, but a MetaMask that renders the
    // address anywhere else on the page is just as good a source, as long as
    // it is the selected account and not some token's contract.
    const onPage = await scanForAddress(home);
    if (onPage && (!short || matchKnown(short, [onPage]))) {
      writeState({ walletAddress: onPage });
      return { address: onPage, source: 'text', ...(short ? { addressShort: short } : {}) };
    }

    if (short) {
      const state = readState();
      const known = matchKnown(short, [state.importedAddress, state.walletAddress, ...(state.importedAddresses ?? [])]);
      if (known) return { address: known, addressShort: short, source: 'known' };
      return {
        addressShort: short,
        source: 'short',
        note: 'only the truncated address could be read from the wallet; open the site under test and use eth_accounts, or the QR modal, for the full one',
      };
    }
    return { source: 'none', note: 'could not read an address from the wallet home page' };
  }, opts);
}
