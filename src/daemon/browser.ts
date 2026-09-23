import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import {
  RigError,
  type OcrResult,
  type PageInfo,
  type PageKind,
  type Target,
} from '../types.js';
import { PROFILE_DIR, readState, writeState } from './state.js';

export interface RigBrowser {
  context: BrowserContext;
  extensionId: string;
  headless: boolean;
}

let rig: RigBrowser | null = null;

const ids = new WeakMap<Page, number>();
let nextId = 1;
/** Insertion-ordered; newest last. */
const pages: Page[] = [];
let activePage: Page | null = null;
let pinnedTarget: Target = 'active';

/** Last OCR result per page id, for `click --id`. */
const ocrCache = new Map<number, OcrResult>();

/** Rolling console + error buffer per page id, for debugging blank screens. */
const logs = new Map<number, string[]>();
const LOG_LIMIT = 300;

function pushLog(page: Page, line: string): void {
  const id = pageId(page);
  const buf = logs.get(id) ?? [];
  buf.push(line);
  if (buf.length > LOG_LIMIT) buf.shift();
  logs.set(id, buf);
}

export function getLogs(page: Page): string[] {
  return logs.get(pageId(page)) ?? [];
}

export function clearLogs(page: Page): void {
  logs.delete(pageId(page));
}

// ---- single-flight mutex so screenshots never race clicks -------------------
let chain: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  const run = chain.then(fn, fn);
  // Both branches handled: a derived promise that rejects would surface as an
  // unhandled rejection and take the daemon down with it.
  chain = run.then(
    () => {
      inFlight--;
    },
    () => {
      inFlight--;
    },
  );
  return run;
}

export function getRig(): RigBrowser {
  if (!rig) throw new RigError('NO_BROWSER', 'browser is not running');
  return rig;
}

export function pageId(page: Page): number {
  let id = ids.get(page);
  if (id === undefined) {
    id = nextId++;
    ids.set(page, id);
  }
  return id;
}

function track(page: Page): void {
  pageId(page);
  if (!pages.includes(page)) pages.push(page);
  activePage = page;
  page.on('console', (msg) => {
    pushLog(page, `[${msg.type()}] ${msg.text().slice(0, 500)}`);
  });
  page.on('pageerror', (err) => {
    pushLog(page, `[pageerror] ${err.message.slice(0, 800)}`);
  });
  page.on('requestfailed', (req) => {
    pushLog(page, `[requestfailed] ${req.url().slice(0, 200)} ${req.failure()?.errorText ?? ''}`);
  });
  page.on('close', () => {
    const i = pages.indexOf(page);
    if (i >= 0) pages.splice(i, 1);
    ocrCache.delete(pageId(page));
    logs.delete(pageId(page));
    if (activePage === page) activePage = pages.at(-1) ?? null;
  });
}

export function classify(page: Page): PageKind {
  const url = page.url();
  const ext = rig?.extensionId;
  if (ext && url.startsWith(`chrome-extension://${ext}`)) {
    return url.includes('notification.html') ? 'popup' : 'mm';
  }
  // Anything served over http(s) is the site under test. No configured app
  // URL, so the rig works against whatever you point it at.
  if (url.startsWith('http://') || url.startsWith('https://')) return 'app';
  return 'other';
}

/**
 * Close a page, unless it is the last one: closing the last window can end
 * Chromium on some platforms, which the daemon would treat as a crash. The
 * last page is parked on about:blank instead, which shows nothing.
 */
export async function closeOrBlank(page: Page): Promise<void> {
  if (page.isClosed()) return;
  if (livePages().length <= 1) {
    await page.goto('about:blank').catch(() => undefined);
    return;
  }
  await page.close().catch(() => undefined);
}

export function livePages(): Page[] {
  return pages.filter((p) => !p.isClosed());
}

export function popupPages(): Page[] {
  return livePages().filter((p) => classify(p) === 'popup');
}

export function setPinned(target: Target): void {
  pinnedTarget = target;
}

