/** Acting on a wallet request: approve, reject, and the drain loop over the queue. */
import type { Locator, Page } from 'playwright';
import { RigError, type PopupGate, type PopupKind, type PromptInfo } from '../types.js';
import { KIND_APPROVE, REJECT_ALL, REJECT_SELECTORS, REJECT_TEXTS, SCROLL_TO_BOTTOM, THIRD_PARTY_NOTICE } from './selectors.js';
import { firstButton, firstShown, isShown, waitEnabled } from './dom.js';
import { ensureUnlocked } from './unlock.js';
import { readPrompt } from './prompt.js';
import { ensureNotification, reloadNotification } from './notification.js';
import { uiFacts } from './uistate.js';
import { sleep } from '../util.js';

/** How long a confirmed request may take to leave the page before the rig reads what is there. */
const LEAVE_MS = 3000;

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
  // The prompt was read, so the page is drawn: no need to wait for the arrow.
  if (await isShown(page, SCROLL_TO_BOTTOM)) {
    await page.locator(SCROLL_TO_BOTTOM).first().click({ timeout: 5000 }).catch(() => undefined);
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
  const pendingBefore = (await uiFacts(page))?.pending ?? null;
  try {
    await target.click({ timeout: 5000 });
  } catch (err) {
    if (page.isClosed()) return { ...base, closed: true };
    throw RigError.wrap(err);
  }
  // The request has left once the window closes, navigates to the next one,
  // or the wallet's queue shrinks; whichever the wallet does first.
  const deadline = Date.now() + LEAVE_MS;
  let pendingAfter: number | null = null;
  while (Date.now() < deadline) {
    if (page.isClosed()) return { ...base, closed: true };
    if (page.url() !== urlBefore) break;
    pendingAfter = (await uiFacts(page))?.pending ?? null;
    if (pendingBefore !== null && pendingAfter !== null && pendingAfter < pendingBefore) break;
    await sleep(50);
  }
  if (page.isClosed()) return { ...base, closed: true };
  // An empty queue has nothing to draw, so there is nothing to wait for.
  const nextKind = pendingAfter === 0 ? 'unknown' : (await readPrompt(page)).kind;
  return { ...base, nextKind };
}

/**
 * Acknowledge the third-party software notice when it sits over a request, so
 * the request itself can be read. The notice's Accept only enables once its
 * own text has been scrolled to the end. Returns whether a notice was there.
 */
export async function acceptThirdPartyNotice(page: Page): Promise<boolean> {
  const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: THIRD_PARTY_NOTICE.heading }) }).first();
  if (!(await modal.isVisible({ timeout: 300 }).catch(() => false))) return false;
  const scrollButton = modal.locator(THIRD_PARTY_NOTICE.scrollButton).first();
  if (await scrollButton.isVisible({ timeout: 200 }).catch(() => false)) {
    await scrollButton.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  // Accept watches the text box's own scroll position, so scroll that box to its end.
  await modal
    .locator(THIRD_PARTY_NOTICE.content)
    .evaluateAll((els) => {
      for (const el of els) {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    })
    .catch(() => undefined);
  const accept = modal.getByRole('button', { name: THIRD_PARTY_NOTICE.accept });
  if (!(await waitEnabled(accept, 4000))) return false;
  await accept.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return true;
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
  await acceptThirdPartyNotice(page);
  const target = await firstShown(page, own, 0);
  if (!target) throw new RigError('NO_ACTION', `the ${prompt.kind} prompt's button is not visible (${page.url()})`);
  const label = (await target.innerText({ timeout: 2000 }).catch(() => ''))?.trim() || 'button';
  return pressPrimary(page, prompt, target, label);
}

export async function reject(page: Page, prompt: PromptInfo): Promise<ActResult> {
  if (await isShown(page, REJECT_ALL)) {
    await page.locator(REJECT_ALL).first().click({ timeout: 5000 });
    return { label: 'Reject all', kind: prompt.kind, closed: page.isClosed(), method: 'selector' };
  }
  const bySel = await firstShown(page, REJECT_SELECTORS, 0);
  if (bySel) {
    const label = (await bySel.innerText({ timeout: 2000 }).catch(() => ''))?.trim() || 'button';
    return pressPrimary(page, prompt, bySel, label);
  }
  const byText = await firstButton(page, REJECT_TEXTS, 0);
  if (!byText) throw new RigError('NO_ACTION', `no cancel button on this ${prompt.kind} prompt (${page.url()})`);
  return pressPrimary(page, prompt, byText.loc, byText.label);
}

/**
 * True when the wallet queues another request within `ms`; false once it has
 * stayed empty that long. Unknown state (an unreadable page) counts as refilled,
 * so the drain falls back to looking at the route.
 */
async function queueRefills(page: Page, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const facts = await uiFacts(page);
    if (!facts || facts.pending > 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
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
    await acceptThirdPartyNotice(page);
    let prompt = await readPrompt(page);
    if (prompt.kind === 'unknown') {
      // One reload: a just-approved request can leave the route mid-transition.
      await reloadNotification(page);
      page = await ensureNotification();
      await ensureUnlocked(page);
      prompt = await readPrompt(page);
      if (prompt.kind === 'unknown') break;
    }
    let result: ActResult;
    try {
      if (opts.gate) await opts.gate(prompt, page);
      result = await action(page, prompt);
      done.push(result);
    } catch (err) {
      throw RigError.wrap(err, { stoppedAt: { index: i, kind: prompt.kind }, actions: done });
    }
    // A site often queues its next request a beat after the last is settled
    // (a sign-in right after connect). Watch the queue for that long instead
    // of sleeping it out, and stop as soon as it stays empty.
    if (!result.closed && result.nextKind === 'unknown' && !(await queueRefills(page, BETWEEN_REQUESTS_MS))) break;
    if (result.closed || result.nextKind !== 'unknown') await sleep(BETWEEN_REQUESTS_MS);
  }
  return done;
}
