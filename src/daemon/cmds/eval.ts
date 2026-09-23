/** Script evaluation in a page, and reading a fired request's outcome back. */
import { RigError, type Args, type CmdResult } from '../../types.js';
import { bool, str } from '../../args.js';
import { newReqId } from '../../util.js';
import { target } from './nav.js';

export async function cmdEval(args: Args): Promise<CmdResult> {
  const page = target(args);
  const code = str(args, 'value') ?? str(args, 'js');
  if (!code) throw new RigError('BAD_ARGS', 'eval needs code');

  if (bool(args, 'fire')) {
    // Same bridge and id scheme as provider requests, so `result` reads either.
    const reqId = newReqId();
    await page.evaluate(
      ([src, id]) => {
        const w = window as unknown as { __rig?: Record<string, unknown> };
        w.__rig = w.__rig ?? {};
        const rig = w.__rig;
        rig[id] = { done: false };
        void (async () => {
          try {
            // eslint-disable-next-line no-eval
            const value = await (0, eval)(src);
            rig[id] = { done: true, value };
          } catch (e) {
            rig[id] = { done: true, error: String(e) };
          }
        })();
      },
      [code, reqId] as [string, string],
    );
    return { reqId, fired: true };
  }

  const value = await page.evaluate((src) => (0, eval)(src), code);
  return { value: value as unknown };
}

export async function cmdResult(args: Args): Promise<CmdResult> {
  const page = target(args);
  const reqId = str(args, 'value') ?? str(args, 'id');
  if (!reqId) throw new RigError('BAD_ARGS', 'result needs a reqId');
  const value = await page.evaluate((id) => {
    const w = window as unknown as { __rig?: Record<string, unknown> };
    return (w.__rig ?? {})[id] ?? null;
  }, reqId);
  if (value === null) throw new RigError('NO_REQ', `no pending request ${reqId} on this page`);
  return value as CmdResult;
}
