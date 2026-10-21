/**
 * Reading a wallet request page: what kind of request it is, which network it
 * will execute on, who asked. One accessibility snapshot answers everything
 * after the kind, so a page is read once per decision and the record is
 * passed around rather than re-read.
 */
import type { Page } from 'playwright';
import type { PopupKind, PromptInfo } from '../types.js';
import { CONNECT_ROUTE, KIND_MARKERS, NETWORK_DISPLAY, NETWORK_SWITCH_TARGET, PROMPT_ROWS } from './selectors.js';
import { isShown, whichShown } from './dom.js';
import { sleep } from '../util.js';

/**
 * How long a read waits for any request marker to draw. One wait covers the
 * whole marker ladder; a page that already settled answers at once.
 */
export const KIND_WAIT_MS = 500;

/** A request page draws its rows a beat after its footer; this is how long a missing network row is waited for. */
const NETWORK_ROW_WAIT_MS = 1500;

function routeOf(url: string): string {
  try {
    return new URL(url).hash.replace(/^#/, '');
  } catch {
    return '';
  }
}

export async function detectKind(page: Page, waitMs = KIND_WAIT_MS): Promise<PopupKind> {
  // The connect flow's review page draws the legacy footer and names no single
  // network (it lists the enabled ones), so by its buttons it would read as a
  // `legacy` request with an unknown chain. It grants a site access, nothing more.
  if (CONNECT_ROUTE.test(routeOf(page.url()))) return 'connect';
  const sels = KIND_MARKERS.map((m) => m.sel);
  let i = await whichShown(page, sels, waitMs);
  // `confirm-btn` is also a secondary button on some warning pages, and the
  // value-moving footer can draw a beat after it. A connect read from buttons
  // alone is re-read once, so it never exempts a request still drawing.
  if (KIND_MARKERS[i]?.kind === 'connect') {
    await sleep(150);
    i = await whichShown(page, sels, 0);
  }
  return KIND_MARKERS[i]?.kind ?? 'unknown';
}

/**
 * Read the value of a labelled row ("Network", "Request from") out of an
 * accessibility snapshot of a MetaMask 13.x request page. The row is a
 * paragraph holding the label, followed by an avatar and a paragraph holding
 * the value. Exported for tests.
 */
export function rowFromAria(snapshot: string, label: string, values = 1): string | null {
  const lines = snapshot.split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => l === `- paragraph: ${label}`);
  if (at < 0) return null;
  const found: string[] = [];
  for (let j = at + 1; j < lines.length && j <= at + 4 && found.length < values; j++) {
    const line = lines[j] ?? '';
    if (/^- paragraph: /.test(line) && !/^- paragraph$/.test(line)) {
      const v = line.slice('- paragraph: '.length).trim();
      if (v) found.push(v);
    } else if (/^- heading/.test(line)) {
      break;
    }
  }
  return found.length ? found.join(' ') : null;
}

/**
 * Whether an accessibility snapshot is an add-network or update-network
 * prompt. Judged on structure MetaMask owns, not on words a site can put on
 * the page: a heading of the form "Add <name>" / "Update <name>", MetaMask's
 * own explanatory sentence or an RPC row, and none of the rows a value-moving
 * request carries (a message, a signer, an amount). Exported for tests.
 */
export function networkPromptFromAria(snapshot: string): boolean {
  const lines = snapshot.split('\n').map((l) => l.trim());
  const heading = lines.some((l) => /^- heading "(Add|Update) .+" \[level=\d\]$/.test(l));
  if (!heading) return false;
  const explains = lines.some(
    (l) => l === `- paragraph: ${PROMPT_ROWS.addNetworkSentence}` || l === `- paragraph: ${PROMPT_ROWS.rpc}`,
  );
  if (!explains) return false;
  const valueRows = PROMPT_ROWS.valueRows.map((r) => `- paragraph: ${r}`);
  return !lines.some((l) => valueRows.includes(l));
}

async function ariaSnapshot(page: Page): Promise<string> {
  return page.locator('body').ariaSnapshot({ timeout: 3000 }).catch(() => '');
}

/** The network name from a dedicated element, on the legacy pages that have one. */
async function networkFromElement(page: Page): Promise<string | null> {
  for (const sel of NETWORK_DISPLAY) {
    if (!(await isShown(page, sel))) continue;
    const text = (await page.locator(sel).first().innerText({ timeout: 2000 }).catch(() => ''))?.trim();
    if (text) return text;
  }
  return null;
}

/**
 * Read a request page once. MetaMask selects a network per origin, so the
 * network shown here, not any page of the rig's, is the only honest answer to
 * "which chain is this request on".
 */
export async function readPrompt(page: Page, waitMs = KIND_WAIT_MS): Promise<PromptInfo> {
  const kind = await detectKind(page, waitMs);
  if (kind === 'unknown' || kind === 'unlock') {
    return { kind, network: null, origin: null, rpcHost: null, isNetworkPrompt: false, isSwitchPrompt: false };
  }
  // The footer is drawn, so the page is: these reads do not wait.
  let isSwitchPrompt = await isShown(page, NETWORK_SWITCH_TARGET);
  let snap = await ariaSnapshot(page);
  let network = (await networkFromElement(page)) ?? rowFromAria(snap, PROMPT_ROWS.network);
  // A request with no network row yet is still drawing it. Reading it as
  // unknown would refuse it (the gate fails closed), so give the row a moment.
  const deadline = Date.now() + NETWORK_ROW_WAIT_MS;
  const waitsForRow = kind !== 'connect' && !isSwitchPrompt && !networkPromptFromAria(snap);
  while (!network && waitsForRow && Date.now() < deadline && !page.isClosed()) {
    await sleep(100);
    isSwitchPrompt = await isShown(page, NETWORK_SWITCH_TARGET);
    if (isSwitchPrompt) break;
    snap = await ariaSnapshot(page);
    network = (await networkFromElement(page)) ?? rowFromAria(snap, PROMPT_ROWS.network);
  }
  return {
    kind,
    network,
    origin: rowFromAria(snap, PROMPT_ROWS.requestFrom, 2),
    rpcHost: rowFromAria(snap, PROMPT_ROWS.rpc),
    isNetworkPrompt: networkPromptFromAria(snap),
    isSwitchPrompt,
  };
}
