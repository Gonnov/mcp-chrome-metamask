/**
 * MetaMask 13.48 under Playwright does not raise a usable approval window: it
 * either suppresses it (when any extension page is open) or opens home.html,
 * which renders the wallet instead of the request. The pending queue is always
 * reachable at notification.html, so the rig opens that route itself.
 */
import type { Page } from 'playwright';
import type { PopupInfo } from '../types.js';
import { classify, closeOrBlank, getRig, livePages, pageId, popupPages } from '../daemon/browser.js';
import { detectKind } from './prompt.js';

/** Time for the notification route to render the head of the queue. */
export const ROUTE_SETTLE_MS = 900;

export function notificationUrl(): string {
  return `chrome-extension://${getRig().extensionId}/notification.html`;
}

export async function ensureNotification(): Promise<Page> {
  const existing = popupPages().at(-1);
  if (existing && !existing.isClosed()) return existing;

  // Reuse a window MetaMask opened for itself, so no stray tab is left behind.
  const strays = livePages().filter((p) => classify(p) === 'mm');
  const page = strays.at(-1) ?? (await getRig().context.newPage());
  await reloadNotification(page);
  return page;
}

/** Reload the route: a page that opened on an empty queue stays blank when one arrives. */
export async function reloadNotification(page: Page): Promise<boolean> {
  const ok = await page
    .goto(notificationUrl(), { waitUntil: 'domcontentloaded' })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(ROUTE_SETTLE_MS);
  return ok;
}

/** True when the notification route is showing a request to act on. */
export async function hasPending(page: Page): Promise<boolean> {
  return (await detectKind(page)) !== 'unknown';
}

export async function closeNotification(): Promise<number> {
  let closed = 0;
  for (const page of popupPages()) {
    await closeOrBlank(page);
    closed++;
  }
  return closed;
}

export async function popupInfo(page: Page): Promise<PopupInfo> {
  return { id: pageId(page), url: page.url(), kind: await detectKind(page) };
}

export async function listPopups(): Promise<PopupInfo[]> {
  return Promise.all(popupPages().map(popupInfo));
}
