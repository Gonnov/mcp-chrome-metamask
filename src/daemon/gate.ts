/**
 * The real-money gate.
 *
 * Approvals are automatic, so the rig decides whether a request spends real
 * money before it clicks Confirm. The classifier fails closed: a chain it
 * cannot show to be a test or local network counts as real money and is
 * refused until the operator vouches for it. No registry carries a reliable
 * testnet flag, so this is the only safe default.
 *
 * Three rules make the gate hold:
 *  - it reads the network from the request page itself, as MetaMask renders
 *    it, because MetaMask selects a network per origin: one site can sit on a
 *    testnet while another raises a mainnet transaction;
 *  - it runs once per queued request, inside the drain loop, because the queue
 *    is global to the extension and a connect prompt can be followed by a
 *    transaction from any tab;
 *  - nothing the agent can write (runtime config, tool arguments) counts as
 *    the operator's word. Only the server entry and the CLI do.
 */
import type { Page } from 'playwright';
import { RigError, type Args, type PopupGate, type PromptInfo, type RigState } from '../types.js';
import { config, networkIsLocked } from '../config.js';
import { KNOWN_MAINNETS, classify as classifyChain, registry, spendsRealMoney } from '../chains.js';
import { readState } from './state.js';
import { classify } from './browser.js';
import { readPrompt } from '../metamask/prompt.js';
import { bool } from '../args.js';

/**
 * Chains the operator has vouched for: `network allow` from the CLI, plus a
 * network fixed in the server entry (argv or env). A network chosen at runtime
 * through config.json is NOT vouched, since the agent can write that itself.
 */
export function allowedChains(): number[] {
  const allowed = [...(readState().allowedChains ?? [])];
  const cfg = config();
  if (networkIsLocked() && cfg.network?.chainId !== undefined) allowed.push(cfg.network.chainId);
  return allowed;
}

/** The configured RPC, only when the operator fixed it and it belongs to this chain. */
export function trustedRpcFor(chainId: number): string | undefined {
  const cfg = config();
  return networkIsLocked() && cfg.network?.chainId === chainId ? cfg.network.rpcUrl : undefined;
}

/** Display names MetaMask 13.48 ships for its built-in networks. */
export const METAMASK_BUILTIN: ReadonlyMap<string, number> = new Map([
  ['ethereum mainnet', 1],
  ['sepolia', 11155111],
  ['linea mainnet', 59144],
  ['linea sepolia', 59141],
  ['base mainnet', 8453],
  ['op mainnet', 10],
  ['arbitrum one', 42161],
  ['polygon mainnet', 137],
  ['bnb chain', 56],
  ['avalanche network c-chain', 43114],
  ['zksync era mainnet', 324],
  ['sei mainnet', 1329],
  ['monad testnet', 10143],
  ['megaeth testnet', 6342],
  ['localhost 8545', 1337],
]);

/**
 * Map the network name shown on a request to a chain id. Sources, in order:
 * networks the rig itself added (their names are what MetaMask displays),
 * MetaMask's built-ins, the well-known mainnets, then the public registry.
 * Unknown names stay unknown: the gate refuses rather than guesses.
 */
export async function resolveNetworkName(
  name: string,
  networks: NonNullable<RigState['networks']> = readState().networks ?? [],
): Promise<number | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  for (const n of networks) {
    if (n.name.trim().toLowerCase() === key) return Number(BigInt(n.chainId));
  }
  const builtin = METAMASK_BUILTIN.get(key);
  if (builtin !== undefined) return builtin;
  for (const [id, label] of KNOWN_MAINNETS) if (label.toLowerCase() === key) return id;
  const hit = (await registry()).find((c) => c.name?.trim().toLowerCase() === key);
  return hit ? hit.chainId : null;
}

/** Refuse unless `chainId` is provably a test or local chain, or the operator vouched. */
export async function assertChainAllowed(chainId: number | null, args: Args = {}, unknownWhy?: string): Promise<void> {
  const cfg = config();
  // `force` never reaches here from the MCP surface; it is a CLI escape hatch.
  if (cfg.allowMainnet || bool(args, 'force')) return;
  if (chainId === null) {
    throw new RigError(
      'CHAIN_UNKNOWN',
      `${unknownWhy ?? 'cannot tell which chain this request is on'}, so refusing to auto-approve. Add the network through the rig (rig_wallet add_network) so it learns the name, or start the server with --allow-mainnet.`,
    );
  }
  const verdict = await classifyChain(chainId, trustedRpcFor(chainId), allowedChains());
  if (!spendsRealMoney(verdict)) return;
  throw new RigError(
    'CHAIN_NOT_ALLOWED',
    `refusing to auto-approve on chain ${chainId}${verdict.name ? ` (${verdict.name})` : ''}: ${verdict.why}. If this chain is safe to automate, vouch for it from the CLI with "./bin/rig network allow ${chainId}", fix it in the server entry (--chain-id/--rpc-url or RIG_CHAIN_ID/RIG_RPC_URL), or start the server with --allow-mainnet.`,
    { chainId, verdict },
  );
}

