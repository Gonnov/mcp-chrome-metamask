/** mm.* commands: everything that drives MetaMask. */
import { privateKeyToAccount } from 'viem/accounts';
import { RigError, type Args, type CmdResult } from '../../types.js';
import { sleep } from '../../util.js';
import { bool, str } from '../../args.js';
import { popupPages } from '../browser.js';
import { env, readState, writeState } from '../state.js';
import { config } from '../../config.js';
import { DEFAULT_MM_VERSION, assertVersion, fetchAuto, fetchFromBrowser, fetchFromGithub } from '../../metamask/fetch.js';
import { closeNotification, ensureNotification, listPopups } from '../../metamask/notification.js';
import { readPrompt } from '../../metamask/prompt.js';
import { approve, drain, reject } from '../../metamask/act.js';
import { ensureUnlocked, lastLockState, noteLockState, unlockAnywhere } from '../../metamask/unlock.js';
import { findPrivateKey, importKey, onboard, readPrivateKey, selectAccount } from '../../metamask/onboard.js';
import { ethAccounts, ethChainIdHex, existingAppPage, pageOrigin, providerPage, requestWithApproval } from '../../metamask/provider.js';
import { checksum, readAddress } from '../../metamask/account.js';
import { withHome } from '../../metamask/ui.js';
import { walletFacts } from '../../metamask/background.js';
import { uiFacts, waitUiFacts } from '../../metamask/uistate.js';
import { shown } from '../../metamask/dom.js';
import { UNLOCK } from '../../metamask/selectors.js';
import { chainGate } from '../gate.js';
import { mmHomePage } from './session.js';
import { addNetworkHere, hasNetworkSpec, networkSpec } from './network.js';

const ARGV_KEY_WARNING =
  'this key was passed on the command line, so it is readable by other processes of this user and is in your shell history. Use it for throwaway accounts only.';

function keyFromArgs(args: Args): { key: string | null; fromArgv: boolean } {
  return {
    key: findPrivateKey(str(args, 'env-file'), str(args, 'var'), str(args, 'key_file'), str(args, 'pkey')),
    fromArgv: str(args, 'pkey') !== undefined,
  };
}

function isHexKey(key: string): key is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(key);
}

function addressOf(key: string): string {
  if (!isHexKey(key)) throw new RigError('BAD_ARGS', 'the private key must be 32 bytes of hex, optionally 0x-prefixed');
  return privateKeyToAccount(key).address;
}

