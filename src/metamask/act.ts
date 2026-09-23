/** Acting on a wallet request: approve, reject, and the drain loop over the queue. */
import type { Locator, Page } from 'playwright';
import { RigError, type PopupGate, type PopupKind, type PromptInfo } from '../types.js';
import { KIND_APPROVE, REJECT_ALL, REJECT_SELECTORS, REJECT_TEXTS, SCROLL_TO_BOTTOM } from './selectors.js';
import { firstButton, firstShown, shown, waitEnabled } from './dom.js';
import { ensureUnlocked } from './unlock.js';
import { readPrompt } from './prompt.js';
import { ensureNotification, reloadNotification } from './notification.js';
import { sleep } from '../util.js';

/** MV3 state-flush slack between two queued requests; do not shorten. */
const BETWEEN_REQUESTS_MS = 800;

export interface ActResult {
  label: string;
  kind: PopupKind;
  closed: boolean;
  /** How the button was found. Always 'selector' now; kept for clients that read it. */
  method: 'selector';
  nextKind?: PopupKind;
  network?: string;
  origin?: string;
}

export type PopupAction = (page: Page, prompt: PromptInfo) => Promise<ActResult>;

async function pressPrimary(page: Page, prompt: PromptInfo, target: Locator, label: string): Promise<ActResult> {
  // Some confirmations disable the action until the user scrolls to the end.
  if (await shown(page, SCROLL_TO_BOTTOM, 300)) {
    await page.locator(SCROLL_TO_BOTTOM).first().click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  // The button may exist but be disabled until the UI settles.
  await waitEnabled(target, 5000);

  const base: ActResult = {
    label,
    kind: prompt.kind,
    closed: false,
    method: 'selector',
    ...(prompt.network ? { network: prompt.network } : {}),
    ...(prompt.origin ? { origin: prompt.origin } : {}),
  };
  const urlBefore = page.url();
  try {
    await target.click({ timeout: 5000 });
  } catch (err) {
    if (page.isClosed()) return { ...base, closed: true };
    throw RigError.wrap(err);
  }
  // Either the window closes, or it navigates in place to the next request.
  for (let i = 0; i < 15; i++) {
    if (page.isClosed()) return { ...base, closed: true };
    if (page.url() !== urlBefore) break;
    await page.waitForTimeout(100);
  }
  if (page.isClosed()) return { ...base, closed: true };
  return { ...base, nextKind: (await readPrompt(page)).kind };
}

/**
 * Approve the request the prompt describes. Only that kind's own button is
 * clicked: the kind is what the gate judged, so clicking any other primary
 * button on the page would approve something the gate never saw. A request
 * the rig cannot classify is refused, never guessed.
 */
export async function approve(page: Page, prompt: PromptInfo): Promise<ActResult> {
  const own = KIND_APPROVE[prompt.kind];
  if (!own) throw new RigError('NO_ACTION', `no approve button for a ${prompt.kind} prompt (${page.url()})`);
  const target = await firstShown(page, [own], 500);
  if (!target) throw new RigError('NO_ACTION', `the ${prompt.kind} prompt's button is not visible (${page.url()})`);
  const label = (await target.innerText().catch(() => ''))?.trim() || 'button';
  return pressPrimary(page, prompt, target, label);
}

export async function reject(page: Page, prompt: PromptInfo): Promise<ActResult> {
  if (await shown(page, REJECT_ALL, 300)) {
    await page.locator(REJECT_ALL).first().click({ timeout: 5000 });
    return { label: 'Reject all', kind: prompt.kind, closed: page.isClosed(), method: 'selector' };
  }
  const bySel = await firstShown(page, REJECT_SELECTORS, 300);
  if (bySel) {
    const label = (await bySel.innerText().catch(() => ''))?.trim() || 'button';
    return pressPrimary(page, prompt, bySel, label);
  }
  const byText = await firstButton(page, REJECT_TEXTS, 250);
  if (!byText) throw new RigError('NO_ACTION', `no cancel button on this ${prompt.kind} prompt (${page.url()})`);
  return pressPrimary(page, prompt, byText.loc, byText.label);
}

/**
 * Act on every queued request. MetaMask stacks them ("1 of 2"), so after each
 * action the route is re-checked and reloaded once before giving up.
 *
 * Each request is read once, classified and passed through `gate` before it
 * is touched. The queue is global to the extension: a connect prompt from the
 * site under test can be followed by a transaction from any other tab, so
 * gating only the first item would approve the rest blind. A refusal stops
 * the drain and carries what was already done in the error's details.
 */
export async function drain(
  action: PopupAction,
  opts: { gate?: PopupGate; max?: number } = {},
): Promise<ActResult[]> {
  const max = opts.max ?? 10;
  const done: ActResult[] = [];
  for (let i = 0; i < max; i++) {
    let page = await ensureNotification();
    if (page.isClosed()) break;
    await ensureUnlocked(page);
    let prompt = await readPrompt(page);
    if (prompt.kind === 'unknown') {
      // One reload: a just-approved request can leave the route mid-transition.
      await reloadNotification(page);
      page = await ensureNotification();
      await ensureUnlocked(page);
      prompt = await readPrompt(page);
      if (prompt.kind === 'unknown') break;
    }
    try {
      if (opts.gate) await opts.gate(prompt, page);
      done.push(await action(page, prompt));
    } catch (err) {
      throw RigError.wrap(err, { stoppedAt: { index: i, kind: prompt.kind }, actions: done });
    }
    await sleep(BETWEEN_REQUESTS_MS);
  }
  return done;
}
