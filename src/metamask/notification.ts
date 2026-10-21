/**
 * MetaMask 13.48 under Playwright does not raise a usable approval window: it
 * either suppresses it (when any extension page is open) or opens home.html,
 * which renders the wallet instead of the request. The pending queue is always
 * reachable at notification.html, so the rig opens that route itself.
 */
import type { Page } from 'playwright';
import type { PopupInfo } from '../types.js';
import { classify, closeOrBlank, getRig, livePages, pageId, popupPages } from '../daemon/browser.js';
import type { PromptInfo } from '../types.js';
import { detectKind, readPrompt } from './prompt.js';
import { KIND_MARKERS } from './selectors.js';
import { whichShown } from './dom.js';
import { uiFacts, waitUiFacts } from './uistate.js';
import { sleep } from '../util.js';

/** How often an open, empty route is asked whether a request has arrived. */
const POLL_MS = 100;
/** An empty route is reloaded this often anyway, in case its state stopped updating. */
const RELOAD_EVERY_MS = 3000;

/**
 * Longest the route may take to start the wallet UI and draw the head of the
 * queue. It is a ceiling, not a sleep: the wait ends as soon as the page
 * reports an empty queue or draws a request.
 */
export const ROUTE_READY_MS = 5000;

/** Every marker a drawn request (or the lock screen) shows. */
const REQUEST_MARKERS = KIND_MARKERS.map((m) => m.sel);

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

/**
 * Reload the route: a page that opened on an empty queue stays blank when one
 * arrives. Returns once the page is ready to read: the UI reports an empty
 * queue, or it has drawn a request or the lock screen.
 */
export async function reloadNotification(page: Page): Promise<boolean> {
  const ok = await page
    .goto(notificationUrl(), { waitUntil: 'domcontentloaded' })
    .then(() => true)
    .catch(() => false);
  await settleRoute(page);
  return ok;
}

/** Wait until the route has said what it holds, as above. */
export async function settleRoute(page: Page, timeoutMs = ROUTE_READY_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const facts = await waitUiFacts(page, timeoutMs);
  if (!facts) return;
  // Locked or queued: the page draws a marker; an empty queue draws none.
  if (!facts.unlocked || facts.pending > 0) await whichShown(page, REQUEST_MARKERS, Math.max(0, deadline - Date.now()));
}

/**
 * Wait for the wallet to show a request. The open route reports its queue
 * live, so an empty queue costs one cheap state read per poll, not a reload;
 * the route is reloaded when a request is queued but not drawn (a page opened
 * on an empty queue stays blank) and every few seconds as a safety net.
 * `stop` is checked each poll and ends the wait early when it says so.
 */
export async function awaitRequest(
  timeoutMs: number,
  stop?: () => Promise<boolean>,
): Promise<{ page: Page; prompt: PromptInfo } | null> {
  const deadline = Date.now() + timeoutMs;
  let page = await ensureNotification();
  let reloadedAt = Date.now();
  for (;;) {
    const facts = await uiFacts(page);
    if (!facts || !facts.unlocked || facts.pending > 0) {
      const prompt = await readPrompt(page, 300);
      if (prompt.kind !== 'unknown') return { page, prompt };
    }
    if (Date.now() >= deadline) return null;
    if (stop && (await stop())) return null;
    const stale = facts !== null && facts.pending > 0;
    if (page.isClosed() || stale || Date.now() - reloadedAt >= RELOAD_EVERY_MS) {
      page = await ensureNotification();
      if (!page.isClosed() && (stale || Date.now() - reloadedAt >= RELOAD_EVERY_MS)) await reloadNotification(page);
      reloadedAt = Date.now();
      continue;
    }
    await sleep(POLL_MS);
  }
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
