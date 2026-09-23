/**
 * Provider calls run in the page under test. MetaMask injects `window.ethereum`
 * into every http(s) page and scopes accounts and the selected network per
 * site, so that page is the only honest place to ask "what does the site see"
 * and the only place a request should originate from. The rig has no page of
 * its own.
 *
 * Everything read back from the page is the page's word: a hostile site can
 * fake a result. Safety never depends on it; the gate reads MetaMask's own
 * prompt.
 */
import type { Page } from 'playwright';
import { RigError, type Args, type BridgeResult, type PopupGate } from '../types.js';
import { classify, currentPage, livePages, resolveTarget } from '../daemon/browser.js';
import { config } from '../config.js';
import { errMessage, newReqId, sleep } from '../util.js';
import { approve, drain } from './act.js';
import { closeNotification, ensureNotification, hasPending, reloadNotification } from './notification.js';

/** The page under test, if one is open: the active one, else the newest. Never opens. */
export function existingAppPage(): Page | null {
  const cur = currentPage();
  if (cur && classify(cur) === 'app') return cur;
  return livePages().filter((p) => classify(p) === 'app').at(-1) ?? null;
}

/** The page a provider call runs in: an explicit target, else the page under test. */
export function providerPage(args: Args = {}): Page {
  const target = typeof args['target'] === 'string' ? args['target'] : undefined;
  if (target) {
    const page = resolveTarget(target);
    if (classify(page) !== 'app') {
      throw new RigError('NO_APP_PAGE', `target ${target} is not an http(s) page; provider calls run in the site under test`);
    }
    return page;
  }
  const page = existingAppPage();
  if (!page) {
    const hint = config().appUrl ? ` (${config().appUrl})` : '';
    throw new RigError(
      'NO_APP_PAGE',
      `no site is open. Open the site under test first with rig_navigate goto${hint}: provider calls run in that page, since the wallet scopes accounts and network per site.`,
    );
  }
  return page;
}

export function pageOrigin(page: Page): string | null {
  try {
    return new URL(page.url()).origin;
  } catch {
    return null;
  }
}

/** The bridge shape as it lives on the page: a map of results by request id. */
interface RigWindow {
  ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
  __rig?: Record<string, unknown>;
}

/** Read one slot of the page bridge; missing means the page reloaded. */
export async function readBridgeSlot(page: Page, reqId: string): Promise<BridgeResult> {
  try {
    return (await page.evaluate((id) => {
      const w = window as unknown as RigWindow;
      return (w.__rig ?? {})[id] ?? { done: false, navigated: true };
    }, reqId)) as BridgeResult;
  } catch {
    // The page navigated or closed under the request; its outcome is gone.
    return { done: false, navigated: true };
  }
}

/**
 * Fire a provider request on the page and return its id. The outcome lands in
 * the bridge (`window.__rig[id]`, the same map `rig_eval fire` uses), where
 * `readBridgeSlot` and `rig_eval result` can read it. Nothing is eval'd, so a
 * site's content-security policy cannot get in the way.
 */
export async function request(page: Page, method: string, params: unknown[]): Promise<string> {
  const reqId = newReqId();
  let ok = false;
  try {
    ok = await page.evaluate(
      ([id, m, p]) => {
        const w = window as unknown as RigWindow;
        if (!w.ethereum) return false;
        w.__rig = w.__rig ?? {};
        const rig = w.__rig;
        rig[id] = { done: false, method: m, startedAt: Date.now() };
        w.ethereum
          .request({ method: m, params: p })
          .then((value) => {
            rig[id] = { done: true, value, method: m };
          })
          .catch((err: { message?: string; code?: unknown } | undefined) => {
            rig[id] = { done: true, error: String((err && err.message) || err), code: err && err.code, method: m };
          });
        return true;
      },
      [reqId, method, params] as [string, string, unknown[]],
    );
  } catch (err) {
    throw new RigError('NO_PROVIDER', `cannot reach ${page.url()}: ${errMessage(err)}`);
  }
  if (!ok) {
    throw new RigError(
      'NO_PROVIDER',
      `MetaMask has not injected window.ethereum into ${page.url()}; the page may still be loading, or it is not an http(s) page`,
    );
  }
  return reqId;
}

export async function settle(page: Page, reqId: string, timeoutMs = 20_000): Promise<BridgeResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await readBridgeSlot(page, reqId);
    if (r.done || ('navigated' in r && r.navigated)) return r;
    await sleep(250);
  }
  return { done: false, timeout: true };
}

function finished(r: BridgeResult): boolean {
  return r.done || ('navigated' in r && r.navigated === true);
}

/**
 * Wait for the wallet to show a request, reloading the notification route each
 * poll. A transaction can take several seconds to reach the queue (gas
 * estimation and simulation happen first), so keep looking rather than sample.
 */
async function waitForPrompt(page: Page, reqId: string, timeoutMs: number): Promise<{ pending: boolean; early?: BridgeResult }> {
  const deadline = Date.now() + timeoutMs;
  let notif = await ensureNotification();
  while (Date.now() < deadline) {
    if (await hasPending(notif)) return { pending: true };
    const early = await readBridgeSlot(page, reqId);
    if (finished(early)) return { pending: false, early };
    await reloadNotification(notif);
    notif = await ensureNotification();
  }
  return { pending: false };
}

export interface ProviderCallResult extends Record<string, unknown> {
  reqId: string;
  origin: string | null;
  done: boolean;
  popups: unknown[];
}

/**
 * Fire a provider call, act on the popups it raises, return the result. Every
 * popup passes through `gate` first: the queue is global to the wallet, so a
 * request raised by any tab can be sitting there, not only this one.
 */
export async function requestWithApproval(
  page: Page,
  method: string,
  params: unknown[],
  gate: PopupGate,
  timeoutMs = 25_000,
): Promise<ProviderCallResult> {
  const origin = pageOrigin(page);
  const reqId = await request(page, method, params);

  // Some calls need no approval (already connected, read-only): let them settle.
  for (let i = 0; i < 6; i++) {
    const early = await readBridgeSlot(page, reqId);
    if (finished(early)) return { reqId, origin, ...early, popups: [] };
    await sleep(300);
  }

  const waited = await waitForPrompt(page, reqId, Math.min(timeoutMs, 15_000));
  if (!waited.pending && waited.early) {
    await closeNotification();
    return { reqId, origin, ...waited.early, popups: [] };
  }
  let acts: unknown[] = [];
  try {
    acts = waited.pending ? await drain(approve, { gate }) : [];
  } finally {
    // A refused request stays pending in the wallet; the caller decides what
    // to do with it. The notification page must not be left open either way.
    await closeNotification();
  }
  const settled = await settle(page, reqId, timeoutMs);
  return { reqId, origin, ...settled, popups: acts };
}

/** Raw read-only calls, bounded so a wedged provider cannot hang a command. */
async function rawRequest(page: Page, method: string): Promise<unknown> {
  try {
    return await page.evaluate((m) => {
      const w = window as unknown as RigWindow;
      if (!w.ethereum) return null;
      return Promise.race<unknown>([
        w.ethereum.request({ method: m }),
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
    }, method);
  } catch {
    return null;
  }
}

export async function ethAccounts(page: Page): Promise<string[]> {
  const v = await rawRequest(page, 'eth_accounts');
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export async function ethChainIdHex(page: Page): Promise<string | null> {
  const v = await rawRequest(page, 'eth_chainId');
  return typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? v : null;
}

export async function ethChainId(page: Page): Promise<number | null> {
  const hex = await ethChainIdHex(page);
  return hex ? Number(BigInt(hex)) : null;
}
