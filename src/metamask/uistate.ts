/**
 * Reading a wallet page's own state instead of guessing from its pixels.
 *
 * Every MetaMask UI page (home, notification) exposes
 * `globalThis.stateHooks.getCleanAppState()` in release builds. Playwright's
 * `page.evaluate` is blocked there (LavaMoat scuttles what its helper uses),
 * but a raw CDP `Runtime.evaluate` reaches it. Only counts, flags and the
 * selected address are read out; nothing else leaves the page.
 */
import type { CDPSession, Page } from 'playwright';
import { getRig } from '../daemon/browser.js';
import { sleep } from '../util.js';

export interface UiFacts {
  /** Requests queued in the wallet, across every site. */
  pending: number;
  unlocked: boolean;
  /** A wallet exists; before that MetaMask is neither locked nor unlocked, just new. */
  onboarded: boolean;
  /** The selected account, lower case. */
  selected: string | null;
}

const sessions = new WeakMap<Page, CDPSession>();

async function session(page: Page): Promise<CDPSession> {
  const cached = sessions.get(page);
  if (cached) return cached;
  const cdp = await getRig().context.newCDPSession(page);
  sessions.set(page, cdp);
  return cdp;
}

const EXPR = `(async () => {
  const h = globalThis.stateHooks;
  if (!h || typeof h.getCleanAppState !== 'function') return null;
  const m = (await h.getCleanAppState()).metamask || {};
  const ia = m.internalAccounts || {};
  const sel = ia.accounts && ia.accounts[ia.selectedAccount];
  return {
    pending: typeof m.pendingApprovalCount === 'number' ? m.pendingApprovalCount : 0,
    unlocked: m.isUnlocked === true,
    onboarded: m.completedOnboarding === true,
    selected: sel && typeof sel.address === 'string' ? sel.address.toLowerCase() : null,
  };
})()`;

/** Shape-check the page's answer. Exported for tests. */
export function toUiFacts(raw: unknown): UiFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pending = typeof r['pending'] === 'number' && Number.isFinite(r['pending']) ? r['pending'] : 0;
  const sel = r['selected'];
  return {
    pending,
    unlocked: r['unlocked'] === true,
    onboarded: r['onboarded'] === true,
    selected: typeof sel === 'string' && /^0x[0-9a-f]{40}$/.test(sel) ? sel : null,
  };
}

/** The page's state right now, or null while the wallet UI has not started. */
export async function uiFacts(page: Page): Promise<UiFacts | null> {
  if (page.isClosed()) return null;
  try {
    const cdp = await session(page);
    const r = (await cdp.send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true })) as {
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    };
    if (r.exceptionDetails) return null;
    return toUiFacts(r.result?.value);
  } catch {
    // A navigation tears down the execution context; a closed page drops the session.
    sessions.delete(page);
    return null;
  }
}

/** Poll until the wallet UI on this page has started and reports its state. */
export async function waitUiFacts(page: Page, timeoutMs: number, stepMs = 50): Promise<UiFacts | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const facts = await uiFacts(page);
    if (facts || Date.now() >= deadline || page.isClosed()) return facts;
    await sleep(stepMs);
  }
}
