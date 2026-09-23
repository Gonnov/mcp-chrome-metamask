/**
 * Reading a wallet request page: what kind of request it is, which network it
 * will execute on, who asked. One accessibility snapshot answers everything
 * after the kind, so a page is read once per decision and the record is
 * passed around rather than re-read.
 */
import type { Page } from 'playwright';
import type { PopupKind, PromptInfo } from '../types.js';
import { KIND_MARKERS, NETWORK_DISPLAY, NETWORK_SWITCH_TARGET, PROMPT_ROWS } from './selectors.js';
import { shown } from './dom.js';

/** Per-marker probe: a rendered prompt shows its button at once. */
const MARKER_PROBE_MS = 150;

export async function detectKind(page: Page): Promise<PopupKind> {
  for (const { kind, sel } of KIND_MARKERS) {
    if (await shown(page, sel, MARKER_PROBE_MS)) return kind;
  }
  return 'unknown';
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
    if (!(await shown(page, sel, 150))) continue;
    const text = (await page.locator(sel).first().innerText().catch(() => ''))?.trim();
    if (text) return text;
  }
  return null;
}

/**
 * Read a request page once. MetaMask selects a network per origin, so the
 * network shown here, not any page of the rig's, is the only honest answer to
 * "which chain is this request on".
 */
export async function readPrompt(page: Page): Promise<PromptInfo> {
  const kind = await detectKind(page);
  if (kind === 'unknown' || kind === 'unlock') {
    return { kind, network: null, origin: null, rpcHost: null, isNetworkPrompt: false, isSwitchPrompt: false };
  }
  const isSwitchPrompt = await shown(page, NETWORK_SWITCH_TARGET, 150);
  const snap = await ariaSnapshot(page);
  const network = (await networkFromElement(page)) ?? rowFromAria(snap, PROMPT_ROWS.network);
  return {
    kind,
    network,
    origin: rowFromAria(snap, PROMPT_ROWS.requestFrom, 2),
    rpcHost: rowFromAria(snap, PROMPT_ROWS.rpc),
    isNetworkPrompt: networkPromptFromAria(snap),
    isSwitchPrompt,
  };
}
