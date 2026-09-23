/**
 * Deciding whether a chain spends real money.
 *
 * No registry answers this reliably. ethereum-lists carries no testnet flag at
 * all; viem's flag is undefined for roughly a third of its chains. So this
 * classifies from several weak signals and fails CLOSED: anything it cannot
 * positively identify as a test or local chain is treated as real money.
 *
 * The registry is fetched lazily and cached, rather than bundled, so the list
 * never goes stale and costs nothing to install.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RigError } from './types.js';
import { RIG_DIR, ensureDirs } from './daemon/state.js';

const REGISTRY_URL = 'https://chainid.network/chains_mini.json';
const CACHE_FILE = resolve(RIG_DIR, 'chains.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Chain ids used by local development nodes. Never trust the registry here. */
const LOCAL_CHAIN_IDS = new Set([31337, 1337, 539]);

/**
 * Chains that are real money no matter what the registry says about them. The
 * registry lists faucets for several of these, which is why faucets alone are
 * never taken as proof of a test network.
 */
export const KNOWN_MAINNETS: ReadonlyMap<number, string> = new Map([
  [1, 'Ethereum'],
  [10, 'OP Mainnet'],
  [25, 'Cronos'],
  [56, 'BNB Smart Chain'],
  [100, 'Gnosis'],
  [130, 'Unichain'],
  [137, 'Polygon'],
  [146, 'Sonic'],
  [204, 'opBNB'],
  [250, 'Fantom'],
  [324, 'zkSync Era'],
  [480, 'World Chain'],
  [1101, 'Polygon zkEVM'],
  [1284, 'Moonbeam'],
  [1329, 'Sei'],
  [2000, 'Dogechain'],
  [5000, 'Mantle'],
  [8453, 'Base'],
  [34443, 'Mode'],
  [42161, 'Arbitrum One'],
  [42220, 'Celo'],
  [43114, 'Avalanche C-Chain'],
  [59144, 'Linea'],
  [81457, 'Blast'],
  [534352, 'Scroll'],
  [7777777, 'Zora'],
]);

const TESTNET_NAME =
  /test ?net|devnet|sepolia|holesky|hoodi|goerli|staging|ropsten|rinkeby|kovan|mumbai|amoy|fuji|chiado|alfajores|baklava|shibuya|moonbase|cardona|hekla/i;

/** Parse a chain id given as decimal or 0x hex. Throws BAD_ARGS on anything else. */
export function parseChainId(value: string | number): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else {
    const s = value.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) n = Number(BigInt(s));
    else if (/^\d+$/.test(s)) n = Number(s);
    else throw new RigError('BAD_ARGS', `invalid chain id "${value}": expected a decimal or 0x-hex integer`);
  }
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new RigError('BAD_ARGS', `invalid chain id "${value}": must be a positive integer`);
  }
  return n;
}

export interface RegistryChain {
  chainId: number;
  name?: string;
  shortName?: string;
  faucets?: string[];
  nativeCurrency?: { symbol?: string };
  rpc?: string[];
}

interface Cache {
  fetchedAt: number;
  chains: RegistryChain[];
}

let memo: RegistryChain[] | null = null;

/** Tests inject a registry here instead of touching the network or the cache. */
export function primeRegistry(chains: RegistryChain[] | null): void {
  memo = chains;
}

function readCache(): Cache | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Cache;
  } catch {
    return null;
  }
}

/** Never throws: without the registry the guard simply gets more cautious. */
export async function registry(): Promise<RegistryChain[]> {
  if (memo) return memo;
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    memo = cached.chains;
    return memo;
  }
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chains = (await res.json()) as RegistryChain[];
    if (!Array.isArray(chains)) throw new Error('registry is not an array');
    ensureDirs();
    writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), chains }), { mode: 0o600 });
    memo = chains;
    return chains;
  } catch {
    memo = cached?.chains ?? [];
    return memo;
  }
}

export async function lookup(chainId: number): Promise<RegistryChain | undefined> {
  return (await registry()).find((c) => c.chainId === chainId);
}

/** Name and native symbol for a chain, when the public registry knows it. */
export async function describe(
  chainId: number,
): Promise<{ name?: string; symbol?: string }> {
  const entry = await lookup(chainId);
  if (!entry) return {};
  return {
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.nativeCurrency?.symbol ? { symbol: entry.nativeCurrency.symbol } : {}),
  };
}

export function isLocalRpc(rpcUrl: string | undefined): boolean {
  if (!rpcUrl) return false;
  try {
    const host = new URL(rpcUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export type ChainClass = 'local' | 'testnet' | 'real-money' | 'allowed';

export interface Verdict {
  chainId: number;
  klass: ChainClass;
  name?: string;
  why: string;
}

/**
 * Classify a chain. `allowed` lists chain ids the operator has vouched for,
 * which is the only way to clear a chain the registry does not recognise.
 *
 * Order: vouched, local RPC, local dev ids, known mainnets, then the registry.
 * A registry name that reads as a test network is the one positive signal; a
 * listed faucet on its own is not, since many mainnets list one.
 */
export async function classify(
  chainId: number,
  rpcUrl: string | undefined,
  allowed: number[],
): Promise<Verdict> {
  if (allowed.includes(chainId)) {
    return { chainId, klass: 'allowed', why: 'explicitly allowed by configuration' };
  }
  // Checked before the registry, which lists 31337 as "GoChain Testnet" and
  // 1337 as "Geth Testnet" with no faucets: real chains that share the ids
  // Anvil and Hardhat use locally.
  if (isLocalRpc(rpcUrl)) {
    return { chainId, klass: 'local', why: `RPC is a local node (${rpcUrl ?? ''})` };
  }
  if (LOCAL_CHAIN_IDS.has(chainId) && !rpcUrl) {
    return { chainId, klass: 'local', why: 'chain id is a development-node default' };
  }
  const mainnet = KNOWN_MAINNETS.get(chainId);
  if (mainnet) {
    return { chainId, klass: 'real-money', name: mainnet, why: `${mainnet} is a well-known mainnet` };
  }

  const entry = await lookup(chainId);
  const name = entry?.name;
  const label = `${entry?.name ?? ''} ${entry?.shortName ?? ''}`.trim();
  if (label && TESTNET_NAME.test(label)) {
    return { chainId, klass: 'testnet', ...(name ? { name } : {}), why: `registry name "${label}" reads as a test network` };
  }
  if (!entry) {
    return {
      chainId,
      klass: 'real-money',
      why: 'chain is not in the public registry, so it cannot be shown to be a test network',
    };
  }
  if (entry.faucets && entry.faucets.length > 0) {
    return {
      chainId,
      klass: 'real-money',
      ...(name ? { name } : {}),
      why: `registry entry "${entry.name ?? chainId}" lists faucets but its name does not read as a test network; faucets alone are not proof, so vouch for it explicitly if it is one`,
    };
  }
  return {
    chainId,
    klass: 'real-money',
    ...(name ? { name } : {}),
    why: `registry entry "${entry.name ?? chainId}" has no faucet and does not read as a test network`,
  };
}

export function spendsRealMoney(v: Verdict): boolean {
  return v.klass === 'real-money';
}
