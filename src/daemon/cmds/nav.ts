/** Page navigation commands: pages, use, goto, close, resize. */
import type { Page } from 'playwright';
import { RigError, type Args, type CmdResult } from '../../types.js';
import { num, str } from '../../args.js';
import { closeOrBlank, getRig, listPages, pageId, pageInfo, resolveTarget, setActive, setPinned } from '../browser.js';

export function target(args: Args): Page {
  return resolveTarget(str(args, 'target'));
}

/**
 * URLs the rig will navigate to: the web, and the wallet's own pages. A
 * file:// URL would let a page action read local files back through aria or
 * eval; another extension's pages are not the rig's business.
 */
export function allowedUrl(url: string, extensionId: string | undefined): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return true;
  if (u.protocol === 'chrome-extension:' && extensionId && u.host === extensionId) return true;
  return u.protocol === 'about:' && u.pathname === 'blank';
}

export async function cmdPages(): Promise<CmdResult> {
  return { pages: await listPages() };
}

export async function cmdUse(args: Args): Promise<CmdResult> {
  const t = str(args, 'value') ?? str(args, 'target') ?? 'active';
  setPinned(t);
  return { target: t };
}

/** Same place, allowing for a redirect inside the site. */
export function sameDestination(current: string, wanted: string): boolean {
  if (current === wanted) return true;
  try {
    const a = new URL(current);
    const b = new URL(wanted);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

/**
 * Did the navigation arrive anyway? A slow page can blow the goto timeout and
 * still be there a moment later, and reporting TIMEOUT for a page the caller
 * can see is worse than saying it was slow. Script evaluation is blocked on
 * wallet pages, so there the URL is the only evidence.
 */
async function arrived(page: Page, url: string, graceMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  do {
    if (page.isClosed()) return false;
    if (sameDestination(page.url(), url)) {
      const ready = await page.evaluate(() => document.readyState).catch(() => null);
      // null: an extension page, or a page mid-navigation that refused the
      // evaluate. The URL already says the navigation committed.
      if (ready === null || ready === 'interactive' || ready === 'complete') return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return false;
}

export async function cmdGoto(args: Args): Promise<CmdResult> {
  const url = str(args, 'value') ?? str(args, 'url');
  if (!url) throw new RigError('BAD_ARGS', 'goto needs a url');
  if (!allowedUrl(url, getRig().extensionId)) {
    throw new RigError('BAD_ARGS', `refusing to open ${url}: only http(s) URLs and the wallet's own pages are allowed`);
  }
  let page: Page;
  try {
    page = target(args);
  } catch {
    page = await getRig().context.newPage();
  }
  let slow = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: num(args, 'timeout', 45_000) });
  } catch (err) {
    if (!(await arrived(page, url))) throw RigError.wrap(err);
    slow = true;
  }
  setActive(page);
  return {
    ...(await pageInfo(page)),
    ...(slow
      ? { slow: true, note: 'the navigation outran its timeout but the page is loaded; treat it as open' }
      : {}),
  };
}

export async function cmdClose(args: Args): Promise<CmdResult> {
  const page = target(args);
  const id = pageId(page);
  await closeOrBlank(page);
  return { closed: id };
}

export async function cmdResize(args: Args): Promise<CmdResult> {
  const page = target(args);
  const width = num(args, 'width', 1440);
  const height = num(args, 'height', 900);
  // viewport:null means the OS window is the viewport, so resize the window.
  const cdp = await getRig().context.newCDPSession(page);
  try {
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height, windowState: 'normal' } });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  await page.waitForTimeout(600);
  return { ...(await pageInfo(page)), requested: { width, height } };
}
