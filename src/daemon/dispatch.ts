/**
 * The daemon's command router. Browser work is serialised on one mutex so
 * screenshots never race clicks; `status` stays outside it (it is the
 * liveness probe) and `chain.*` never touches the browser.
 */
import { RigError, type Args, type CmdResult } from '../types.js';
import { serialize } from './browser.js';
import { generic } from './commands.js';
import { boot, status, stop } from './cmds/session.js';
import { walletCmd } from './cmds/wallet.js';
import { networkCmd } from './cmds/network.js';
import { chainCmd } from './cmds/chain.js';

export async function dispatch(cmd: string, args: Args): Promise<CmdResult> {
  if (cmd === 'status') return status();
  if (cmd === 'boot') return serialize(() => boot());
  if (cmd === 'stop') return stop();
  if (cmd.startsWith('mm.')) return serialize(() => walletCmd(cmd.slice(3), args));
  if (cmd.startsWith('network.')) return serialize(() => networkCmd(cmd.slice(8), args));
  if (cmd.startsWith('chain.')) return chainCmd(cmd.slice(6), args);

  const fn = generic[cmd];
  if (!fn) throw new RigError('UNKNOWN_CMD', `unknown command: ${cmd}`);
  return serialize(() => fn(args));
}

export { boot };
