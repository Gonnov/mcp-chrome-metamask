/** Seeing a page: screenshot, OCR, accessibility tree, find, console. */
import { writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Page } from 'playwright';
import { RigError, type Args, type CmdResult } from '../../types.js';
import { bool, num, str } from '../../args.js';
import { annotate, ocrPage } from '../../ocr.js';
import { cacheOcr, clearLogs, getLogs, pageId, pageInfo } from '../browser.js';
import { SHOTS_DIR, ensureDirs } from '../state.js';
import { target } from './nav.js';

/** A screenshot path must stay inside the shots directory. */
export function shotPath(out: string | undefined, stamp: string): string {
  if (!out) return resolve(SHOTS_DIR, `${stamp}.png`);
  const full = resolve(SHOTS_DIR, out);
  if (!full.startsWith(SHOTS_DIR + sep) || !full.endsWith('.png')) {
    throw new RigError('BAD_ARGS', `out must be a .png name inside ${SHOTS_DIR}`);
  }
  return full;
}

export async function cmdShot(args: Args): Promise<CmdResult> {
  ensureDirs();
  const page = target(args);
  const full = bool(args, 'full');
  const shot = await page.screenshot({ scale: 'css', fullPage: full });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = shotPath(str(args, 'out'), stamp);
  await writeFile(out, shot);

  const info = await pageInfo(page);
  const result: CmdResult = {
    path: out,
    target: str(args, 'target') ?? 'active',
    pageId: info.id,
    kind: info.kind,
    url: info.url,
    dpr: info.dpr,
  };

  if (bool(args, 'annotate')) {
    const ocr = await ocrPage(page, String(info.id), { minConf: num(args, 'min-conf', 60) });
    cacheOcr(page, ocr);
    const boxes = await annotate(shot, ocr, num(args, 'grid', 100));
    const boxPath = out.replace(/\.png$/, '') + '.boxes.png';
    await writeFile(boxPath, boxes);
    result['annotated'] = boxPath;
    result['ocrIds'] = ocr.words.length;
  }
  return result;
}

export async function cmdOcr(args: Args): Promise<CmdResult> {
  const page = target(args);
  const info = await pageInfo(page);
  const result = await ocrPage(page, String(info.id), {
    minConf: num(args, 'min-conf', 60),
    psm: num(args, 'psm', 11),
  });
  cacheOcr(page, result);
  return {
    pageId: info.id,
    scale: result.scale,
    words: result.words,
    lines: result.lines.map((l) => ({ id: l.id, text: l.text, cx: l.cx, cy: l.cy })),
  };
}

export async function cmdAria(args: Args): Promise<CmdResult> {
  const page = target(args);
  try {
    return { snapshot: await page.locator('body').ariaSnapshot({ timeout: 10_000 }) };
  } catch (err) {
    throw RigError.wrap(err);
  }
}

/** The ARIA role a caller restricts a search to; Playwright validates the value itself. */
export type Role = Parameters<Page['getByRole']>[0];

export function roleArg(args: Args): Role | undefined {
  const role = str(args, 'role');
  if (role === undefined) return undefined;
  if (!/^[a-z]+$/.test(role)) throw new RigError('BAD_ARGS', `role must be an ARIA role name, got "${role}"`);
  return role as Role;
}

export async function cmdFind(args: Args): Promise<CmdResult> {
  const page = target(args);
  const text = str(args, 'value') ?? str(args, 'text');
  if (!text) throw new RigError('BAD_ARGS', 'find needs text');
  const role = roleArg(args);
  const candidates = role
    ? [page.getByRole(role, { name: text })]
    : [page.getByRole('button', { name: text }), page.getByRole('link', { name: text }), page.getByText(text, { exact: false })];
  const hits: Record<string, unknown>[] = [];
  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const item = loc.nth(i);
      const box = await item.boundingBox().catch(() => null);
      if (!box) continue;
      hits.push({
        text: (await item.innerText().catch(() => ''))?.trim().slice(0, 80),
        box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
        cx: Math.round(box.x + box.width / 2),
        cy: Math.round(box.y + box.height / 2),
        visible: await item.isVisible().catch(() => false),
        enabled: await item.isEnabled().catch(() => false),
      });
    }
    if (hits.length) break;
  }
  return { found: hits.length, hits };
}

export async function cmdConsole(args: Args): Promise<CmdResult> {
  const page = target(args);
  const lines = getLogs(page);
  if (bool(args, 'clear')) clearLogs(page);
  return { pageId: pageId(page), lines: lines.slice(-num(args, 'n', 60)) };
}
