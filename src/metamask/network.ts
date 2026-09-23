/**
 * Adding a network to the wallet: policy and orchestration. With a site open
 * the standard dapp flow is used (`wallet_addEthereumChain`, then a switch),
 * so the site itself ends up on the chain; with no site open the wallet's own
 * settings form is driven, which adds without switching.
 */
import type { Page } from 'playwright';
import { RigError, type AddEthereumChainParameter, type CmdResult, type NetworkSpec, type PopupGate } from '../types.js';
import { readState, writeState } from '../daemon/state.js';
import { parseChainId } from '../chains.js';
import { ethChainId, pageOrigin, requestWithApproval } from './provider.js';
import { addNetworkViaSettings } from './networksUi.js';
import { expectNetworkAdd, resolveNetworkName } from '../daemon/gate.js';

export function toHexChainId(value: string | number): string {
  return `0x${parseChainId(value).toString(16)}`;
}

export function chainParams(spec: NetworkSpec): AddEthereumChainParameter {
  return {
    chainId: toHexChainId(spec.chainId),
    chainName: spec.name,
    // 18 decimals is assumed; every chain the rig targets uses it.
    nativeCurrency: { name: spec.symbol, symbol: spec.symbol, decimals: 18 },
    rpcUrls: [spec.rpcUrl],
    ...(spec.explorer ? { blockExplorerUrls: [spec.explorer] } : {}),
  };
}

/** Remember a network the wallet now has, under the name MetaMask will display. */
function recordNetwork(spec: NetworkSpec, chainId: string): void {
  const networks = readState().networks ?? [];
  if (!networks.some((n) => n.rpc === spec.rpcUrl)) {
    networks.push({ chainId, name: spec.name, rpc: spec.rpcUrl });
    writeState({ networks });
  }
}

/**
 * The gate resolves prompt network names to chain ids, so a name must not
 * point at a different chain than the one being added, anywhere the gate
 * looks. Exported for tests.
 */
export async function assertNameFree(name: string, chainId: number, networks = readState().networks ?? []): Promise<void> {
  const known = await resolveNetworkName(name, networks);
  if (known !== null && known !== chainId) {
    throw new RigError(
      'BAD_ARGS',
      `"${name}" already names chain ${known} in the wallet or the public registry; give chain ${chainId} a name of its own`,
    );
  }
}

export async function addNetwork(
  spec: NetworkSpec,
  gate: PopupGate,
  opts: { page?: Page | null; getHome: () => Promise<Page> },
): Promise<CmdResult> {
  const chainId = toHexChainId(spec.chainId);
  const id = parseChainId(spec.chainId);
  await assertNameFree(spec.name, id);

  if (opts.page) {
    const page = opts.page;
    expectNetworkAdd(spec);
    let added;
    try {
      added = await requestWithApproval(page, 'wallet_addEthereumChain', [chainParams(spec)], gate);
    } finally {
      expectNetworkAdd(null);
    }
    if ('error' in added && added['error']) throw new RigError('ADD_CHAIN_FAILED', String(added['error']));
    if (added.done !== true) {
      throw new RigError('ADD_CHAIN_FAILED', `the wallet did not settle the add-network request (${JSON.stringify(added)})`);
    }

    // MetaMask may or may not switch on its own; ask explicitly and tolerate a no-op.
    const switched = await requestWithApproval(page, 'wallet_switchEthereumChain', [{ chainId }], gate).catch(
      (e: Error) => ({ error: e.message }),
    );
    const appChainId = await ethChainId(page);
    recordNetwork(spec, chainId);
    if (appChainId !== null) writeState({ chainId: appChainId });
    return {
      path: 'provider',
      origin: pageOrigin(page),
      rpcUrl: spec.rpcUrl,
      name: spec.name,
      chainId,
      appChainId,
      switched: appChainId !== null && appChainId === id,
      added,
      switchResult: switched,
    };
  }

  const result = await addNetworkViaSettings(opts.getHome, spec);
  recordNetwork(spec, chainId);
  return {
    ...result,
    rpcUrl: spec.rpcUrl,
    name: spec.name,
    chainId,
    switched: false,
    note: 'added to the wallet. MetaMask selects networks per site, so the site under test switches when it asks (wallet_switchEthereumChain), or run add_network again with the site open.',
  };
}
