/**
 * End-to-end flows against a real dapp and a real MetaMask, each one a rig
 * run script (scripts/e2e/*.rig) followed by checks the UI cannot fake: the
 * chain's balances, a recovered signature, the site's own eth_accounts.
 *
 *   pnpm e2e -- --app http://localhost:3210 --rpc http://127.0.0.1:8621 --token 0x… [--only buy,sell] [--root <rig>] [--label x]
 *
 * Scripts use ${APP}, ${NEUTRAL} (any http page with no dapp on it), ${TOKEN}, ${SYMBOL}, ${AMOUNT}, ${ACCOUNT_0} and
 * ${ACCOUNT_3}, filled in here. --root runs another checkout of the rig, so
 * the same flows prove an older version too. Results (each run's JSON and a
 * screenshot) land in .rig/e2e/<date>-<label>/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { encodeFunctionData, parseAbi, parseEther, recoverMessageAddress, toHex } from 'viem';
import { ROOT, RIG_DIR } from '../src/daemon/state.js';
import { rpc } from '../src/chain.js';
import { parseScript } from '../src/script.js';
import { toCommand } from '../src/argv.js';
import { McpClient } from './mcp-client.js';

export const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const ACCOUNT_3 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
/**
 * The deployed testnet ecosystem's own ABI. It predates the frontend's
 * three-argument purchase (with a deadline), which is why the flows send these
 * calls from the site instead of pressing the app's Buy button.
 */
export const ECOSYSTEM = '0xFc73b822B3f1515F58cEBaF4D591f0f1357A67Fd';
const ECO_ABI = parseAbi([
  'function purchaseTokensWithDoge(address tokenAddress, uint256 minTokens) payable returns (uint256)',
  'function sellTokens(address tokenAddress, uint256 tokenAmount, uint256 minOut) returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** The message the sign flows ask for: "rig e2e". */
export const SIGN_HEX = '0x72696720653265';

/** Fill ${NAME} placeholders; an unknown name is an error, never left in a command. */
export function fillTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`no value for \${${name}}`);
    return v;
  });
}

interface Step {
  i: number;
  cmd: string;
  ms: number;
  failed?: boolean;
  result?: Record<string, unknown>;
  error?: { error: string; code: string };
}

interface RunOut {
  ok: boolean;
  elapsedMs: number;
  failedAt?: number;
  steps: Step[];
}

