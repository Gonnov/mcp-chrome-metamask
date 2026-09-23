/**
 * Layered configuration, most specific wins:
 *   launch arguments  >  environment  >  persisted config  >  built-in default
 *
 * Launch arguments and environment come from the MCP client's own server entry,
 * which is the one mechanism every client supports. The persisted layer exists
 * so a user can choose a network once at runtime instead of editing that entry.
 * Only the first two layers count as the operator's word: the persisted layer
 * can be written by the agent, so nothing safety-relevant trusts it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RigError } from './types.js';
import { RIG_DIR, ensureDirs, loadEnv, writeJsonAtomic } from './daemon/state.js';
import { parseChainId } from './chains.js';
import { isHttpUrl } from './util.js';

export const CONFIG_FILE = resolve(RIG_DIR, 'config.json');

export interface NetworkConfig {
  chainId: number;
  rpcUrl: string;
  /** Both optional: filled from the public chain registry when not given. */
  name?: string;
  symbol?: string;
  explorer?: string;
}

export interface RigConfig {
  /** Network the wallet should be on. */
  network?: NetworkConfig;
  /** Default URL for the app under test, used when a tool omits one. */
  appUrl?: string;
  /** Run the browser without a window. */
  headless?: boolean;
  /** Allow auto-approval on chains that look like mainnets. */
  allowMainnet?: boolean;
  /** Where to read a burner key from, if the operator chose a file. */
  privateKeyFile?: string;
}

/** Parsed once from argv at process start. */
let launchArgs: RigConfig = {};

export function setLaunchArgs(config: RigConfig): void {
  launchArgs = config;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Build a network entry from loosely typed input, or return null when it is unusable. */
function toNetwork(raw: unknown): NetworkConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rpcUrl = r['rpcUrl'];
  if (!isHttpUrl(rpcUrl)) return null;
  let chainId: number;
  try {
    chainId = parseChainId(r['chainId'] as string | number);
  } catch {
    return null;
  }
  const name = optStr(r['name']);
  const symbol = optStr(r['symbol']);
  const explorer = optStr(r['explorer']);
  return {
    chainId,
    rpcUrl,
    ...(name ? { name } : {}),
    ...(symbol ? { symbol } : {}),
    ...(explorer ? { explorer } : {}),
  };
}

/** The persisted layer, shape-checked: a hand-edited file cannot smuggle in bad types. */
export function readConfigFile(): RigConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: RigConfig = {};
  const network = toNetwork(r['network']);
  if (network) out.network = network;
  const appUrl = optStr(r['appUrl']);
  if (appUrl) out.appUrl = appUrl;
  if (r['headless'] === true) out.headless = true;
  if (r['allowMainnet'] === true) out.allowMainnet = true;
  const keyFile = optStr(r['privateKeyFile']);
  if (keyFile) out.privateKeyFile = keyFile;
  return out;
}

export function writeConfigFile(patch: Partial<RigConfig>): RigConfig {
  ensureDirs();
  const next = { ...readConfigFile(), ...patch };
  writeJsonAtomic(CONFIG_FILE, next, { backup: true });
  return next;
}

function fromEnv(): RigConfig {
  const env = loadEnv();
  const out: RigConfig = {};
  const chainId = env['RIG_CHAIN_ID'];
  const rpcUrl = env['RIG_RPC_URL'];
  if (rpcUrl && chainId) {
    if (!isHttpUrl(rpcUrl)) throw new RigError('BAD_ARGS', `RIG_RPC_URL is not an http(s) URL: ${rpcUrl}`);
    out.network = {
      chainId: parseChainId(chainId),
      rpcUrl,
      ...(env['RIG_NETWORK_NAME'] ? { name: env['RIG_NETWORK_NAME'] } : {}),
      ...(env['RIG_NATIVE_SYMBOL'] ? { symbol: env['RIG_NATIVE_SYMBOL'] } : {}),
      ...(env['RIG_EXPLORER_URL'] ? { explorer: env['RIG_EXPLORER_URL'] } : {}),
    };
  }
  if (env['RIG_APP_URL']) out.appUrl = env['RIG_APP_URL'];
  if (env['RIG_HEADLESS'] === '1') out.headless = true;
  if (env['RIG_ALLOW_MAINNET'] === '1') out.allowMainnet = true;
  if (env['RIG_KEY_FILE']) out.privateKeyFile = env['RIG_KEY_FILE'];
  return out;
}

/** The effective configuration after layering. */
export function config(): RigConfig {
  const persisted = readConfigFile();
  const env = fromEnv();
  const merged: RigConfig = { ...persisted, ...env, ...launchArgs };
  const network = launchArgs.network ?? env.network ?? persisted.network;
  if (network) merged.network = network;
  else delete merged.network;
  return merged;
}

/** Flags understood on the command line of both the MCP server and the daemon. */
export function parseLaunchArgs(argv: string[]): RigConfig {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    // A flag with no value must not swallow the next flag as its value.
    if (value === undefined || value.startsWith('--')) {
      throw new RigError('BAD_ARGS', `${flag} needs a value`);
    }
    return value;
  };
  const chainId = get('--chain-id');
  const rpcUrl = get('--rpc-url');
  const cfg: RigConfig = {};
  if (chainId && rpcUrl) {
    if (!isHttpUrl(rpcUrl)) throw new RigError('BAD_ARGS', `--rpc-url is not an http(s) URL: ${rpcUrl}`);
    cfg.network = {
      chainId: parseChainId(chainId),
      rpcUrl,
      ...(get('--network-name') ? { name: get('--network-name') as string } : {}),
      ...(get('--symbol') ? { symbol: get('--symbol') as string } : {}),
      ...(get('--explorer') ? { explorer: get('--explorer') as string } : {}),
    };
  } else if (chainId || rpcUrl) {
    throw new RigError('BAD_ARGS', '--chain-id and --rpc-url must be given together');
  }
  const appUrl = get('--app-url');
  if (appUrl) cfg.appUrl = appUrl;
  const keyFile = get('--key-file');
  if (keyFile) cfg.privateKeyFile = keyFile;
  if (argv.includes('--headless')) cfg.headless = true;
  if (argv.includes('--allow-mainnet')) cfg.allowMainnet = true;
  return cfg;
}

/** Re-emit the flags so a child process inherits the same configuration. */
export function launchArgsToArgv(cfg: RigConfig): string[] {
  const out: string[] = [];
  if (cfg.network) {
    out.push('--chain-id', String(cfg.network.chainId));
    out.push('--rpc-url', cfg.network.rpcUrl);
    if (cfg.network.name) out.push('--network-name', cfg.network.name);
    if (cfg.network.symbol) out.push('--symbol', cfg.network.symbol);
    if (cfg.network.explorer) out.push('--explorer', cfg.network.explorer);
  }
  if (cfg.appUrl) out.push('--app-url', cfg.appUrl);
  if (cfg.privateKeyFile) out.push('--key-file', cfg.privateKeyFile);
  if (cfg.headless) out.push('--headless');
  if (cfg.allowMainnet) out.push('--allow-mainnet');
  return out;
}

/**
 * True when the network was fixed at launch (argv or env), so runtime switching
 * is refused. This is also what makes the configured chain count as vouched.
 */
export function networkIsLocked(): boolean {
  return launchArgs.network !== undefined || fromEnv().network !== undefined;
}