/** `params` for mm.request: a JSON array, given as an array or its text. */
function paramsArg(args: Args): unknown[] {
  const raw = args['params'];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new RigError('BAD_ARGS', `params is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new RigError('BAD_ARGS', 'params must be a JSON array');
    return parsed;
  }
  throw new RigError('BAD_ARGS', 'params must be a JSON array');
}

async function approveCmd(args: Args): Promise<CmdResult> {
  const gate = chainGate(args);
  const page = await ensureNotification();
  const unlocked = await ensureUnlocked(page);
  const prompt = await readPrompt(page);
  if (prompt.kind === 'unknown') {
    await closeNotification();
    return { nothingPending: true, ...(unlocked ? { unlocked } : {}) };
  }
  if (bool(args, 'all')) {
    try {
      return { actions: await drain(approve, { gate }) };
    } finally {
      await closeNotification();
    }
  }
  // Single approval: read, gate, then click, on the same page.
  await gate(prompt, page);
  const result = await approve(page, prompt);
  if (!bool(args, 'keep')) await closeNotification();
  return { ...result };
}

async function rejectCmd(args: Args): Promise<CmdResult> {
  if (bool(args, 'all')) {
    try {
      return { actions: await drain(reject) };
    } finally {
      await closeNotification();
    }
  }
  const page = await ensureNotification();
  await ensureUnlocked(page);
  const prompt = await readPrompt(page);
  if (prompt.kind === 'unknown') return { nothingPending: true };
  const result = await reject(page, prompt);
  await closeNotification();
  return { ...result };
}

/**
 * Whether the wallet is locked, as cheaply as can be told truthfully: an open
 * request page says so itself; otherwise the last state the rig saw holds
 * while MetaMask's auto-lock cannot have fired since (it is off by default);
 * otherwise home is opened briefly and looked at, without unlocking it.
 */
async function lockedNow(autoLockMinutes: number | null, keep: boolean): Promise<{ locked: boolean; lockedFrom: string }> {
  const openPopup = popupPages().at(-1);
  const fromPopup = openPopup ? await uiFacts(openPopup) : null;
  if (fromPopup) return { locked: !fromPopup.unlocked, lockedFrom: 'popup' };
  const seen = lastLockState();
  const fresh = autoLockMinutes === 0 || (autoLockMinutes !== null && seen !== null && Date.now() - seen.at < autoLockMinutes * 60_000);
  if (seen && fresh) return { locked: !seen.unlocked, lockedFrom: 'tracked' };
  const locked = await withHome(
    mmHomePage,
    async (home) => {
      const facts = await waitUiFacts(home, 5000);
      if (facts) noteLockState(facts.unlocked);
      return facts ? !facts.unlocked : shown(home, UNLOCK.password, 800);
    },
    { keep, unlock: false },
  );
  return { locked, lockedFrom: 'home' };
}

async function statusCmd(args: Args): Promise<CmdResult> {
  const state = readState();
  const facts = await walletFacts();
  const { locked, lockedFrom } = await lockedNow(facts?.autoLockMinutes ?? null, bool(args, 'keep'));
  // The wallet's own record of the selected account; the state file is only
  // a fallback, and is corrected when it disagrees.
  const selected = facts?.selected ? await checksum(facts.selected) : undefined;
  if (selected && state.walletAddress !== selected) writeState({ walletAddress: selected });
  // What the site under test sees, when one is open.
  const page = existingAppPage();
  const address = selected ?? state.walletAddress ?? state.importedAddress;
  return {
    locked,
    lockedFrom,
    provider: page ? 'app' : 'none',
    ...(page ? { origin: pageOrigin(page) } : {}),
    accounts: page ? await ethAccounts(page) : [],
    chainId: page ? await ethChainIdHex(page) : null,
    address,
    addressFrom: selected ? 'wallet' : 'state',
    ...(facts ? { walletAccounts: facts.accounts.length } : {}),
    onboarded: state.onboarded ?? false,
    importedAddress: state.importedAddress,
    walletAddress: selected ?? state.walletAddress,
    popups: await listPopups(),
  };
}

async function setupCmd(args: Args): Promise<CmdResult> {
  await (await mmHomePage()).bringToFront().catch(() => undefined);
  const dry = bool(args, 'dry');
  const result = await onboard(mmHomePage, dry);
  if (dry || result['onboarded'] !== true || bool(args, 'no-import')) return result;

  const { key, fromArgv } = keyFromArgs(args);
  let imported: CmdResult = { imported: false, reason: 'no burner key given' };
  if (key) {
    imported = await importKey(mmHomePage, key, addressOf(key));
    if (fromArgv) imported['warning'] = ARGV_KEY_WARNING;
  }

  // Arguments win, but a network configured at launch should not need repeating.
  const configured = config().network;
  const spec = hasNetworkSpec(args)
    ? await networkSpec(args)
    : configured
      ? await networkSpec({
          chain_id: String(configured.chainId),
          rpc_url: configured.rpcUrl,
          ...(configured.name ? { name: configured.name } : {}),
          ...(configured.symbol ? { symbol: configured.symbol } : {}),
          ...(configured.explorer ? { explorer: configured.explorer } : {}),
        })
      : null;
  // A refused chain is reported, not hidden: the operator must see the code.
  const network = spec
    ? await addNetworkHere(spec, args).catch((e: unknown) => {
        const err = RigError.wrap(e);
        return { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
      })
    : { skipped: 'no network configured; add one with wallet add_network' };

  // A generated wallet is useless until funded, so surface its address, read
  // from the wallet itself: no site needs to be open for that.
  let address = imported['address'] as string | undefined;
  let addressShort: string | undefined;
  let note: string | undefined;
  if (!address) {
    const read = await readAddress(mmHomePage).catch(() => null);
    address = read?.address;
    addressShort = read?.addressShort;
    note = read?.note;
  }
  return {
    ...result,
    imported,
    network,
    address,
    ...(addressShort && !address ? { addressShort, note } : {}),
    ...(key || !address ? {} : { fundThisAddress: address }),
  };
}

const commands: Record<string, (args: Args) => Promise<CmdResult>> = {
  async fetch(args) {
    const force = bool(args, 'force');
    const version = str(args, 'version');
    if (version) return fetchFromGithub(version, force);
    if (bool(args, 'from-brave')) return fetchFromBrowser(force);
    const pinned = env('RIG_MM_VERSION', DEFAULT_MM_VERSION);
    assertVersion(pinned);
    return fetchAuto(pinned, force);
  },
  async home() {
    const page = await mmHomePage();
    await page.bringToFront().catch(() => undefined);
    return { url: page.url() };
  },
  async popups() {
    return { popups: await listPopups() };
  },
  async address() {
    // The selected account, read from the wallet's own UI; no site needed.
    const read = await readAddress(mmHomePage);
    return { ...read, importedAddress: readState().importedAddress };
  },
  unlock: () => unlockAnywhere(),
  approve: approveCmd,
  reject: rejectCmd,
  async pending() {
    const page = await ensureNotification();
    const prompt = await readPrompt(page);
    const pending = prompt.kind !== 'unknown';
    if (!pending) await closeNotification();
    return { pending, ...(pending ? { kind: prompt.kind, network: prompt.network, origin: prompt.origin } : {}) };
  },
  status: statusCmd,
  onboard: setupCmd,
  setup: setupCmd,
  async 'import-key'(args) {
    await (await mmHomePage()).bringToFront().catch(() => undefined);
    const key = readPrivateKey(str(args, 'env-file'), str(args, 'var'), str(args, 'key_file'), str(args, 'pkey'));
    const result = await importKey(mmHomePage, key, addressOf(key));
    if (str(args, 'pkey')) result['warning'] = ARGV_KEY_WARNING;
    return result;
  },
  // Make an already-imported account the wallet's selected one (a key can be
  // imported once; a second proof run on the same profile must switch instead).
  async select(args) {
    const address = str(args, 'address') ?? str(args, 'value');
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new RigError('BAD_ARGS', 'mm select needs --address 0x… (40 hex digits)');
    // Done on the wallet's home page, closed again afterwards like every
    // other look at it: an extension page left open suppresses prompts.
    const selected = await withHome(mmHomePage, (home) => selectAccount(home, address));
    // `active` is the wallet's own answer after the switch, so the caller can
    // see at once whether it took, instead of trusting `selected`.
    // The worker persists the switch a moment after the page shows it; wait
    // for that too, so a stop right after cannot lose it.
    let read = await readAddress(mmHomePage);
    for (let deadline = Date.now() + 5000; selected && read.source === 'wallet' && Date.now() < deadline; ) {
      if (read.address?.toLowerCase() === address.toLowerCase()) break;
      await sleep(200);
      read = await readAddress(mmHomePage);
    }
    const active = read.address ?? read.addressShort ?? null;
    return { address, selected, active, activeSource: read.source };
  },
  async 'add-network'(args) {
    return addNetworkHere(await networkSpec(args), args);
  },
  async connect(args) {
    const page = providerPage(args);
    const existing = await ethAccounts(page);
    if (existing.length > 0) return { alreadyConnected: true, origin: pageOrigin(page), accounts: existing };
    return requestWithApproval(page, 'eth_requestAccounts', [], chainGate(args));
  },
  async request(args) {
    const method = str(args, 'value') ?? str(args, 'method');
    if (!method) throw new RigError('BAD_ARGS', 'mm request needs a method');
    // Whatever the method, each prompt it raises goes through the gate.
    return requestWithApproval(providerPage(args), method, paramsArg(args), chainGate(args));
  },
};

export async function walletCmd(sub: string, args: Args): Promise<CmdResult> {
  const fn = commands[sub];
  if (!fn) throw new RigError('UNKNOWN_CMD', `unknown mm subcommand: ${sub}`);
  return fn(args);
}
