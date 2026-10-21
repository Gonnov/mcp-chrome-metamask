/**
 * Reading the wallet's state from its service worker, with no wallet tab.
 *
 * MetaMask's background exposes `globalThis.stateHooks.getPersistedState()` in
 * release builds. Playwright's own `worker.evaluate` cannot call it: LavaMoat
 * scuttles `setInterval`, which Playwright's injected helper touches. A raw
 * CDP `Runtime.evaluate` in the worker's main world has no such helper, so the
 * rig speaks to the worker target directly through the browser session.
 *
 * Only plain facts leave the worker: the expression below picks addresses and
 * settings in place, so the encrypted vault and anything else in the persisted
 * state never crosses into the daemon.
 */
import type { CDPSession } from 'playwright';
import { getRig } from '../daemon/browser.js';

interface Attached {
  cdp: CDPSession;
  sessionId: string;
}

let attached: Attached | null = null;
let nextId = 0;
/** A worker's reply to one Runtime.evaluate. */
interface Reply {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
}
const waiters = new Map<number, (msg: Reply) => void>();

/** Drop the worker session, detaching it so no listener outlives it. */
function drop(): void {
  const old = attached;
  attached = null;
  if (old) void old.cdp.detach().catch(() => undefined);
}

async function attach(): Promise<Attached> {
  if (attached) return attached;
  const { context, extensionId } = getRig();
  const browser = context.browser();
  if (!browser) throw new Error('no browser handle for a CDP session');
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
  if (!sw) {
    await cdp.detach().catch(() => undefined);
    throw new Error('the wallet service worker is not running');
  }
  // flatten: false routes the worker's replies through this one session, which
  // is the only way to address a worker from Playwright's CDPSession.
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: false })) as {
    sessionId: string;
  };
  cdp.on('Target.receivedMessageFromTarget', (e: { message: string }) => {
    const msg = JSON.parse(e.message) as Reply;
    if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
  });
  // An MV3 worker can be restarted by the browser; the next call re-attaches.
  cdp.on('Target.detachedFromTarget', () => {
    attached = null;
  });
  attached = { cdp, sessionId };
  return attached;
}

async function evaluate(expression: string, timeoutMs: number): Promise<unknown> {
  const { cdp, sessionId } = await attach();
  const id = ++nextId;
  const reply = new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`the wallet service worker did not answer in ${timeoutMs} ms`));
    }, timeoutMs);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      waiters.delete(id);
      resolve(msg);
    });
  });
  const message = JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } });
  await cdp.send('Target.sendMessageToTarget', { sessionId, message }).catch((err: unknown) => {
    drop();
    throw err;
  });
  const msg = await reply;
  if (msg.result?.exceptionDetails) throw new Error('the wallet service worker threw while reading its state');
  return msg.result?.result?.value;
}

export interface WalletFacts {
  /** The selected account, lower case, as the wallet stores it. */
  selected: string | null;
  /** Every account the wallet holds, lower case. */
  accounts: string[];
  /** Minutes before MetaMask locks itself; 0 means never. */
  autoLockMinutes: number | null;
}

const FACTS = `(async () => {
  const s = await globalThis.stateHooks.getPersistedState();
  const d = (s && s.data) || {};
  const ia = (d.AccountsController && d.AccountsController.internalAccounts) || {};
  const all = ia.accounts || {};
  const pick = (a) => (a && typeof a.address === 'string' ? a.address.toLowerCase() : null);
  const timeout = d.AppStateController && d.AppStateController.timeoutMinutes;
  return {
    selected: pick(all[ia.selectedAccount]),
    accounts: Object.values(all).map(pick).filter(Boolean),
    autoLockMinutes: typeof timeout === 'number' ? timeout : null,
  };
})()`;

/** Shape-check what the worker sent: it is the wallet's word, but still untyped JSON. */
export function toFacts(raw: unknown): WalletFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const addr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v);
  const selected = addr(r['selected']) ? r['selected'] : null;
  const accounts = Array.isArray(r['accounts']) ? r['accounts'].filter(addr) : [];
  const auto = r['autoLockMinutes'];
  return { selected, accounts, autoLockMinutes: typeof auto === 'number' && Number.isFinite(auto) ? auto : null };
}

/** The wallet's persisted account facts, or null when the worker cannot be read. */
export async function walletFacts(timeoutMs = 3000): Promise<WalletFacts | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return toFacts(await evaluate(FACTS, timeoutMs));
    } catch {
      // A restarted worker leaves a dead session behind: drop it and retry once.
      drop();
    }
  }
  return null;
}
