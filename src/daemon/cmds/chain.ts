/** chain.* commands: read chain state, and on a local node, manipulate it. */
import { RigError, type Args, type CmdResult } from '../../types.js';
import { num, str } from '../../args.js';
import { isHttpUrl } from '../../util.js';
import * as chain from '../../chain.js';
import { env, readState } from '../state.js';
import { config } from '../../config.js';

/** The RPC a chain command should talk to: explicit, else configured, else the last one added. */
export function activeRpc(args: Args): string {
  const explicit = str(args, 'rpc');
  if (explicit) return explicit;
  const fallback = env('RIG_RPC_URL', '') || config().network?.rpcUrl;
  if (fallback) return fallback;
  const last = (readState().networks ?? []).at(-1);
  if (last) return last.rpc;
  throw new RigError('NO_RPC', 'no RPC to talk to; pass rpc, or add a network to the wallet first');
}

function addressArg(args: Args, what: string): string {
  const addr = str(args, 'value') ?? str(args, 'address') ?? readState().importedAddress;
  if (!addr) throw new RigError('BAD_ARGS', `chain ${what} needs an address`);
  return addr;
}

const commands: Record<string, (url: string, args: Args) => Promise<CmdResult>> = {
  info: (url) => chain.chainInfo(url),
  balance: (url, args) => chain.balance(url, addressArg(args, 'balance')),
  snapshot: async (url) => ({ id: await chain.snapshot(url) }),
  revert: async (url, args) => {
    const id = str(args, 'value') ?? str(args, 'id');
    if (!id) throw new RigError('BAD_ARGS', 'chain revert needs a snapshot id');
    return { reverted: await chain.revert(url, id) };
  },
  fund: async (url, args) => {
    const addr = addressArg(args, 'fund');
    // `doge` is the historical name of the amount argument; `amount` works too.
    await chain.fund(url, addr, num(args, 'amount', num(args, 'doge', 1000)));
    return chain.balance(url, addr);
  },
  mine: async (url, args) => ({ mined: await chain.mine(url, num(args, 'blocks', num(args, 'value', 1))) }),
};

export async function chainCmd(sub: string, args: Args): Promise<CmdResult> {
  const fn = commands[sub];
  if (!fn) throw new RigError('UNKNOWN_CMD', `unknown chain subcommand: ${sub}`);
  const url = activeRpc(args);
  if (!isHttpUrl(url)) throw new RigError('BAD_ARGS', `rpc must be an http(s) URL: ${url}`);
  return fn(url, args);
}
