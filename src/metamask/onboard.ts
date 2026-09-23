import { existsSync, readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { RigError, type CmdResult } from '../types.js';
import { env, readEnvFile, readState, walletPassword, writeState } from '../daemon/state.js';
import { ROOT } from '../daemon/state.js';
import { resolve } from 'node:path';
import { ONBOARD, HOME, NAGS, TEXT, UNLOCK } from './selectors.js';
import { ensureUnlocked } from './unlock.js';
import { config } from '../config.js';
import { clickAny, clickByText, clickIfShown, fillOrThrow, shown, waitEnabled } from './dom.js';
import { gotoHome, homeUrl } from './ui.js';

/** Onboarding is bounded by time, not just iterations: a stuck screen returns. */
const ONBOARD_DEADLINE_MS = 180_000;

type Step =
  | 'terms'
  | 'welcome'
  | 'metrics'
  | 'password'
  | 'passkey'
  | 'privacy'
  | 'complete'
  | 'nag'
  | 'unlock'
  | 'home'
  | 'unknown';

async function detectStep(page: Page): Promise<Step> {
  if (await shown(page, UNLOCK.password)) return 'unlock';
  if (await shown(page, ONBOARD.termsCheckbox)) return 'terms';
  if (await shown(page, ONBOARD.passwordNew)) return 'password';
  if (await shown(page, ONBOARD.passkeyLater)) return 'passkey';
  if (await shown(page, ONBOARD.metricsAgree)) return 'metrics';
  if (await shown(page, ONBOARD.complete)) return 'complete';
  if (await shown(page, ONBOARD.privacySettings)) return 'privacy';
  if (await shown(page, ONBOARD.createWallet) || (await shown(page, ONBOARD.createWithSrp)))
    return 'welcome';
  for (const nag of NAGS) if (await shown(page, nag)) return 'nag';
  if (await shown(page, HOME.accountMenu)) return 'home';
  return 'unknown';
}

/**
 * Walk MetaMask's first-run flow. It is a loop over detected screens rather than
 * a fixed script because the order changes between minor versions (13.48 added a
 * passkey step) and because home nags appear unpredictably.
 */
export async function onboard(
  getPage: () => Promise<Page>,
  dry: boolean,
): Promise<CmdResult> {
  let page = await getPage();
  const password = walletPassword();
  const seen: string[] = [];
  const deadline = Date.now() + ONBOARD_DEADLINE_MS;
  for (let i = 0; i < 40 && Date.now() < deadline; i++) {
    // MetaMask opens and closes its own tabs during first run, so the page we
    // are driving can vanish underneath us. Re-acquire rather than fail.
    if (page.isClosed()) page = await getPage();
    const step = await detectStep(page);
    seen.push(step);
    if (dry) {
      await page.waitForTimeout(400);
      if (step === 'home') break;
      continue;
    }
    switch (step) {
      case 'unlock':
        await ensureUnlocked(page);
        break;
      case 'terms':
        await clickIfShown(page, ONBOARD.termsScroll);
        await page.locator(ONBOARD.termsCheckbox).first().click().catch(() => undefined);
        await clickIfShown(page, ONBOARD.termsAgree);
        break;
      case 'welcome':
        if (!(await clickIfShown(page, ONBOARD.createWithSrp))) {
          await clickIfShown(page, ONBOARD.createWallet);
        }
        break;
      case 'metrics':
        // Never opt into telemetry. If "No thanks" is not on this build, clear
        // the consent checkbox and take whatever continue button is offered;
        // the agree button itself is never clicked.
        if (!(await clickByText(page, TEXT.noThanks))) {
          const box = page.locator(ONBOARD.metricsCheckbox).first();
          if (await box.isChecked({ timeout: 300 }).catch(() => false)) {
            await box.click({ timeout: 3000 }).catch(() => undefined);
          }
          await clickByText(page, TEXT.continueOrNext);
        }
        break;
      case 'password': {
        await page.locator(ONBOARD.passwordNew).fill(password);
        await page.locator(ONBOARD.passwordConfirm).fill(password);
        await page.locator(ONBOARD.passwordTerms).first().click().catch(() => undefined);
        if (!(await clickIfShown(page, ONBOARD.passwordSubmit))) {
          await clickByText(page, TEXT.createPassword);
        }
        break;
      }
      case 'passkey':
        await clickIfShown(page, ONBOARD.passkeyLater);
        break;
      case 'privacy':
        if (!(await clickByText(page, TEXT.privacyDismiss))) {
          await clickIfShown(page, ONBOARD.privacySettings);
        }
        break;
      case 'complete': {
        // MetaMask 13.x can leave "Open wallet" permanently disabled
        // (Synpress #1308). The vault is already created at this point, so
        // navigating straight to the wallet home is the reliable way through.
        const done = page.locator(ONBOARD.complete).first();
        const enabled = await done.isEnabled({ timeout: 1500 }).catch(() => false);
        if (enabled) {
          await done.click({ timeout: 5000 }).catch(() => undefined);
        } else {
          await page.goto(homeUrl(page), { waitUntil: 'domcontentloaded' });
        }
        await page.waitForTimeout(1200);
        break;
      }
      case 'nag':
        for (const nag of NAGS) if (await clickIfShown(page, nag)) break;
        break;
      case 'home':
        writeState({ onboarded: true });
        return { onboarded: true, steps: seen };
      case 'unknown':
        await page.waitForTimeout(700);
        break;
    }
    await page.waitForTimeout(600);
  }
  if (dry) return { dry: true, steps: seen };
  const final = await detectStep(page);
  if (final === 'home') {
    writeState({ onboarded: true });
    return { onboarded: true, steps: seen };
  }
  return { onboarded: false, stuckAt: final, steps: seen, url: page.url(), timedOut: Date.now() >= deadline };
}

/**
 * Find the burner key, in descending order of exposure: a command-line flag,
 * the environment, a file holding only the key, or a named variable in another
 * env file. Optional by design, since a fresh install has no key to import and
 * the generated wallet is a perfectly good burner.
 *
 * There is deliberately no way to pass a key as an MCP tool argument: tool
 * arguments become part of the model's context and of every transcript and log
 * that follows. The command line is the user's own shell, which is a different
 * and smaller exposure, but still one only a throwaway key should accept.
 *
 * Read once and handed straight to the wallet; never logged, never persisted.
 */
export function findPrivateKey(
  envFile?: string,
  varName?: string,
  keyFile?: string,
  inline?: string,
): string | null {
  if (inline) return inline.startsWith('0x') ? inline : `0x${inline}`;

  const direct = env('RIG_PRIVATE_KEY', '');
  if (direct) return direct.startsWith('0x') ? direct : `0x${direct}`;

  // A file holding nothing but the key, so only its path is ever visible.
  // --key-file on the server entry lands in config().privateKeyFile.
  const plain = keyFile ?? config().privateKeyFile ?? env('RIG_KEY_FILE', '');
  if (plain) {
    const path = resolve(ROOT, plain);
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value.startsWith('0x') ? value : `0x${value}`;
    }
  }

  // Or a named variable inside an existing dotenv file.
  const configured = envFile ?? env('RIG_KEY_ENV_FILE', '');
  if (!configured) return null;
  const file = resolve(ROOT, configured);
  const key = varName ?? env('RIG_KEY_VAR', 'PRIVATE_KEY');
  const value = readEnvFile(file)[key];
  if (!value) return null;
  return value.startsWith('0x') ? value : `0x${value}`;
}

