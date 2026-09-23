/** Waiting: for time, for a wallet prompt to appear or go, for page content. */
import { RigError, type Args, type CmdResult } from '../../types.js';
import { bool, num, str } from '../../args.js';
import { pageId, popupPages, setActive } from '../browser.js';
import { ensureNotification, reloadNotification } from '../../metamask/notification.js';
import { readPrompt } from '../../metamask/prompt.js';
import { sleep } from '../../util.js';
import { target } from './nav.js';

type Waiter = (args: Args, started: number, timeout: number) => Promise<CmdResult>;

const waitMs: Waiter = async (args, started) => {
  await sleep(num(args, 'ms', 500));
  return { ok: true, elapsedMs: Date.now() - started };
};

/**
 * The rig opens the approval route itself, then polls until a request shows.
 * The route must be reloaded each poll: a notification page that opened with
 * an empty queue stays blank when a request arrives afterwards.
 */
const waitPopup: Waiter = async (_args, started, timeout) => {
  const deadline = started + timeout;
  let first = true;
  while (Date.now() < deadline) {
    const page = await ensureNotification();
    if (!first) await reloadNotification(page);
    first = false;
    const prompt = await readPrompt(page);
    if (prompt.kind !== 'unknown') {
      setActive(page);
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        popup: { id: pageId(page), url: page.url(), kind: prompt.kind, network: prompt.network, origin: prompt.origin },
      };
    }
    await sleep(700);
  }
  return { ok: false, reason: 'no pending request', elapsedMs: Date.now() - started };
};

const waitPopupGone: Waiter = async (_args, started, timeout) => {
  const page = popupPages().at(-1);
  if (!page) return { ok: true, elapsedMs: 0, note: 'no popup was open' };
  const urlBefore = page.url();
  const deadline = started + timeout;
  while (Date.now() < deadline) {
    if (page.isClosed()) return { ok: true, closed: true, elapsedMs: Date.now() - started };
    if (page.url() !== urlBefore) return { ok: true, closed: false, navigated: page.url(), elapsedMs: Date.now() - started };
    await sleep(150);
  }
  return { ok: false, reason: 'popup still open', elapsedMs: Date.now() - started };
};

const waitContent: Waiter = async (args, started, timeout) => {
  const page = target(args);
  const text = str(args, 'text');
  const url = str(args, 'url');
  const sel = str(args, 'sel');
  try {
    if (text) await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
    else if (sel) await page.locator(sel).first().waitFor({ state: 'visible', timeout });
    else if (url) await page.waitForURL((u) => u.toString().includes(url), { timeout });
    else throw new RigError('BAD_ARGS', 'wait needs --ms, --text, --url, --sel, --popup or --popup-gone');
  } catch (err) {
    if (err instanceof RigError) throw err;
    return { ok: false, reason: 'timeout', elapsedMs: Date.now() - started };
  }
  return { ok: true, elapsedMs: Date.now() - started };
};

export async function cmdWait(args: Args): Promise<CmdResult> {
  const started = Date.now();
  const timeout = num(args, 'timeout', 15_000);
  const waiter: Waiter =
    args['ms'] !== undefined ? waitMs : bool(args, 'popup') ? waitPopup : bool(args, 'popup-gone') ? waitPopupGone : waitContent;
  return waiter(args, started, timeout);
}
