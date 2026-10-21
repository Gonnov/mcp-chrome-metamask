/**
 * The rig's command line, as data: the option table and the parser from argv
 * to the daemon's command name and argument bag. Shared by the CLI and by run
 * scripts, so a script line means exactly what it would on the command line.
 */
import { parseArgs } from 'node:util';

export const options = {
  target: { type: 'string' },
  out: { type: 'string' },
  sel: { type: 'string' },
  role: { type: 'string' },
  name: { type: 'string' },
  text: { type: 'string' },
  id: { type: 'string' },
  xy: { type: 'string' },
  url: { type: 'string' },
  key: { type: 'string' },
  version: { type: 'string' },
  params: { type: 'string' },
  'env-file': { type: 'string' },
  'chain_id': { type: 'string' },
  'rpc_url': { type: 'string' },
  'chain-id': { type: 'string' },
  'rpc-url': { type: 'string' },
  symbol: { type: 'string' },
  explorer: { type: 'string' },
  'key-file': { type: 'string' },
  pkey: { type: 'string' },
  var: { type: 'string' },
  address: { type: 'string' },
  ms: { type: 'string' },
  dy: { type: 'string' },
  dx: { type: 'string' },
  nth: { type: 'string' },
  fuzzy: { type: 'string' },
  grid: { type: 'string' },
  psm: { type: 'string' },
  'min-conf': { type: 'string' },
  'popup-ms': { type: 'string' },
  steps: { type: 'string' },
  timeout: { type: 'string' },
  doge: { type: 'string' },
  amount: { type: 'string' },
  blocks: { type: 'string' },
  delay: { type: 'string' },
  annotate: { type: 'boolean' },
  full: { type: 'boolean' },
  fire: { type: 'boolean' },
  popup: { type: 'boolean' },
  'popup-gone': { type: 'boolean' },
  all: { type: 'boolean' },
  dry: { type: 'boolean' },
  force: { type: 'boolean' },
  headless: { type: 'boolean' },
  daemon: { type: 'boolean' },
  'from-brave': { type: 'boolean' },
  'no-import': { type: 'boolean' },
  clear: { type: 'boolean' },
  keep: { type: 'boolean' },
  n: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  help: { type: 'boolean' },
} as const;

export interface Command {
  cmd: string;
  args: Record<string, unknown>;
}

/** argv (without the program) to the daemon's command name and argument bag. */
export function toCommand(argv: string[]): Command {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: false });
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) args[k] = v;
  const cmd = positionals[0] ?? '';
  // Sub-commanded groups keep their own verb, e.g. `mm approve` -> `mm.approve`.
  if (cmd === 'mm' || cmd === 'chain' || cmd === 'network') {
    const sub = positionals[1];
    if (!sub) throw new Error(`${cmd} needs a subcommand`);
    if (positionals[2] !== undefined) args['value'] = positionals[2];
    return { cmd: `${cmd}.${sub}`, args };
  }
  if (positionals[1] !== undefined) args['value'] = positionals[1];
  return { cmd, args };
}
