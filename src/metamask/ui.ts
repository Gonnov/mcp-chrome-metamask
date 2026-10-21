/** Navigating the wallet's own home page without disturbing the site under test. */
import type { Page } from 'playwright';
import { classify, closeOrBlank, currentPage, livePages } from '../daemon/browser.js';
import { ensureUnlocked } from './unlock.js';

/** chrome-extension://<id>/home.html#<route> for whatever extension this page is. */
export function homeUrl(page: Page, route = '/'): string {
  // URL.origin is "null" for chrome-extension:, so rebuild it from the parts.
  const u = new URL(page.url());
  return `${u.protocol}//${u.host}/home.html#${route}`;
}

/**
 * Navigate a wallet page to a home route. `settleMs` is a fixed pause after
 * the load; callers that wait for their own element pass 0.
 */
export async function gotoHome(page: Page, route = '/', settleMs = 0): Promise<boolean> {
  const ok = await page
    .goto(homeUrl(page, route), { waitUntil: 'domcontentloaded' })
    .then(() => true)
    .catch(() => false);
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  return ok;
}

/**
 * Do something on the wallet's home page and put the browser back as it was.
 * Opening a tab brings it to the front, so the page the user was on is
 * remembered and refocused; a wallet page this call opened is closed again
 * afterwards, since an open extension page suppresses MetaMask's approval
 * prompts. With `keep`, or when the page was already open, it is left alone.
 */
export async function withHome<T>(
  getHome: () => Promise<Page>,
  fn: (home: Page) => Promise<T>,
  opts: { keep?: boolean; unlock?: boolean } = {},
): Promise<T> {
  const focus = currentPage();
  const refocus = focus && !focus.isClosed() && classify(focus) === 'app' ? focus : null;
  const before = new Set(livePages());
  const home = await getHome();
  const opened = !before.has(home);
  // A read-only look (is it locked?) must not change what it looks at.
  if (opts.unlock !== false) await ensureUnlocked(home);
  try {
    return await fn(home);
  } finally {
    if (!opts.keep && opened) await closeOrBlank(home);
    if (refocus && !refocus.isClosed()) await refocus.bringToFront().catch(() => undefined);
  }
}