function rig(root: string, args: string[], stdin = ''): Promise<{ code: number; out: string; err: string; ms: number }> {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(resolve(root, 'bin/rig'), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('close', (code) => done({ code: code ?? 1, out, err, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}

function parse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function erc20Balance(rpcUrl: string, token: string, owner: string): Promise<bigint> {
  const data = `0x70a08231000000000000000000000000${owner.slice(2).toLowerCase()}`;
  return BigInt(((await rpc(rpcUrl, 'eth_call', [{ to: token, data }, 'latest'])) as string) || '0x0');
}

async function nativeBalance(rpcUrl: string, owner: string): Promise<bigint> {
  return BigInt((await rpc(rpcUrl, 'eth_getBalance', [owner, 'latest'])) as string);
}

/** The value an `eval` step returned, by its position in the script. */
function evalValue(run: RunOut, nth = -1): unknown {
  const evals = run.steps.filter((s) => s.cmd === 'eval' && s.result);
  return evals.at(nth)?.result?.['value'];
}

interface Flow {
  /** Values only known at run time (amounts, the balance MetaMask must report), added to the script's variables. */
  prepare?: () => Promise<Record<string, string>>;
  /** Checked before the script, e.g. balances; handed to `after`. */
  before?: () => Promise<Record<string, unknown>>;
  /** Throws when the outcome is wrong. */
  after?: (run: RunOut, before: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      app: { type: 'string', default: 'http://localhost:3210' },
      neutral: { type: 'string', default: 'http://localhost:4210/api/health' },
      rpc: { type: 'string', default: 'http://127.0.0.1:8621' },
      token: { type: 'string', default: '0xDeFc75F007fdE566154701eA5a26b4Bd1A3F8f3d' },
      symbol: { type: 'string', default: 'CBY' },
      amount: { type: 'string', default: '0.05' },
      only: { type: 'string' },
      root: { type: 'string', default: ROOT },
      label: { type: 'string', default: 'run' },
      repeat: { type: 'string', default: '1' },
      via: { type: 'string', default: 'cli' },
    },
  });
  if (values.via === 'mcp') {
    mcp = new McpClient(resolve(values.root));
    await mcp.init();
  }
  const root = resolve(values.root);
  const rpcUrl = values.rpc;
  const token = values.token;
  const vars: Record<string, string> = {
    APP: values.app,
    NEUTRAL: values.neutral,
    TOKEN: token,
    SYMBOL: values.symbol,
    AMOUNT: values.amount,
    ACCOUNT_0,
    ACCOUNT_3,
    SIGN_HEX,
    ECOSYSTEM,
    BUY_VALUE: toHex(parseEther(values.amount)),
    BUY_DATA: encodeFunctionData({ abi: ECO_ABI, functionName: 'purchaseTokensWithDoge', args: [token as `0x${string}`, 0n] }),
  };
  // #0 holds a fork-only balance (funded on anvil, far above its real testnet
  // one). MetaMask must report at least half of it, or it is routing elsewhere.
  // Not an exact match: MetaMask serves the previous block's balance for a beat after a transaction.
  const forkBalance = async (): Promise<Record<string, string>> => ({ FORK_MIN_WEI: String((await nativeBalance(rpcUrl, ACCOUNT_0)) / 2n) });

  const flows: Record<string, Flow> = {
    'connect-siwe': {
      after: async (run) => {
        const auth = evalValue(run);
        if (typeof auth !== 'string' || !auth.toLowerCase().includes(ACCOUNT_0.toLowerCase())) {
          throw new Error(`site has no SIWE session for #0: ${JSON.stringify(auth)}`);
        }
        return { siweUser: auth };
      },
    },
    buy: {
      prepare: forkBalance,
      before: async () => ({ tokens: await erc20Balance(rpcUrl, token, ACCOUNT_0), doge: await nativeBalance(rpcUrl, ACCOUNT_0) }),
      after: async (_run, b) => {
        let tokens = 0n;
        for (let k = 0; k < 40; k++) {
          tokens = await erc20Balance(rpcUrl, token, ACCOUNT_0);
          if (tokens > (b['tokens'] as bigint)) break;
          await new Promise((d) => setTimeout(d, 500));
        }
        const doge = await nativeBalance(rpcUrl, ACCOUNT_0);
        if (tokens <= (b['tokens'] as bigint)) throw new Error('token balance did not increase on chain');
        if (doge >= (b['doge'] as bigint)) throw new Error('DOGE balance did not decrease on chain');
        return { tokensGained: String(tokens - (b['tokens'] as bigint)), dogeSpent: String((b['doge'] as bigint) - doge) };
      },
    },
    sell: {
      prepare: async () => {
        const half = (await erc20Balance(rpcUrl, token, ACCOUNT_0)) / 2n;
        if (half === 0n) throw new Error('nothing to sell: run buy first');
        return {
          ...(await forkBalance()),
          APPROVE_DATA: encodeFunctionData({ abi: ECO_ABI, functionName: 'approve', args: [ECOSYSTEM, half] }),
          SELL_DATA: encodeFunctionData({ abi: ECO_ABI, functionName: 'sellTokens', args: [token as `0x${string}`, half, 0n] }),
        };
      },
      before: async () => ({ tokens: await erc20Balance(rpcUrl, token, ACCOUNT_0) }),
      after: async (_run, b) => {
        let tokens = b['tokens'] as bigint;
        for (let k = 0; k < 40 && tokens >= (b['tokens'] as bigint); k++) {
          await new Promise((d) => setTimeout(d, 500));
          tokens = await erc20Balance(rpcUrl, token, ACCOUNT_0);
        }
        if (tokens >= (b['tokens'] as bigint)) throw new Error('token balance did not decrease on chain');
        return { tokensSold: String((b['tokens'] as bigint) - tokens) };
      },
    },
    sign: {
      after: async (run) => {
        const reqId = run.steps.find((s) => s.cmd === 'eval' && s.result?.['reqId'])?.result?.['reqId'];
        const slot = await readSlot(root, String(reqId));
        const sig = slot['value'];
        if (typeof sig !== 'string') throw new Error(`no signature: ${JSON.stringify(slot)}`);
        const signer = await recoverMessageAddress({ message: { raw: SIGN_HEX as `0x${string}` }, signature: sig as `0x${string}` });
        if (signer.toLowerCase() !== ACCOUNT_0.toLowerCase()) throw new Error(`signed by ${signer}, not #0`);
        return { signer };
      },
    },
    reject: {
      after: async (run) => {
        const shown = evalValue(run);
        if (typeof shown !== 'string' || !/reject|cancel|denied|failed/i.test(shown)) {
          throw new Error(`the app did not show the cancellation: ${JSON.stringify(shown)}`);
        }
        return { appShowed: shown };
      },
    },
    'switch-accounts': {
      after: async (run) => {
        const seen = run.steps.filter((s) => s.cmd === 'eval' && Array.isArray(s.result?.['value'])).map((s) => (s.result?.['value'] as string[])[0]);
        const want = [ACCOUNT_3, ACCOUNT_0].map((a) => a.toLowerCase());
        if (JSON.stringify(seen.map((a) => a?.toLowerCase())) !== JSON.stringify(want)) {
          throw new Error(`site saw ${JSON.stringify(seen)}, expected #3 then #0`);
        }
        return { siteSaw: seen };
      },
    },
    'mainnet-guard': {
      after: async (run) => {
        // The approve after the signature request is the one that must fail.
        const signAt = run.steps.findIndex((s) => s.cmd === 'eval' && String(s.result?.['reqId'] ?? '') !== '');
        const sigReq = run.steps[signAt]?.result?.['reqId'];
        const refused = run.steps.slice(signAt + 1).find((s) => s.cmd === 'mm.approve');
        if (refused?.error?.code !== 'CHAIN_NOT_ALLOWED') {
          throw new Error(`approve on chain 1 was not refused with CHAIN_NOT_ALLOWED: ${JSON.stringify(refused?.error ?? refused?.result)}`);
        }
        // And nothing was signed: the request ended rejected, not with a signature.
        const slot = await readSlot(root, String(sigReq));
        if (typeof slot['value'] === 'string') throw new Error('the mainnet signature request was signed');
        return { refusal: refused.error, request: slot };
      },
    },
    persistence: {
      after: async (run) => {
        const status = run.steps.find((s) => s.cmd === 'mm.status')?.result ?? {};
        if (status['locked'] !== false) throw new Error(`wallet locked after restart: ${JSON.stringify(status)}`);
        if (String(status['address']).toLowerCase() !== ACCOUNT_0.toLowerCase()) throw new Error(`restarted on ${String(status['address'])}, not #0`);
        return { status: { locked: status['locked'], address: status['address'] } };
      },
    },
  };

  const dir = resolve(ROOT, 'scripts/e2e');
  const all = readdirSync(dir).filter((f) => f.endsWith('.rig')).map((f) => basename(f, '.rig'));
  const order = Object.keys(flows).filter((n) => all.includes(n));
  const only = values.only?.split(',');
  const names = order.filter((n) => !only || only.includes(n));
  const outDir = resolve(RIG_DIR, 'e2e', `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${values.label}`);
  mkdirSync(outDir, { recursive: true });

  const summary: Record<string, unknown>[] = [];
  const repeat = Number(values.repeat);
  for (let r = 0; r < repeat; r++) {
    for (const name of names) {
      const flow = flows[name] as Flow;
      const started = Date.now();
      const entry: Record<string, unknown> = { flow: name, ...(repeat > 1 ? { round: r + 1 } : {}) };
      try {
        const before = flow.before ? await flow.before() : {};
        const script = fillTemplate(readFileSync(resolve(dir, `${name}.rig`), 'utf8'), { ...vars, ...(flow.prepare ? await flow.prepare() : {}) });
        // The persistence flow stops and restarts the daemon, which a run cannot do.
        const run = name === 'persistence' ? await restartAndCheck(root, script) : await runScript(root, script);
        writeFileSync(resolve(outDir, `${name}${repeat > 1 ? `-${r + 1}` : ''}.json`), JSON.stringify(run, null, 2));
        if (!run.ok) {
          const s = run.steps[run.failedAt ?? -1];
          throw new Error(`step ${run.failedAt} (${s?.cmd}) failed: ${JSON.stringify(s?.error ?? s?.result).slice(0, 400)}`);
        }
        Object.assign(entry, { ok: true, ...(flow.after ? await flow.after(run, before) : {}) });
        entry['runMs'] = run.elapsedMs;
      } catch (err) {
        Object.assign(entry, { ok: false, error: (err as Error).message });
      }
      entry['ms'] = Date.now() - started;
      if (repeat === 1 || r === repeat - 1) await shot(root, `${name}`, outDir);
      summary.push(entry);
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    }
  }
  const passed = summary.filter((e) => e['ok']).length;
  const result = { label: values.label, via: values.via, root, date: new Date().toISOString(), passed, total: summary.length, flows: summary };
  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(result, null, 2));
  mcp?.close();
  console.log(JSON.stringify({ passed, total: summary.length, outDir }));
  if (passed !== summary.length) process.exit(1);
}

/** Set with --via mcp: flows then go through the MCP server's rig_run tool, as an MCP client would send them. */
let mcp: McpClient | null = null;

async function runScript(root: string, script: string): Promise<RunOut> {
  if (mcp) {
    const steps = parseScript(script, toCommand);
    const r = await mcp.call('rig_run', { steps });
    const text = (r.content ?? []).find((c) => c.type === 'text')?.text ?? '{}';
    const out = parse(text) as unknown as RunOut;
    if (r.isError || !Array.isArray(out.steps)) {
      return { ok: false, elapsedMs: 0, failedAt: -1, steps: [{ i: -1, cmd: 'rig_run', ms: 0, failed: true, error: { error: text.slice(0, 400), code: 'MCP' } }] };
    }
    return out;
  }
  const c = await rig(root, ['run', '-'], script);
  const out = parse(c.out || c.err) as unknown as RunOut;
  if (!Array.isArray(out.steps)) return { ok: false, elapsedMs: c.ms, failedAt: -1, steps: [{ i: -1, cmd: 'run', ms: c.ms, failed: true, error: { error: (c.err || c.out).slice(0, 400), code: 'RUN' } }] };
  return out;
}

/** Stop the daemon, start it again, then run the script on the fresh browser. */
async function restartAndCheck(root: string, script: string): Promise<RunOut> {
  if (mcp) {
    await mcp.json('rig_session', { action: 'stop' });
    await waitDown(root);
    await mcp.json('rig_session', { action: 'start', headless: true });
    return runScript(root, script);
  }
  await rig(root, ['stop']);
  for (let k = 0; k < 120; k++) {
    const s = await rig(root, ['status']);
    if (s.code !== 0 && s.err.includes('NO_DAEMON')) break;
    await new Promise((d) => setTimeout(d, 250));
  }
  const serve = await rig(root, ['serve', '--daemon']);
  if (serve.code !== 0) throw new Error(`restart failed: ${serve.err}`);
  return runScript(root, script);
}

async function waitDown(root: string): Promise<void> {
  for (let k = 0; k < 120; k++) {
    const s = await rig(root, ['status']);
    if (s.code !== 0 && s.err.includes('NO_DAEMON')) return;
    await new Promise((d) => setTimeout(d, 250));
  }
}

async function readSlot(root: string, reqId: string): Promise<Record<string, unknown>> {
  for (let k = 0; k < 40; k++) {
    const r = parse((await rig(root, ['result', reqId, '--target', 'app'])).out);
    if (r['done'] === true) return r;
    await new Promise((d) => setTimeout(d, 250));
  }
  return { done: false };
}

async function shot(root: string, name: string, outDir: string): Promise<void> {
  const r = parse((await rig(root, ['shot', '--target', 'app', '--out', `e2e-${name}.png`])).out);
  const path = r['path'];
  if (typeof path === 'string' && existsSync(path)) copyFileSync(path, resolve(outDir, `${name}.png`));
}

if (process.argv[1]?.endsWith('e2e.ts')) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