/**
 * The network the rig itself is adding right now, if any. An add-network
 * prompt is exempt from the gate only while it matches this: a site could
 * otherwise add a real-money chain under a testnet's name and every later
 * transaction prompt on it would read as that testnet.
 */
let expectedAdd: { name: string; rpcHost: string } | null = null;
export function expectNetworkAdd(spec: { name: string; rpcUrl: string } | null): void {
  if (!spec) {
    expectedAdd = null;
    return;
  }
  let host = '';
  try {
    host = new URL(spec.rpcUrl).host.toLowerCase();
  } catch {
    host = '';
  }
  expectedAdd = { name: spec.name.trim().toLowerCase(), rpcHost: host };
}

function isRigInitiatedAdd(prompt: PromptInfo): boolean {
  if (!expectedAdd) return false;
  return (
    prompt.network?.trim().toLowerCase() === expectedAdd.name && prompt.rpcHost?.toLowerCase() === expectedAdd.rpcHost
  );
}

/**
 * Kinds that move no value on their own. Switching network is always free.
 * Adding or updating a network is free only when the rig asked for it (see
 * expectNetworkAdd); 13.x draws that prompt on the same redesigned page as
 * transactions, so it classifies as `tx-or-sign` and must be told apart here.
 */
function exempt(prompt: PromptInfo): boolean {
  if (prompt.kind === 'connect' || prompt.kind === 'unlock') return true;
  if (prompt.kind === 'confirmation' && prompt.isSwitchPrompt) return true;
  if (!prompt.isNetworkPrompt) return false;
  if (isRigInitiatedAdd(prompt)) return true;
  throw new RigError(
    'NETWORK_ADD_REFUSED',
    'a site is asking to add or update a network; the rig only approves network changes it made itself. Add it with rig_wallet add_network (or rig_network use) and retry.',
  );
}

/** A gate for one approval run. Every gated request is judged from its own page. */
export function chainGate(args: Args = {}): PopupGate {
  return async (prompt) => {
    if (exempt(prompt)) return;
    if (!prompt.network) {
      await assertChainAllowed(null, args, 'the request page does not show which network it is on');
      return;
    }
    const chainId = await resolveNetworkName(prompt.network);
    if (chainId === null) {
      await assertChainAllowed(null, args, `the request is on a network named "${prompt.network}" that the rig cannot map to a chain id`);
      return;
    }
    await assertChainAllowed(chainId, args);
  };
}

/**
 * Wallet routes that are settings, not requests. Their forms reuse the legacy
 * footer button, so they would otherwise classify as a prompt. Anything not
 * listed here stays gated: the failure mode is a refused click, never a
 * confirmed transaction. Exported for tests.
 */
const SETTINGS_ROUTES = [
  '/networks',
  '/settings',
  '/permissions',
  '/review-permissions',
  '/account-list',
  '/multichain-account',
  '/new-account',
  '/unlock',
  '/onboarding',
];

export function isSettingsRoute(url: string): boolean {
  let hash: string;
  try {
    hash = new URL(url).hash.replace(/^#/, '');
  } catch {
    return false;
  }
  if (hash === '' || hash === '/') return true;
  return SETTINGS_ROUTES.some((r) => hash === r || hash.startsWith(`${r}/`) || hash.startsWith(`${r}?`));
}

/**
 * Direct page actions on a wallet page (a click at coordinates, a keypress,
 * a typed newline) can confirm a request just as `approve` does, so they pass
 * the same gate. Any extension page counts: home.html and popup.html carry the
 * same confirmation routes as notification.html.
 */
export async function guardPopupAction(page: Page, args: Args = {}): Promise<void> {
  const kind = classify(page);
  if (kind !== 'popup' && kind !== 'mm') return;
  if (kind === 'mm' && isSettingsRoute(page.url())) return;
  const prompt = await readPrompt(page);
  // A wallet page with no request on it has nothing to confirm.
  if (prompt.kind === 'unknown') return;
  await chainGate(args)(prompt, page);
}