/** Same lookup, but for commands where a missing key is a hard error. */
export function readPrivateKey(
  envFile?: string,
  varName?: string,
  keyFile?: string,
  inline?: string,
): string {
  const key = findPrivateKey(envFile, varName, keyFile, inline);
  if (!key) {
    throw new RigError(
      'NO_KEY',
      'no burner key available. Pass --pkey or --key-file, set RIG_PRIVATE_KEY in the MCP server env block, or omit it entirely and let the wallet generate one.',
    );
  }
  return key;
}

export async function importKey(
  getPage: () => Promise<Page>,
  privateKey: string,
  expectedAddress: string,
): Promise<CmdResult> {
  let page = await getPage();
  if (page.isClosed()) page = await getPage();
  await ensureUnlocked(page);
  const state = readState();
  if (state.importedAddress?.toLowerCase() === expectedAddress.toLowerCase()) {
    const already = await selectAccount(page, expectedAddress);
    return { alreadyImported: true, address: state.importedAddress, selected: already };
  }

  if (page.isClosed()) page = await getPage();
  await gotoHome(page, '/', 800);
  await dismissNags(page);

  // Verified path on 13.48: account menu -> Add wallet -> Import an account.
  // Each step is checked before the next, so a missed menu never sends the
  // key into whatever textbox happens to be focused.
  if (!(await clickIfShown(page, HOME.accountMenu, 10_000))) {
    throw new RigError('IMPORT_FAILED', 'could not open the account menu');
  }
  await page.waitForTimeout(700);
  if (!(await clickAny(page, TEXT.addWallet)) && !(await clickAny(page, TEXT.addAccount))) {
    throw new RigError('IMPORT_FAILED', 'could not open the add-wallet menu');
  }
  await page.waitForTimeout(700);
  if (!(await clickAny(page, TEXT.importAccount)) && !(await clickAny(page, TEXT.privateKey))) {
    throw new RigError('IMPORT_FAILED', 'could not open the private-key import screen');
  }
  await page.waitForTimeout(900);

  // The import screen is the dialog that holds the Import button; the key
  // goes into that dialog's textbox and nowhere else.
  const importBtn = page.getByRole('button', { name: TEXT.importSubmit }).first();
  if (!(await importBtn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false))) {
    throw new RigError('IMPORT_FAILED', 'the import screen did not open (no Import button)');
  }
  const dialog = page.getByRole('dialog').filter({ has: importBtn });
  const scope = (await dialog.count().catch(() => 0)) > 0 ? dialog.first() : page.locator('body');
  const input = scope.getByRole('textbox').first();
  if (!(await input.isVisible({ timeout: 10_000 }).catch(() => false))) {
    throw new RigError('IMPORT_FAILED', 'the import screen has no key field');
  }
  await fillOrThrow(input, privateKey, 'IMPORT_FAILED', 'the private key field', 10_000);
  await page.waitForTimeout(400);

  if (!(await waitEnabled(importBtn, 5000, 250))) {
    throw new RigError('IMPORT_FAILED', 'Import stayed disabled; the key was rejected');
  }
  await importBtn.click({ timeout: 10_000 }).catch((err: unknown) => {
    throw RigError.wrap(err);
  });
  await page.waitForTimeout(2000);
  await dismissNags(page);

  const selected = await selectAccount(page, expectedAddress);
  writeState({ importedAddress: expectedAddress });
  return { imported: true, address: expectedAddress, selected };
}

