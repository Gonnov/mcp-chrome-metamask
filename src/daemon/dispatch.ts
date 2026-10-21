/**
 * The daemon's command router. Browser work is serialised on one mutex so
 * screenshots never race clicks; `status` stays outside it (it is the
 * liveness probe) and `chain.*` never touches the browser.
 */
import { RigError, type Args, type CmdResult } from '../types.js';
import { toErrorBody } from '../util.js';
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
  if (cmd === 'run') return run(args);
  if (cmd.startsWith('mm.')) return serialize(() => walletCmd(cmd.slice(3), args));
  if (cmd.startsWith('network.')) return serialize(() => networkCmd(cmd.slice(8), args));
  if (cmd.startsWith('chain.')) return chainCmd(cmd.slice(6), args);

  const fn = generic[cmd];
  if (!fn) throw new RigError('UNKNOWN_CMD', `unknown command: ${cmd}`);
  return serialize(() => fn(args));
}

/** Commands a run may not contain: they end the session or would recurse. */
const NOT_IN_RUN = new Set(['run', 'stop', 'boot']);

export interface RunStep {
  cmd: string;
  args: Args;
  /** A failing optional step is reported and the run goes on. */
  optional: boolean;
}

/** Shape-check the `steps` array: each item is `{ cmd, optional?, ...args }`. */
export function parseSteps(raw: unknown): RunStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RigError('BAD_ARGS', 'run needs a non-empty steps array');
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RigError('BAD_ARGS', `step ${i} is not an object`);
    }
    const { cmd, optional, ...args } = item as Record<string, unknown>;
    if (typeof cmd !== 'string' || !cmd) throw new RigError('BAD_ARGS', `step ${i} has no cmd`);
    if (NOT_IN_RUN.has(cmd)) throw new RigError('BAD_ARGS', `step ${i}: "${cmd}" cannot run inside a run`);
    return { cmd, args, optional: optional === true };
  });
}

/** A step failed when it threw, or when it answered ok: false (a wait that timed out). */
function stepFailed(result: CmdResult): boolean {
  return result['ok'] === false;
}

/**
 * Several commands in one request, in order, stopping at the first failure.
 * Each step takes the browser mutex on its own, exactly as a separate request
 * would, so a run is only a saving in round trips, never a different path.
 */
async function run(args: Args): Promise<CmdResult> {
  const steps = parseSteps(args['steps']);
  const started = Date.now();
  const done: CmdResult[] = [];
  for (const [i, step] of steps.entries()) {
    const t0 = Date.now();
    let entry: CmdResult;
    let failed: boolean;
    try {
      const result = await dispatch(step.cmd, step.args);
      failed = stepFailed(result);
      entry = { i, cmd: step.cmd, ms: Date.now() - t0, ...(failed ? { failed: true } : {}), result };
    } catch (err) {
      failed = true;
      entry = { i, cmd: step.cmd, ms: Date.now() - t0, failed: true, error: toErrorBody(err) };
    }
    done.push(entry);
    if (failed && !step.optional) {
      return { ok: false, failedAt: i, ran: done.length, total: steps.length, elapsedMs: Date.now() - started, steps: done };
    }
  }
  return { ok: true, ran: done.length, total: steps.length, elapsedMs: Date.now() - started, steps: done };
}

export { boot };
