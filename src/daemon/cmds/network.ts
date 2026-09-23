/** network.* commands: what the rig knows about chains, and choosing one. */
import { RigError, type Args, type CmdResult, type NetworkSpec } from '../../types.js';
import { str } from '../../args.js';
import { isHttpUrl } from '../../util.js';
import { config, networkIsLocked, writeConfigFile } from '../../config.js';
import { classify as classifyChain, describe, parseChainId, spendsRealMoney } from '../../chains.js';
import { readState, writeState } from '../state.js';
import { addNetwork, toHexChainId } from '../../metamask/network.js';
import { ethChainId, existingAppPage, pageOrigin } from '../../metamask/provider.js';
import { allowedChains, chainGate, trustedRpcFor } from '../gate.js';
import { mmHomePage } from './session.js';

export function hasNetworkSpec(args: Args): boolean {
  return str(args, 'rpc_url') !== undefined || str(args, 'chain_id') !== undefined;
}

/**
 * Only the chain id and the RPC are ever required. The display name and native
 * symbol come from the public chain registry when it knows the chain, and are
 * only worth typing for a chain it does not.
 */
export async function networkSpec(args: Args): Promise<NetworkSpec> {
  const rpcUrl = str(args, 'rpc_url');
  const chainId = str(args, 'chain_id');
  if (!rpcUrl || !chainId) {
    throw new RigError('BAD_ARGS', 'a network needs chain_id and rpc_url');
  }
  if (!isHttpUrl(rpcUrl)) throw new RigError('BAD_ARGS', `rpc_url must be an http(s) URL: ${rpcUrl}`);
  const explorer = str(args, 'explorer');
  if (explorer && !isHttpUrl(explorer)) throw new RigError('BAD_ARGS', `explorer must be an http(s) URL: ${explorer}`);
  const id = parseChainId(chainId);
  const known = await describe(id);
  return {
    chainId: toHexChainId(id),
    rpcUrl,
    name: str(args, 'name') ?? known.name ?? `Chain ${id}`,
    symbol: str(args, 'symbol') ?? known.symbol ?? 'ETH',
    ...(explorer ? { explorer } : {}),
  };
}

/** Add a network the way the current state allows: via the site if open, else the wallet's settings. */
export function addNetworkHere(spec: NetworkSpec, args: Args): Promise<CmdResult> {
  return addNetwork(spec, chainGate(args), { page: existingAppPage(), getHome: mmHomePage });
}

/**
 * Which chain the site under test is on, when one is open, else the last one
 * seen. MetaMask selects networks per site, so this is that site's answer.
 * Never opens a tab to find out; the gate does not depend on this value.
 */
export async function currentChain(): Promise<{ chainId: number | null; source: 'app' | 'remembered'; origin?: string }> {
  const page = existingAppPage();
  if (page) {
    const live = await ethChainId(page);
    if (live !== null) {
      if (readState().chainId !== live) writeState({ chainId: live });
      const origin = pageOrigin(page);
      return { chainId: live, source: 'app', ...(origin ? { origin } : {}) };
    }
  }
  return { chainId: readState().chainId ?? null, source: 'remembered' };
}

function setAllowed(args: Args, allow: boolean, verb: string): CmdResult {
  const raw = str(args, 'value') ?? str(args, 'chain_id');
  if (!raw) throw new RigError('BAD_ARGS', `network ${verb} needs a chain id`);
  const id = parseChainId(raw);
  const allowed = new Set(readState().allowedChains ?? []);
  if (allow) allowed.add(id);
  else allowed.delete(id);
  writeState({ allowedChains: [...allowed] });
  return { allowed: [...allowed] };
}

const commands: Record<string, (args: Args) => Promise<CmdResult>> = {
  async list() {
    const state = readState();
    return {
      configured: config().network ?? null,
      locked: networkIsLocked(),
      addedToWallet: state.networks ?? [],
      allowed: allowedChains(),
      current: await currentChain(),
    };
  },
  async current() {
    const cur = await currentChain();
    if (cur.chainId === null) return { chainId: null, source: cur.source };
    const verdict = await classifyChain(cur.chainId, trustedRpcFor(cur.chainId), allowedChains());
    return {
      ...verdict,
      spendsRealMoney: spendsRealMoney(verdict),
      source: cur.source,
      ...(cur.origin ? { origin: cur.origin } : {}),
    };
  },
  async use(args) {
    if (networkIsLocked()) {
      throw new RigError('NETWORK_LOCKED', 'the network was fixed when the server was started; change it there instead');
    }
    const spec = await networkSpec(args);
    writeConfigFile({
      network: {
        chainId: parseChainId(spec.chainId),
        rpcUrl: spec.rpcUrl,
        name: spec.name,
        symbol: spec.symbol,
        ...(spec.explorer ? { explorer: spec.explorer } : {}),
      },
    });
    // Before the wallet exists there is nothing to add it to. Remember the
    // choice; setup applies it. This is the order a first run takes.
    if (!readState().onboarded) {
      return { saved: spec, appliedToWallet: false, note: 'saved; it will be added when the wallet is set up' };
    }
    return addNetworkHere(spec, args);
  },
  // Operator-only: the MCP surface does not expose these. Vouching is what
  // lets the gate approve on a chain it cannot classify.
  async allow(args) {
    return setAllowed(args, true, 'allow');
  },
  async disallow(args) {
    return setAllowed(args, false, 'disallow');
  },
};

export async function networkCmd(sub: string, args: Args): Promise<CmdResult> {
  const fn = commands[sub];
  if (!fn) throw new RigError('UNKNOWN_CMD', `unknown network subcommand: ${sub}`);
  return fn(args);
}
