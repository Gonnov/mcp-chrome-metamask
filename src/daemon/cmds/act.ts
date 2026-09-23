/** Interacting with a page: click (five strategies), type, press, scroll. */
import type { Locator, Page } from 'playwright';
import { RigError, type Args, type CmdResult, type OcrBox } from '../../types.js';
import { num, str } from '../../args.js';
import { ocrPage, similarity } from '../../ocr.js';
import { cacheOcr, getOcr, pageId, popupPages, setActive } from '../browser.js';
import { guardPopupAction } from '../gate.js';
import { sleep } from '../../util.js';
import { target } from './nav.js';
import { roleArg } from './look.js';

interface Point {
  x: number;
  y: number;
}

interface Clicked {
  method: 'xy' | 'dom' | 'ocr';
  matched: string;
  point: Point | null;
}

async function centre(loc: Locator): Promise<Point | null> {
  const box = await loc.boundingBox().catch(() => null);
  return box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null;
}

async function clickLocator(loc: Locator, matched: string): Promise<Clicked> {
  const point = await centre(loc);
  try {
    await loc.click({ timeout: 10_000 });
  } catch (err) {
    throw RigError.wrap(err);
  }
  return { method: 'dom', matched, point };
}

function parseXy(xy: string): Point {
  const [xs, ys] = xy.split(',');
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RigError('BAD_ARGS', 'click --xy expects X,Y');
  return { x, y };
}

async function clickByOcrId(page: Page, id: string): Promise<Clicked> {
  const ocr = getOcr(page);
  if (!ocr) throw new RigError('STALE_OCR', 'no OCR result for this page; run ocr first');
  if (Date.now() - ocr.ts > 30_000) throw new RigError('STALE_OCR', 'OCR result is older than 30s; run ocr again');
  const pool: OcrBox[] = [...ocr.words, ...ocr.lines];
  const hit = pool.find((b) => b.id === id);
  if (!hit) throw new RigError('NO_MATCH', `no OCR box with id ${id}`);
  await page.mouse.click(hit.cx, hit.cy);
  return { method: 'ocr', matched: hit.text, point: { x: hit.cx, y: hit.cy } };
}

/** DOM first (exact and instant when the app owns the markup), then OCR for markup we do not control. */
async function clickByTextOrOcr(page: Page, text: string, nth: number, fuzzy: number): Promise<Clicked> {
  for (const loc of [page.getByRole('button', { name: text, exact: false }), page.getByText(text, { exact: false })]) {
    const count = await loc.count().catch(() => 0);
    if (count <= nth) continue;
    const item = loc.nth(nth);
    if (await item.isVisible().catch(() => false)) return clickLocator(item, text);
  }
  let ocr = getOcr(page);
  if (!ocr || Date.now() - ocr.ts > 30_000) {
    ocr = await ocrPage(page, String(pageId(page)));
    cacheOcr(page, ocr);
  }
  const scored = [...ocr.lines, ...ocr.words]
    .map((b) => ({ b, s: similarity(b.text, text) }))
    .filter((x) => x.s >= fuzzy)
    .sort((a, b) => b.s - a.s);
  const pick = scored[nth];
  if (!pick) throw new RigError('NO_MATCH', `"${text}" not found in DOM or OCR (best ${scored[0]?.s ?? 0})`);
  await page.mouse.click(pick.b.cx, pick.b.cy);
  return { method: 'ocr', matched: `${pick.b.text} (${pick.s.toFixed(2)})`, point: { x: pick.b.cx, y: pick.b.cy } };
}

async function withPopupWatch<T>(fn: () => Promise<T>): Promise<{ value: T; popupOpened: boolean }> {
  const before = popupPages().length;
  const value = await fn();
  for (let i = 0; i < 15; i++) {
    if (popupPages().length > before) return { value, popupOpened: true };
    await sleep(100);
  }
  return { value, popupOpened: popupPages().length > before };
}

export async function cmdClick(args: Args): Promise<CmdResult> {
  const page = target(args);
  const xy = str(args, 'xy');
  const sel = str(args, 'sel');
  const role = roleArg(args);
  const name = str(args, 'name');
  const id = str(args, 'id');
  const text = str(args, 'text') ?? str(args, 'value');
  const nth = num(args, 'nth', 0);

  const strategy = async (): Promise<Clicked> => {
    if (xy) {
      const point = parseXy(xy);
      await page.mouse.click(point.x, point.y);
      return { method: 'xy', matched: '', point };
    }
    if (sel) return clickLocator(page.locator(sel).nth(nth), sel);
    if (role && name) return clickLocator(page.getByRole(role, { name }).nth(nth), `${role}:${name}`);
    if (id) return clickByOcrId(page, id);
    if (text) return clickByTextOrOcr(page, text, nth, num(args, 'fuzzy', 0.8));
    throw new RigError('BAD_ARGS', 'click needs --xy, --sel, --role/--name, --id or --text');
  };

  // A click on a wallet popup can be a Confirm; it passes the same gate as approve.
  await guardPopupAction(page, args);
  const { value, popupOpened } = await withPopupWatch(strategy);
  setActive(page);
  return { method: value.method, matched: value.matched, ...(value.point ?? {}), popupOpened };
}

export async function cmdType(args: Args): Promise<CmdResult> {
  const page = target(args);
  const text = str(args, 'value') ?? str(args, 'text') ?? '';
  const sel = str(args, 'sel');
  if (sel) {
    try {
      await page.locator(sel).nth(num(args, 'nth', 0)).fill(text, { timeout: 10_000 });
    } catch (err) {
      throw RigError.wrap(err);
    }
  } else {
    // keyboard.type turns a newline into Enter, which submits a focused Confirm.
    if (/[\r\n\t]/.test(text)) await guardPopupAction(page, args);
    await page.keyboard.type(text, { delay: num(args, 'delay', 20) });
  }
  return { typed: text.length };
}

export async function cmdPress(args: Args): Promise<CmdResult> {
  const page = target(args);
  const key = str(args, 'value') ?? str(args, 'key');
  if (!key) throw new RigError('BAD_ARGS', 'press needs a key');
  // Enter on a focused Confirm button submits the request.
  await guardPopupAction(page, args);
  await page.keyboard.press(key);
  return { key };
}

export async function cmdScroll(args: Args): Promise<CmdResult> {
  const page = target(args);
  const dy = num(args, 'dy', 400);
  const dx = num(args, 'dx', 0);
  const xy = str(args, 'xy');
  if (xy) {
    const point = parseXy(xy);
    await page.mouse.move(point.x, point.y);
  }
  await page.mouse.wheel(dx, dy);
  await page.waitForTimeout(250);
  return { dx, dy };
}
