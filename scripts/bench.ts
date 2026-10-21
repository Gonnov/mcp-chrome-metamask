/**
 * Benchmark the rig as an agent uses it: each case spawns ./bin/rig and times
 * the whole call, CLI startup included, against a headless daemon.
 *
 *   pnpm bench -- --label before [--runs 9] [--only goto,click] [--root <rig checkout>]
 *   pnpm bench -- --compare .rig/bench/a.json .rig/bench/b.json
 *
 * --root points at another checkout of the rig (an older copy, say) so two
 * versions run through the same harness. RIG_PORT and RIG_DIR pass through,
 * so a benchmark can run on a disposable profile beside the shared daemon.
 * Results land in .rig/bench/<date>-<label>.json (gitignored).
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, RIG_DIR } from '../src/daemon/state.js';

interface CaseResult {
  ms: number[];
  median: number;
  p90: number;
  max: number;
  min: number;
  fails: number;
  errors: string[];
}

interface BenchFile {
  label: string;
  root: string;
  date: string;
  runs: number;
  node: string;
  cases: Record<string, CaseResult>;
}

const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ACCOUNT_3 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] as number;
}

export function summarize(ms: number[], errors: string[]): CaseResult {
  const sorted = [...ms].sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? NaN
      : sorted.length % 2
        ? (sorted[(sorted.length - 1) / 2] as number)
        : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2;
  return {
    ms,
    median: Math.round(median),
    p90: quantile(sorted, 0.9),
    max: sorted.at(-1) ?? NaN,
    min: sorted[0] ?? NaN,
    fails: errors.length,
    errors: errors.slice(0, 5),
  };
}

interface Call {
  code: number;
  ms: number;
  out: string;
  err: string;
}

function rig(root: string, args: string[], stdin?: string): Promise<Call> {
  return new Promise((done) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(resolve(root, 'bin/rig'), args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('close', (code) => {
      done({ code: code ?? 1, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), out, err });
    });
    child.stdin.end(stdin ?? '');
  });
}

function json(c: Call): Record<string, unknown> {
  try {
    return JSON.parse(c.out || c.err) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>rig bench</title></head>
<body><h1>rig bench</h1>
<input id="amount" placeholder="amount"><button id="buy" onclick="document.getElementById('out').textContent='clicked '+Date.now()">Buy</button>
<p id="out">idle</p>
<ul>${Array.from({ length: 40 }, (_, i) => `<li><a href="#r${i}">row ${i}</a></li>`).join('')}</ul>
</body></html>`;

function serve(): Promise<{ server: Server; url: string }> {
  return new Promise((done) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      done({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

type Case = (i: number) => Promise<{ ms: number; ok: boolean; why?: string; extra?: Record<string, number> }>;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      label: { type: 'string', default: 'run' },
      runs: { type: 'string', default: '9' },
      only: { type: 'string' },
      skip: { type: 'string' },
      root: { type: 'string', default: ROOT },
      compare: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.compare) {
    compare(positionals[0] as string, positionals[1] as string);
    return;
  }

  const root = resolve(values.root);
  const runs = Number(values.runs);
  const { server, url } = await serve();

  const sh = (args: string[]) => rig(root, args);
  const timed =
    (args: string[], expectFail = false): Case =>
    async () => {
      const c = await sh(args);
      const ok = expectFail ? c.code !== 0 : c.code === 0;
      return { ms: c.ms, ok, ...(ok ? {} : { why: (c.err || c.out).slice(0, 300) }) };
    };

  // Every app-page case runs on the bench page, opened once up front.
  const setup = await sh(['goto', url]);
  if (setup.code !== 0) throw new Error(`cannot open the bench page: ${setup.err}`);
  // Start connected as account #0, so sign has an account and select has a known start.
  await sh(['mm', 'select', '--address', ACCOUNT_0]);
  await sh(['mm', 'request', 'eth_requestAccounts']);

  const revoke = `window.ethereum.request({method:'wallet_revokePermissions',params:[{eth_accounts:{}}]}).then(()=>'revoked')`;
  const sign = `window.ethereum.request({method:'eth_accounts'}).then(a=>window.ethereum.request({method:'personal_sign',params:['0x7269672062656e6368',a[0]]}))`;

  const cases: Record<string, Case> = {
    'cli-empty': timed(['--help']),
    goto: timed(['goto', url]),
    aria: timed(['aria', '--target', 'app']),
    shot: timed(['shot', '--target', 'app']),
    eval: timed(['eval', 'document.title', '--target', 'app']),
    click: timed(['click', '--sel', '#buy', '--target', 'app']),
    'click-missing': timed(['click', '--sel', '#absent', '--target', 'app'], true),
    'mm-status': timed(['mm', 'status']),
    'mm-address': timed(['mm', 'address']),
    'mm-select': async (i) => {
      const c = await sh(['mm', 'select', '--address', i % 2 === 0 ? ACCOUNT_3 : ACCOUNT_0]);
      const r = json(c);
      const ok = c.code === 0 && r['selected'] === true;
      return { ms: c.ms, ok, ...(ok ? {} : { why: (c.err || c.out).slice(0, 300) }) };
    },
    connect: async () => {
      await sh(['eval', revoke, '--target', 'app']);
      const c = await sh(['mm', 'request', 'eth_requestAccounts']);
      const r = json(c);
      const ok = c.code === 0 && r['done'] === true && Array.isArray(r['value']) && (r['value'] as unknown[]).length > 0;
      return { ms: c.ms, ok, ...(ok ? {} : { why: (c.err || c.out).slice(0, 300) }) };
    },
    sign: async () => {
      const script = `eval "${sign.replace(/"/g, '\\"')}" --fire --target app\nwait --popup --timeout 20000\nmm approve\n`;
      const c = await rig(root, ['run', '-'], script);
      const r = json(c);
      const steps = (r['steps'] as { cmd: string; ms: number; result?: Record<string, unknown> }[] | undefined) ?? [];
      const reqId = steps[0]?.result?.['reqId'];
      let signed = false;
      for (let k = 0; k < 20 && typeof reqId === 'string'; k++) {
        const res = json(await sh(['result', reqId, '--target', 'app']));
        if (res['done'] === true) {
          signed = typeof res['value'] === 'string' && /^0x[0-9a-f]{130}$/i.test(res['value'] as string);
          break;
        }
        await new Promise((d) => setTimeout(d, 250));
      }
      const ok = c.code === 0 && r['ok'] === true && signed;
      const approveMs = steps.find((s) => s.cmd === 'mm.approve')?.ms;
      const waitMs = steps.find((s) => s.cmd === 'wait')?.ms;
      return {
        ms: c.ms,
        ok,
        extra: { ...(approveMs !== undefined ? { 'sign.approve': approveMs } : {}), ...(waitMs !== undefined ? { 'sign.wait-popup': waitMs } : {}) },
        ...(ok ? {} : { why: (c.err || c.out).slice(0, 400) }),
      };
    },
    boot: async () => {
      await sh(['stop']);
      // Wait until the old process has let go of the profile (NO_DAEMON, not
      // STOPPING): otherwise the timed start also waits out the shutdown.
      for (let k = 0; k < 120; k++) {
        const s = await sh(['status']);
        if (s.code !== 0 && s.err.includes('NO_DAEMON')) break;
        await new Promise((d) => setTimeout(d, 250));
      }
      const c = await sh(['serve', '--daemon']);
      await sh(['goto', url]);
      return { ms: c.ms, ok: c.code === 0, ...(c.code === 0 ? {} : { why: c.err.slice(0, 300) }) };
    },
  };

  const only = values.only?.split(',');
  const skip = new Set(values.skip?.split(',') ?? []);
  const names = Object.keys(cases).filter((n) => (!only || only.includes(n)) && !skip.has(n));
  const file: BenchFile = { label: values.label, root, date: new Date().toISOString(), runs, node: process.version, cases: {} };
  const extras: Record<string, number[]> = {};
  for (const name of names) {
    const ms: number[] = [];
    const errors: string[] = [];
    for (let i = 0; i < runs; i++) {
      const r = await (cases[name] as Case)(i);
      ms.push(r.ms);
      if (!r.ok) errors.push(`#${i}: ${r.why ?? 'failed'}`);
      for (const [k, v] of Object.entries(r.extra ?? {})) (extras[k] ??= []).push(v);
    }
    file.cases[name] = summarize(ms, errors);
    const c = file.cases[name];
    process.stderr.write(`${name.padEnd(14)} median ${c.median}ms p90 ${c.p90} max ${c.max} fails ${c.fails}\n`);
  }
  for (const [k, v] of Object.entries(extras)) file.cases[k] = summarize(v, []);

  // Leave the profile as found: account #0 selected.
  await sh(['mm', 'select', '--address', ACCOUNT_0]);
  server.close();

  const dir = resolve(RIG_DIR, 'bench');
  mkdirSync(dir, { recursive: true });
  const out = resolve(dir, `${file.date.slice(0, 19).replace(/[:T]/g, '-')}-${values.label}.json`);
  writeFileSync(out, JSON.stringify(file, null, 2));
  console.log(out);
}

function compare(a: string, b: string): void {
  const A = JSON.parse(readFileSync(a, 'utf8')) as BenchFile;
  const B = JSON.parse(readFileSync(b, 'utf8')) as BenchFile;
  const rows = [...new Set([...Object.keys(A.cases), ...Object.keys(B.cases)])];
  console.log(`case            ${A.label.padStart(10)} ${B.label.padStart(10)}   speedup   fails`);
  for (const r of rows) {
    const x = A.cases[r];
    const y = B.cases[r];
    const ratio = x && y && y.median > 0 ? (x.median / y.median).toFixed(1) + 'x' : '-';
    console.log(
      `${r.padEnd(15)} ${String(x?.median ?? '-').padStart(10)} ${String(y?.median ?? '-').padStart(10)}   ${ratio.padStart(7)}   ${x?.fails ?? '-'}/${y?.fails ?? '-'}`,
    );
  }
}

if (process.argv[1]?.endsWith('bench.ts')) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
