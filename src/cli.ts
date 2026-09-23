import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ensureDirs, readDaemon } from './daemon/state.js';
import { daemonSpawnArgs, ensureDaemon } from './launcher.js';

const HELP = `rig - drive a real Chrome with a real MetaMask

  serve [--headless] [--daemon]     start the browser daemon
  status | stop | pages | boot
  use <target>                      pin default target: app|popup|mm|active|<id>
  goto <url>
  shot [--out p] [--annotate] [--grid 100] [--full]
  ocr [--min-conf 60] [--psm 11]
  aria | find <text> [--role button]
  click --xy X,Y | --id N | --text "t" [--nth 0] [--fuzzy .8] | --sel css | --role r --name n
  type "text" [--sel css] | press <Key> | scroll [--dy 400]
  wait --ms N | --text t | --url u | --sel css | --popup | --popup-gone [--timeout 15000]
  eval "<js>" [--fire] | result <reqId>
  console [--n 60] [--clear] | close | resize [--width 1440] [--height 900]
  mm fetch [--from-brave] [--version 13.48.0]
  mm setup [--pkey 0x.. | --key-file p] [--dry] [--no-import]
  mm status | address | unlock | approve [--all] [--force] | reject [--all] | pending | popups | home
  mm connect | add-network | import-key [--pkey 0x.. | --key-file p]
  mm request <method> [--params '[]']
  chain info | balance [addr] | snapshot | revert <id> | fund [addr] [--amount N] | mine [--blocks N]
  network list | current | use --chain-id N --rpc-url U [--name] [--symbol]
  network allow <chainId> | disallow <chainId>   (operator only: vouch for a chain the classifier cannot place)

Every command takes --target <app|popup|mm|active|id>.
mm connect / request run in the site under test: open it (goto) first.
--force and network allow exist only here, on the operator's shell; the MCP tools never expose them.
`;

const options = {
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

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(value: unknown): never {
  process.stderr.write(JSON.stringify(value) + '\n');
  process.exit(1);
}

async function startDaemon(headless: boolean, detach: boolean): Promise<void> {
  ensureDirs();
  if (!detach) {
    const child = spawn(process.execPath, daemonSpawnArgs(headless), { stdio: 'inherit' });
    await new Promise((r) => child.on('exit', r));
    return;
  }
  // Same path the MCP server takes: waits for a booting or stopping daemon
  // instead of racing it for the browser profile.
  try {
    const info = await ensureDaemon(headless);
    out({ started: true, port: info.port, pid: info.pid, headless: info.headless });
  } catch (err) {
    const e = err as { code?: string; message: string };
    fail({ error: e.message, code: e.code ?? 'NO_DAEMON' });
  }
}

async function send(cmd: string, args: Record<string, unknown>): Promise<void> {
  const info = readDaemon();
  if (!info?.port) {
    fail({ error: 'daemon is not running; start it with: ./bin/rig serve --daemon', code: 'NO_DAEMON' });
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rig-token': info.token },
      body: JSON.stringify({ cmd, args }),
    });
  } catch (err) {
    fail({ error: `daemon unreachable on ${info.port}: ${(err as Error).message}`, code: 'NO_DAEMON' });
  }
  const body: unknown = await res.json().catch(() => ({ error: 'bad response', code: 'BAD_RESPONSE' }));
  if (!res.ok) fail(body);
  out(body);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options,
    allowPositionals: true,
    strict: false,
  });

  const cmd = positionals[0];
  if (!cmd || values['help']) {
    process.stdout.write(HELP);
    return;
  }

  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) args[k] = v;

  if (cmd === 'serve') {
    await startDaemon(values['headless'] === true, values['daemon'] === true);
    return;
  }

  // Sub-commanded groups keep their own verb, e.g. `mm approve` -> `mm.approve`.
  if (cmd === 'mm' || cmd === 'chain' || cmd === 'network') {
    const sub = positionals[1];
    if (!sub) fail({ error: `${cmd} needs a subcommand`, code: 'BAD_ARGS' });
    if (positionals[2] !== undefined) args['value'] = positionals[2];
    await send(`${cmd}.${sub}`, args);
    return;
  }

  if (positionals[1] !== undefined) args['value'] = positionals[1];
  await send(cmd, args);
}

main().catch((err: Error) => fail({ error: err.message, code: 'CLI' }));
