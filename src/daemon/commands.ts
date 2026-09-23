/** The page-level command table, by name. Each entry lives in cmds/. */
import type { Args, CmdResult } from '../types.js';
import { cmdClose, cmdGoto, cmdPages, cmdResize, cmdUse } from './cmds/nav.js';
import { cmdAria, cmdConsole, cmdFind, cmdOcr, cmdShot } from './cmds/look.js';
import { cmdClick, cmdPress, cmdScroll, cmdType } from './cmds/act.js';
import { cmdWait } from './cmds/wait.js';
import { cmdEval, cmdResult } from './cmds/eval.js';

export const generic: Record<string, (a: Args) => Promise<CmdResult>> = {
  resize: cmdResize,
  console: cmdConsole,
  close: cmdClose,
  pages: cmdPages,
  use: cmdUse,
  goto: cmdGoto,
  shot: cmdShot,
  ocr: cmdOcr,
  aria: cmdAria,
  find: cmdFind,
  click: cmdClick,
  type: cmdType,
  press: cmdPress,
  scroll: cmdScroll,
  wait: cmdWait,
  eval: cmdEval,
  result: cmdResult,
};

export { allowedUrl } from './cmds/nav.js';
export { shotPath } from './cmds/look.js';
