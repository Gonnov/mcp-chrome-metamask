import { spawn } from 'node:child_process';
import sharp from 'sharp';
import type { Page } from 'playwright';
import { RigError, type OcrBox, type OcrResult } from './types.js';

/** Run tesseract with the image on stdin, TSV on stdout. */
function tesseract(buf: Buffer, psm: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tesseract', [
      'stdin',
      'stdout',
      '-l',
      'eng',
      '--psm',
      String(psm),
      '-c',
      'preserve_interword_spaces=1',
      'tsv',
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      rejectPromise(
        err.code === 'ENOENT'
          ? new RigError('OCR_UNAVAILABLE', 'tesseract is not installed or not on PATH; OCR needs it (brew install tesseract)')
          : new RigError('OCR_FAILED', err.message),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new RigError('OCR_FAILED', stderr.trim() || `tesseract exited ${code}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(buf);
  });
}

export interface OcrOptions {
  minConf?: number;
  psm?: number;
}

/** Screenshot sized for OCR. Retina gives 2x for free; otherwise upscale. */
async function ocrImage(page: Page): Promise<{ buf: Buffer; scale: number }> {
  const cssShot = await page.screenshot({ scale: 'css' });
  const cssMeta = await sharp(cssShot).metadata();
  const cssWidth = cssMeta.width ?? 0;
  if (cssWidth === 0) throw new RigError('SHOT_FAILED', 'screenshot has zero width');

  const deviceShot = await page.screenshot({ scale: 'device' });
  const devMeta = await sharp(deviceShot).metadata();
  const devWidth = devMeta.width ?? cssWidth;
  const dpr = devWidth / cssWidth;

  if (dpr >= 2) return { buf: deviceShot, scale: dpr };
  const up = await sharp(deviceShot)
    .resize({ width: Math.round(cssWidth * 2), kernel: 'lanczos3' })
    .grayscale()
    .normalise()
    .png()
    .toBuffer();
  return { buf: up, scale: 2 };
}

interface RawWord {
  text: string;
  conf: number;
  left: number;
  top: number;
  width: number;
  height: number;
  block: number;
  line: number;
}

function parseTsv(tsv: string): RawWord[] {
  const out: RawWord[] = [];
  const lines = tsv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const c = row.split('\t');
    if (c.length < 12) continue;
    if (c[0] !== '5') continue; // level 5 = word
    const text = (c[11] ?? '').trim();
    const conf = Number(c[10]);
    if (!text || Number.isNaN(conf)) continue;
    out.push({
      text,
      conf,
      left: Number(c[6]),
      top: Number(c[7]),
      width: Number(c[8]),
      height: Number(c[9]),
      block: Number(c[2]),
      line: Number(c[4]),
    });
  }
  return out;
}

function iou(a: OcrBox, b: OcrBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function box(id: string, text: string, conf: number, x: number, y: number, w: number, h: number): OcrBox {
  return {
    id,
    text,
    conf: Math.round(conf),
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    cx: Math.round(x + w / 2),
    cy: Math.round(y + h / 2),
  };
}

/** Group words into visual lines: vertical overlap >= 50%, gap <= 1.5x median height. */
function groupLines(words: OcrBox[]): OcrBox[] {
  if (words.length === 0) return [];
  const heights = words.map((w) => w.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 12;
  const maxGap = medianH * 1.5;

  const sorted = [...words].sort((a, b) => a.cy - b.cy || a.x - b.x);
  const rows: OcrBox[][] = [];
  for (const w of sorted) {
    const row = rows.find((r) => {
      const last = r[r.length - 1];
      if (!last) return false;
      const top = Math.max(w.y, last.y);
      const bottom = Math.min(w.y + w.h, last.y + last.h);
      const overlap = bottom - top;
      return overlap >= Math.min(w.h, last.h) * 0.5;
    });
    if (row) row.push(w);
    else rows.push([w]);
  }

  const lines: OcrBox[] = [];
  let n = 1;
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    // split a row where the horizontal gap is too large to be one label
    let chunk: OcrBox[] = [];
    const flush = (): void => {
      if (chunk.length === 0) return;
      const x = Math.min(...chunk.map((c) => c.x));
      const y = Math.min(...chunk.map((c) => c.y));
      const x2 = Math.max(...chunk.map((c) => c.x + c.w));
      const y2 = Math.max(...chunk.map((c) => c.y + c.h));
      const text = chunk.map((c) => c.text).join(' ');
      const conf = chunk.reduce((s, c) => s + c.conf, 0) / chunk.length;
      lines.push(box(`L${n++}`, text, conf, x, y, x2 - x, y2 - y));
      chunk = [];
    };
    for (const w of row) {
      const prev = chunk[chunk.length - 1];
      if (prev && w.x - (prev.x + prev.w) > maxGap) flush();
      chunk.push(w);
    }
    flush();
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

export async function ocrPage(
  page: Page,
  target: string,
  opts: OcrOptions = {},
): Promise<OcrResult> {
  const minConf = opts.minConf ?? 60;
  const psm = opts.psm ?? 11;
  const { buf, scale } = await ocrImage(page);

  let stdout: string;
  try {
    stdout = await tesseract(buf, psm);
  } catch (err) {
    throw new RigError('OCR_FAILED', `tesseract failed: ${(err as Error).message}`);
  }

  const raw = parseTsv(stdout).filter((w) => w.conf >= minConf);
  let words: OcrBox[] = raw.map((w, i) =>
    box(String(i + 1), w.text, w.conf, w.left / scale, w.top / scale, w.width / scale, w.height / scale),
  );

  // Drop near-duplicate detections, keeping the more confident one.
  const kept: OcrBox[] = [];
  for (const w of words) {
    const dup = kept.findIndex((k) => iou(k, w) > 0.7);
    if (dup >= 0) {
      const existing = kept[dup];
      if (existing && w.conf > existing.conf) kept[dup] = w;
    } else kept.push(w);
  }
  words = kept
    .sort((a, b) => a.cy - b.cy || a.x - b.x)
    .map((w, i) => ({ ...w, id: String(i + 1) }));

  return { ts: Date.now(), target, scale, words, lines: groupLines(words) };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Numbered boxes + coordinate grid drawn over a CSS-scale screenshot. */
export async function annotate(
  cssShot: Buffer,
  result: OcrResult,
  grid: number,
): Promise<Buffer> {
  const meta = await sharp(cssShot).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const parts: string[] = [];

  if (grid > 0) {
    for (let x = grid; x < w; x += grid) {
      parts.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#00b4d8" stroke-opacity="0.25" stroke-width="1"/>`,
        `<text x="${x + 2}" y="11" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#00b4d8">${x}</text>`,
      );
    }
    for (let y = grid; y < h; y += grid) {
      parts.push(
        `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#00b4d8" stroke-opacity="0.25" stroke-width="1"/>`,
        `<text x="2" y="${y - 2}" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#00b4d8">${y}</text>`,
      );
    }
  }

  for (const b of result.words) {
    const labelW = 8 + String(b.id).length * 6;
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#e5383b" stroke-width="1"/>`,
      `<rect x="${b.x}" y="${Math.max(0, b.y - 11)}" width="${labelW}" height="11" fill="#e5383b"/>`,
      `<text x="${b.x + 3}" y="${Math.max(9, b.y - 2)}" font-family="Helvetica, Arial, sans-serif" font-size="9" fill="#ffffff">${esc(b.id)}</text>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`;
  return sharp(cssShot)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/** Normalized Levenshtein similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const s = a.toLowerCase().trim();
  const t = b.toLowerCase().trim();
  if (s === t) return 1;
  if (!s || !t) return 0;
  if (s.includes(t) || t.includes(s)) return 0.9;
  const m = s.length;
  const n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (cur[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev = cur;
  }
  const dist = prev[n] ?? Math.max(m, n);
  return 1 - dist / Math.max(m, n);
}
