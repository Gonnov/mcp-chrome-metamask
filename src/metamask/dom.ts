/**
 * Locator primitives for MetaMask's own pages. Script evaluation is blocked on
 * extension pages, so everything is visibility probes, clicks and fills. All
 * waits are real waits (Playwright's isVisible returns at once and ignores its
 * timeout; waitFor is the one that waits).
 */
import type { Locator, Page } from 'playwright';
import { RigError, type RigCode } from '../types.js';
import { errLine } from '../util.js';

/** Default probe: long enough for a settled page, short enough to ladder through. */
export const PROBE_MS = 350;

export async function shown(page: Page, sel: string, timeout = PROBE_MS): Promise<boolean> {
  try {
    await page.locator(sel).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

export async function gone(page: Page, sel: string, timeout = PROBE_MS): Promise<boolean> {
  try {
    await page.locator(sel).first().waitFor({ state: 'hidden', timeout });
    return true;
  } catch {
    return false;
  }
}

async function visibleNow(loc: Locator, timeout: number): Promise<boolean> {
  try {
    await loc.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** The first visible locator among candidate selectors, in ladder order. */
export async function firstShown(page: Page, selectors: string[], timeout = PROBE_MS): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await visibleNow(loc, timeout)) return loc;
  }
  return null;
}

/** The first visible button whose name matches, in ladder order. */
export async function firstButton(
  page: Page,
  names: (string | RegExp)[],
  timeout = PROBE_MS,
): Promise<{ loc: Locator; label: string } | null> {
  for (const name of names) {
    const loc = page.getByRole('button', { name, exact: false }).first();
    if (await visibleNow(loc, timeout)) return { loc, label: String(name) };
  }
  return null;
}

/**
 * Click a selector if it is visible. True only when the click went through:
 * an obstructed click is a miss, so callers fall back instead of moving on.
 */
export async function clickIfShown(page: Page, sel: string, timeout = PROBE_MS): Promise<boolean> {
  if (!(await shown(page, sel, timeout))) return false;
  try {
    await page.locator(sel).first().click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function clickByText(page: Page, name: RegExp | string, timeout = PROBE_MS): Promise<boolean> {
  const hit = await firstButton(page, [name], timeout);
  if (!hit) return false;
  try {
    await hit.loc.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Click the first visible match, trying button role then any text node. */
export async function clickAny(page: Page, name: RegExp, timeout = 400): Promise<boolean> {
  if (await clickByText(page, name, timeout)) return true;
  const byText = page.getByText(name).first();
  if (!(await visibleNow(byText, timeout))) return false;
  try {
    await byText.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Click, turning a Playwright failure into a RigError with the caller's code. */
export async function clickOrThrow(loc: Locator, code: RigCode, what: string, timeout = 5000): Promise<void> {
  try {
    await loc.click({ timeout });
  } catch (err) {
    throw new RigError(code, `${what} could not be clicked: ${errLine(err)}`);
  }
}

/** Fill, turning a Playwright failure into a RigError with the caller's code. */
export async function fillOrThrow(loc: Locator, value: string, code: RigCode, what: string, timeout = 5000): Promise<void> {
  try {
    await loc.click({ timeout }).catch(() => undefined);
    await loc.fill(value, { timeout });
  } catch (err) {
    throw new RigError(code, `${what} could not be filled: ${errLine(err)}`);
  }
}

/** Poll until a locator is enabled, or give up. */
export async function waitEnabled(loc: Locator, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await loc.isEnabled().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return loc.isEnabled().catch(() => false);
}