export function resolveTarget(target?: Target): Page {
  const want: Target = target ?? pinnedTarget;
  const live = livePages();
  if (live.length === 0) throw new RigError('NO_TARGET', 'no open pages');

  if (/^\d+$/.test(String(want))) {
    const id = Number(want);
    const p = live.find((x) => pageId(x) === id);
    if (!p) throw new RigError('NO_TARGET', `no open page with id ${id}`);
    return p;
  }
  switch (want) {
    case 'popup': {
      const pops = popupPages();
      const p = pops[pops.length - 1];
      if (!p) throw new RigError('NO_TARGET', 'no MetaMask popup is open');
      return p;
    }
    case 'mm': {
      const p = live.find((x) => classify(x) === 'mm');
      if (!p) throw new RigError('NO_TARGET', 'no MetaMask extension page is open');
      return p;
    }
    case 'app': {
      const p = live.find((x) => classify(x) === 'app');
      if (!p) throw new RigError('NO_TARGET', 'no app page is open');
      return p;
    }
    case 'active':
    default: {
      // Prefer an open popup: after one opens it is almost always the subject.
      const pops = popupPages();
      if (pops.length > 0) return pops[pops.length - 1] as Page;
      return currentPage() ?? (live[live.length - 1] as Page);
    }
  }
}

/** The page the rig last acted on or that last navigated, if still open. */
export function currentPage(): Page | null {
  return activePage && !activePage.isClosed() ? activePage : null;
}

export function setActive(page: Page): void {
  activePage = page;
}

export function cacheOcr(page: Page, result: OcrResult): void {
  ocrCache.set(pageId(page), result);
}

export function getOcr(page: Page): OcrResult | undefined {
  return ocrCache.get(pageId(page));
}

export async function pageInfo(page: Page): Promise<PageInfo> {
  const vp = page.viewportSize();
  let title = '';
  let dpr = 1;
  try {
    title = await page.title();
    dpr = await page.evaluate(() => window.devicePixelRatio);
  } catch {
    /* page may be mid-navigation */
  }
  return {
    id: pageId(page),
    kind: classify(page),
    url: page.url(),
    title,
    viewport: vp ? { w: vp.width, h: vp.height } : null,
    dpr,
    active: page === activePage,
  };
}

export async function listPages(): Promise<PageInfo[]> {
  return Promise.all(livePages().map(pageInfo));
}

export async function launch(opts: { headless: boolean }): Promise<RigBrowser> {
  if (rig) return rig;
  const state = readState();
  const mmDir = state.metamaskDir;
  if (!mmDir || !existsSync(mmDir)) {
    throw new RigError(
      'NO_EXTENSION',
      'MetaMask is not staged. Run: ./bin/rig mm fetch',
    );
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    headless: opts.headless,
    viewport: null,
    args: [
      `--disable-extensions-except=${mmDir}`,
      `--load-extension=${mmDir}`,
      '--window-size=1280,900',
    ],
  });

  // Extension id comes from the MV3 service worker URL.
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => {
      throw new RigError(
        'NO_EXTENSION',
        'extension service worker never appeared; MetaMask failed to load',
      );
    });
  }
  const extensionId = new URL(sw.url()).host;

  rig = { context, extensionId, headless: opts.headless };
  writeState({ extensionId });

  for (const p of context.pages()) track(p);
  context.on('page', (p) => {
    track(p);
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) activePage = p;
    });
  });
  // The browser can die under the daemon: a crash, or the user quitting it.
  // Without this the daemon would answer every command with a Playwright error
  // and still look healthy to its clients.
  context.on('close', () => {
    if (rig && rig.context === context) {
      rig = null;
      pages.length = 0;
      activePage = null;
      closedHandler?.();
    }
  });

  return rig;
}

let closedHandler: (() => void) | null = null;
/** Called when the browser closes on its own, never from `close()`. */
export function onBrowserClosed(handler: () => void): void {
  closedHandler = handler;
}

/** Number of commands currently holding or waiting for the browser mutex. */
let inFlight = 0;
export function busy(): number {
  return inFlight;
}

/** Grace period before teardown, so the wallet can flush pending state. */
const FLUSH_MS = 2500;

export async function close(timeoutMs = 15_000): Promise<void> {
  if (!rig) return;
  const ctx = rig.context;
  rig = null;
  pages.length = 0;
  activePage = null;
  // MV3 extensions write their state asynchronously. Closing straight after an
  // approval loses whatever was just granted: the site permission, the network
  // that was added, or an imported account. Wait for the write to land.
  await new Promise((r) => setTimeout(r, FLUSH_MS));
  // A browser that will not close must not hold the daemon (and its record)
  // in `stopping` forever.
  await Promise.race([
    ctx.close().catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Ensure a page exists for a URL, reusing one already open on it. */
export async function ensurePage(url: string, kind: PageKind): Promise<Page> {
  const existing = livePages().find((p) => classify(p) === kind);
  if (existing) return existing;
  const { context } = getRig();
  const page = await context.newPage();
  track(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return page;
}
