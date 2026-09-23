/**
 * Adding a network through MetaMask's own settings form, for when no site is
 * open to ask `wallet_addEthereumChain`. Adding here does not switch: 13.x
 * selects networks per site, so the site switches when it asks.
 */
import type { Page } from 'playwright';
import { RigError, type CmdResult, type NetworkSpec } from '../types.js';
import { parseChainId } from '../chains.js';
import { HOME, NETWORK_FORM, TEXT } from './selectors.js';
import { clickByText, clickIfShown, fillOrThrow, clickOrThrow, gone, shown, waitEnabled } from './dom.js';
import { gotoHome, withHome } from './ui.js';

/** Settle times the form needs after each interaction. */
const FORM = { route: 900, menu: 700, field: 400, subview: 600 };

async function errorText(home: Page): Promise<string | null> {
  if (!(await shown(home, NETWORK_FORM.chainIdError, 300))) return null;
  const t = (await home.locator(NETWORK_FORM.chainIdError).first().innerText({ timeout: 1000 }).catch(() => ''))
    .trim();
  return t || 'chain id rejected';
}

/** `?view=add` is inferred from the bundle; the menu walk is the verified fallback. */
async function reachForm(home: Page): Promise<void> {
  await gotoHome(home, '/networks?view=add', FORM.route);
  if (await shown(home, NETWORK_FORM.nameInput, 2500)) return;
  await gotoHome(home, '/', FORM.menu);
  await clickIfShown(home, HOME.accountOptions, 2000);
  await home.waitForTimeout(FORM.field);
  await clickIfShown(home, NETWORK_FORM.menuNetworks, 2000);
  await home.waitForTimeout(FORM.menu);
  await clickIfShown(home, NETWORK_FORM.addCustomNetworkButton, 2500);
  await home.waitForTimeout(FORM.menu);
  if (!(await shown(home, NETWORK_FORM.nameInput, 2500))) {
    throw new RigError('ADD_CHAIN_FAILED', `could not reach the add-network form (${home.url()})`);
  }
}

function existed(detail: string): CmdResult {
  return { path: 'settings', existed: true, detail };
}

export async function addNetworkViaSettings(getHome: () => Promise<Page>, spec: NetworkSpec): Promise<CmdResult> {
  const chainId = parseChainId(spec.chainId);
  return withHome(getHome, async (home) => {
    await reachForm(home);
    const field = (sel: string) => home.locator(sel).first();

    await fillOrThrow(field(NETWORK_FORM.nameInput), spec.name, 'ADD_CHAIN_FAILED', 'network name');
    await fillOrThrow(field(NETWORK_FORM.chainIdInput), String(chainId), 'ADD_CHAIN_FAILED', 'chain id');
    await fillOrThrow(field(NETWORK_FORM.tickerInput), spec.symbol, 'ADD_CHAIN_FAILED', 'currency symbol');
    await home.waitForTimeout(FORM.field * 2);

    const early = await errorText(home);
    if (early) {
      if (TEXT.chainIdExists.test(early)) return existed(early);
      throw new RigError('ADD_CHAIN_FAILED', `the wallet rejected chain id ${chainId}: ${early}`);
    }

    // RPC URL lives behind a dropdown whose "Add RPC URL" entry opens a sub-view.
    if (!(await clickIfShown(home, NETWORK_FORM.rpcDropdown, 2000))) {
      throw new RigError('ADD_CHAIN_FAILED', 'RPC dropdown not found on the network form');
    }
    await home.waitForTimeout(FORM.field);
    if (!(await clickByText(home, TEXT.addRpcUrl))) {
      throw new RigError('ADD_CHAIN_FAILED', '"Add RPC URL" not offered by the RPC dropdown');
    }
    if (!(await shown(home, NETWORK_FORM.rpcUrlInput, 2500))) {
      throw new RigError('ADD_CHAIN_FAILED', 'RPC URL input not found');
    }
    await fillOrThrow(field(NETWORK_FORM.rpcUrlInput), spec.rpcUrl, 'ADD_CHAIN_FAILED', 'RPC URL');
    await home.waitForTimeout(300);
    await clickOrThrow(field(NETWORK_FORM.footerNext), 'ADD_CHAIN_FAILED', '"Add URL"');
    // Back on the form once the sub-view is gone; if it stays, the URL was rejected.
    if (!(await gone(home, NETWORK_FORM.rpcUrlInput, 8000)) || !(await shown(home, NETWORK_FORM.nameInput, 3000))) {
      const body = (await home.locator('body').innerText({ timeout: 1500 }).catch(() => '')) ?? '';
      const reason = TEXT.rpcRejected.exec(body)?.[0];
      throw new RigError('ADD_CHAIN_FAILED', `the wallet did not accept the RPC URL${reason ? ` (${reason})` : ''}`);
    }
    await home.waitForTimeout(FORM.field);

    let explorerSkipped = false;
    if (spec.explorer) {
      explorerSkipped = true;
      if (await clickIfShown(home, NETWORK_FORM.explorerDropdown, 1500)) {
        await home.waitForTimeout(FORM.field);
        await clickByText(home, TEXT.addExplorerUrl);
        if (await shown(home, NETWORK_FORM.explorerUrlInput, 2000)) {
          await fillOrThrow(field(NETWORK_FORM.explorerUrlInput), spec.explorer, 'ADD_CHAIN_FAILED', 'explorer URL');
          if (!(await clickIfShown(home, NETWORK_FORM.addExplorerButton, 1000))) {
            await clickIfShown(home, NETWORK_FORM.footerNext, 1000);
          }
          await home.waitForTimeout(FORM.subview);
          explorerSkipped = false;
        }
      }
    }

    // Save is enabled only once MetaMask has fetched eth_chainId from the RPC
    // and it agrees with the field; public RPCs can take a few seconds.
    const save = field(NETWORK_FORM.footerNext);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const err = await errorText(home);
      if (err) {
        if (TEXT.chainIdExists.test(err)) return existed(err);
        throw new RigError('ADD_CHAIN_FAILED', `the wallet rejected the network: ${err}`);
      }
      if (await waitEnabled(save, 400)) break;
    }
    if (!(await save.isEnabled().catch(() => false))) {
      throw new RigError('ADD_CHAIN_FAILED', 'Save never became enabled; the RPC may be unreachable or report a different chain id');
    }
    await clickOrThrow(save, 'ADD_CHAIN_FAILED', 'Save');

    // Success is the list view with its toast; a form that stays is a
    // rejection MetaMask rendered after the click.
    const toast = await shown(home, NETWORK_FORM.successToast, 10_000);
    const list = toast || (await shown(home, NETWORK_FORM.listPage, 2000));
    if (!list) {
      const err = await errorText(home);
      throw new RigError('ADD_CHAIN_FAILED', `the form did not accept the network${err ? `: ${err}` : ''} (${home.url()})`);
    }
    return { path: 'settings', added: true, toast, ...(explorerSkipped ? { explorerSkipped: true } : {}) };
  });
}