export async function dismissNags(page: Page): Promise<number> {
  let closed = 0;
  for (const nag of NAGS) {
    if (await clickIfShown(page, nag)) closed++;
  }
  const closers = page.getByRole('button', { name: TEXT.closeButton });
  const n = await closers.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 4); i++) {
    await closers.nth(0).click({ timeout: 2000 }).catch(() => undefined);
    closed++;
    await page.waitForTimeout(250);
  }
  return closed;
}

/**
 * MetaMask truncates addresses as `0xABCDE...12345`: five hex characters at
 * each end. Matching both ends is what tells accounts apart.
 */
export function shortAddress(address: string): { head: string; tail: string } {
  const a = address.toLowerCase();
  return { head: a.slice(0, 7), tail: a.slice(-5) };
}

function matchesShort(text: string, address: string): boolean {
  const { head, tail } = shortAddress(address);
  const t = text.toLowerCase().replace(/\s+/g, '');
  // 13.48 shortens to 5 trailing characters on the home header and 4 in some lists.
  return t.startsWith(head) && (t.endsWith(tail) || t.endsWith(tail.slice(-4)));
}

/** Make the imported account the selected one, so dapps see it. */
export async function selectAccount(page: Page, address: string): Promise<boolean> {
  await gotoHome(page, '/', 700);
  const header = (await page.locator('p').allInnerTexts().catch(() => [])) as string[];
  if (header.some((t) => matchesShort(t, address))) return true;

  if (!(await clickIfShown(page, HOME.accountMenu, 10_000))) return false;
  await page.waitForTimeout(700);
  const { head } = shortAddress(address);
  const rows = page.getByText(new RegExp(head, 'i'));
  const n = await rows.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const text = (await row.innerText().catch(() => '')) ?? '';
    if (!matchesShort(text, address)) continue;
    await row.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(900);
    const after = (await page.locator('p').allInnerTexts().catch(() => [])) as string[];
    return after.some((t) => matchesShort(t, address));
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  return false;
}
