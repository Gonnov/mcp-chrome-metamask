import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ensureDirs, readDaemon } from './daemon/state.js';
import { daemonSpawnArgs, ensureDaemon } from './launcher.js';
import { parseScript } from './script.js';
import { options, toCommand } from './argv.js';

const HELP = `rig - drive a real Chrome with a real MetaMask

  serve [--headless] [--daemon]     start the browser daemon
  status | stop | pages | boot
  use <target>                      pin default target: app|popup|mm|active|<id>
  goto <url>
  shot [--out p] [--annotate] [--grid 100] [--full]
  ocr [--min-conf 60] [--psm 11]
  aria | find <text> [--role button]
  click --xy X,Y | --id N | --text "t" [--nth 0] [--fuzzy .8] | --sel css | --role r --name n [--popup-ms 250]
  type "text" [--sel css] | press <Key> | scroll [--dy 400]
  wait --ms N | --text t | --url u | --sel css | --popup | --popup-gone [--timeout 15000]
  eval "<js>" [--fire] | result <reqId>
  console [--n 60] [--clear] | close | resize [--width 1440] [--height 900]
  mm fetch [--from-brave] [--version 13.48.0]
  mm setup [--pkey 0x.. | --key-file p] [--dry] [--no-import]
  mm status | address | unlock | approve [--all] [--force] | reject [--all] | pending | popups | home
  mm connect | add-network | import-key [--pkey 0x.. | --key-file p] | select --address 0x..
  mm request <method> [--params '[]']
  chain info | balance [addr] | snapshot | revert <id> | fund [addr] [--amount N] | mine [--blocks N]
  network list | current | use --chain-id N --rpc-url U [--name] [--symbol]
  network allow <chainId> | disallow <chainId>   (operator only: vouch for a chain the classifier cannot place)
  run <file | -> | run --steps '<json>'           several commands in one call, stopping at the first failure

A run script is one rig command per line, written as on this command line
without "./bin/rig"; # starts a comment, a leading "?" marks a step whose
failure is reported but does not stop the run. A file starting with "[" is
read as JSON steps instead: [{"cmd":"click","text":"Buy"},{"cmd":"mm.approve","all":true}].

Every command takes --target <app|popup|mm|active|id>.
mm connect / request run in the site under test: open it (goto) first.
--force and network allow exist only here, on the operator's shell; the MCP tools never expose them.
`;


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
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: false });

  if (!positionals[0] || values['help']) {
    process.stdout.write(HELP);
    return;
  }

  if (positionals[0] === 'serve') {
    await startDaemon(values['headless'] === true, values['daemon'] === true);
    return;
  }

  if (positionals[0] === 'run') {
    const inline = values['steps'];
    const file = positionals[1];
    let source: string;
    if (typeof inline === 'string') source = inline;
    else if (file) source = readFileSync(file === '-' ? 0 : file, 'utf8');
    else fail({ error: 'run needs a script file, - for stdin, or --steps', code: 'BAD_ARGS' });
    let steps: unknown[];
    try {
      steps = parseScript(source, toCommand);
    } catch (err) {
      fail({ error: `bad run script: ${(err as Error).message}`, code: 'BAD_ARGS' });
    }
    await send('run', { steps });
    return;
  }

  let command: { cmd: string; args: Record<string, unknown> };
  try {
    command = toCommand(argv);
  } catch (err) {
    fail({ error: (err as Error).message, code: 'BAD_ARGS' });
  }
  await send(command.cmd, command.args);
}

main().catch((err: Error) => fail({ error: err.message, code: 'CLI' }));
