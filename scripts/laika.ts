/**
 * One Laika purchase, as a flow over an abstract driver, so the same steps
 * run through the MCP tools (as a client would) or the daemon's HTTP API.
 * The chain, not the UI, is the source of truth for success.
 */
import { McpClient } from './mcp-client.js';
import { callDaemon, ensureDaemon } from '../src/launcher.js';
import { FIXTURES, erc20Balance, nonceOf } from './fixtures.js';
import { sleep } from '../src/util.js';

export interface Hit {
  visible?: boolean;
  enabled?: boolean;
  cx?: number;
  cy?: number;
}

export interface Driver {
  goto(url: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  clearStorage(): Promise<void>;
  hits(text: string): Promise<Hit[]>;
  clickXy(x: number, y: number): Promise<void>;
  clickText(text: string): Promise<void>;
  typeInto(selector: string, nth: number, text: string): Promise<void>;
  press(key: string): Promise<void>;
  waitSelector(selector: string, timeoutMs: number): Promise<void>;
  waitPopup(timeoutMs: number): Promise<{ ok: boolean; popup?: unknown }>;
  approveAll(): Promise<number>;
  address(): Promise<string | undefined>;
  restart(): Promise<void>;
}

const APP = 'app';

/** Drive through the MCP server, exactly as an MCP client would. */
export class McpDriver implements Driver {
  constructor(readonly mcp: McpClient) {}
  async goto(url: string): Promise<void> {
    await this.mcp.json('rig_navigate', { action: 'goto', url, target: APP });
  }
  async resize(width: number, height: number): Promise<void> {
    await this.mcp.json('rig_navigate', { action: 'resize', width, height, target: APP });
  }
  async clearStorage(): Promise<void> {
    await this.mcp.json('rig_eval', { code: 'localStorage.clear(); sessionStorage.clear(); "cleared"', target: APP });
  }
  async hits(text: string): Promise<Hit[]> {
    const r: Record<string, unknown> = await this.mcp.json('rig_look', { action: 'find', text, target: APP }).catch(() => ({}));
    return ((r['hits'] as Hit[] | undefined) ?? []).filter((h) => h.visible);
  }
  async clickXy(x: number, y: number): Promise<void> {
    await this.mcp.json('rig_act', { action: 'click', xy: `${x},${y}`, target: APP });
  }
  async clickText(text: string): Promise<void> {
    await this.mcp.json('rig_act', { action: 'click', text, target: APP });
  }
  async typeInto(selector: string, nth: number, text: string): Promise<void> {
    await this.mcp.json('rig_act', { action: 'type', text, selector, nth, target: APP });
  }
  async press(key: string): Promise<void> {
    await this.mcp.json('rig_act', { action: 'press', key, target: APP });
  }
  async waitSelector(selector: string, timeoutMs: number): Promise<void> {
    await this.mcp.json('rig_navigate', { action: 'wait', for: 'selector', value: selector, timeout: timeoutMs, target: APP });
  }
  async waitPopup(timeoutMs: number): Promise<{ ok: boolean; popup?: unknown }> {
    const r = await this.mcp.json('rig_navigate', { action: 'wait', for: 'popup', timeout: timeoutMs });
    return { ok: r['ok'] === true, popup: r['popup'] };
  }
  async approveAll(): Promise<number> {
    const r = await this.mcp.json('rig_wallet', { action: 'approve', all: true });
    return ((r['actions'] as unknown[] | undefined) ?? []).length;
  }
  async address(): Promise<string | undefined> {
    const r = await this.mcp.json('rig_wallet', { action: 'status' });
    return typeof r['address'] === 'string' ? r['address'] : undefined;
  }
  async restart(): Promise<void> {
    await this.mcp.json('rig_session', { action: 'stop' });
    await this.mcp.json('rig_session', { action: 'start' });
  }
}

/** Drive the daemon's HTTP API directly; the CLI shape is the same. */
export class DaemonDriver implements Driver {
  private cmd(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return callDaemon(name, args, { autoStart: false });
  }
  async goto(url: string): Promise<void> {
    await this.cmd('goto', { value: url, target: APP });
  }
  async resize(width: number, height: number): Promise<void> {
    await this.cmd('resize', { width, height, target: APP });
  }
  async clearStorage(): Promise<void> {
    await this.cmd('eval', { value: 'localStorage.clear(); sessionStorage.clear(); "cleared"', target: APP });
  }
  async hits(text: string): Promise<Hit[]> {
    const r = await this.cmd('find', { value: text, target: APP }).catch(() => ({ hits: [] }));
    return ((r['hits'] as Hit[] | undefined) ?? []).filter((h) => h.visible);
  }
  async clickXy(x: number, y: number): Promise<void> {
    await this.cmd('click', { xy: `${x},${y}`, target: APP });
  }
  async clickText(text: string): Promise<void> {
    await this.cmd('click', { text, target: APP });
  }
  async typeInto(selector: string, nth: number, text: string): Promise<void> {
    await this.cmd('type', { value: text, sel: selector, nth, target: APP });
  }
  async press(key: string): Promise<void> {
    await this.cmd('press', { value: key, target: APP });
  }
  async waitSelector(selector: string, timeoutMs: number): Promise<void> {
    await this.cmd('wait', { sel: selector, timeout: timeoutMs, target: APP });
  }
  async waitPopup(timeoutMs: number): Promise<{ ok: boolean; popup?: unknown }> {
    const r = await this.cmd('wait', { popup: true, timeout: timeoutMs });
    return { ok: r['ok'] === true, popup: r['popup'] };
  }
  async approveAll(): Promise<number> {
    const r = await this.cmd('mm.approve', { all: true });
    return ((r['actions'] as unknown[] | undefined) ?? []).length;
  }
  async address(): Promise<string | undefined> {
    const r = await this.cmd('mm.status');
    return typeof r['address'] === 'string' ? r['address'] : undefined;
  }
  async restart(): Promise<void> {
    await this.cmd('stop').catch(() => undefined);
    await ensureDaemon();
  }
}

export interface BuyOptions {
  token: string;
  symbol: string;
  amount: string;
  app: string;
  rpc: string;
  /** Keep the site's session (SIWE token, wallet connection) instead of clearing it. */
  keepSession: boolean;
  /** Restart the browser before the run, so it starts from a cold profile. */
  restart: boolean;
}

export interface RunResult {
  run: number;
  ok: boolean;
  address?: string;
  connect?: string;
  dismissedOnboarding?: boolean;
  tokensGained?: string;
  nonceDelta?: number;
  elapsedMs: number;
  error?: string;
}

async function clickEnabled(d: Driver, text: string): Promise<boolean> {
  // The trade card renders its own disabled "Connect Wallet" button, so
  // matching on text alone picks the wrong one.
  const first = (await d.hits(text)).filter((h) => h.enabled)[0];
  if (!first || first.cx === undefined || first.cy === undefined) return false;
  await d.clickXy(first.cx, first.cy);
  return true;
}

/** Connect through the Tomo modal. Tolerates an already-connected session. */
async function ensureConnected(d: Driver): Promise<string> {
  const needsConnect = (await d.hits('Connect Wallet')).some((h) => h.enabled);
  if (!needsConnect) return 'already-connected';
  if (!(await clickEnabled(d, 'Connect Wallet'))) throw new Error('no enabled Connect Wallet button');
  await sleep(3500);
  if ((await d.hits('Or connect a wallet')).length > 0) {
    await d.clickText('Or connect a wallet');
    await sleep(2500);
  }
  await d.clickText('MetaMask Installed');
  await sleep(2500);
  // Connect and the SIWE signature can arrive as one queue or two; drain twice.
  let approvals = 0;
  for (let i = 0; i < 2; i++) {
    const waited = await d.waitPopup(25_000);
    if (!waited.ok) break;
    approvals += await d.approveAll();
    await sleep(3000);
  }
  await sleep(3000);
  return `connected (${approvals} approvals)`;
}

/**
 * Clearing localStorage resets the in-app onboarding, which reopens as a modal
 * over the trade card and swallows clicks and keystrokes.
 */
async function dismissOnboarding(d: Driver): Promise<boolean> {
  let dismissed = false;
  for (const label of ['Hide onboarding', 'Skip', 'Dismiss']) {
    if ((await d.hits(label)).length > 0) {
      await d.clickText(label).catch(() => undefined);
      dismissed = true;
      await sleep(1200);
      break;
    }
  }
  await d.press('Escape').catch(() => undefined);
  await sleep(600);
  return dismissed;
}

/**
 * The trade card and the sidebar swap widget share placeholder "0.0", and the
 * card remounts when its quote arrives, so fill and then confirm the submit
 * button actually enabled before trusting it.
 */
async function enterAmount(d: Driver, amount: string, symbol: string): Promise<boolean> {
  await d.waitSelector('[data-onboarding-anchor="trade-submit"]', 20_000).catch(() => undefined);
  for (let attempt = 0; attempt < 6; attempt++) {
    await d.typeInto('input[placeholder="0.0"]', attempt % 2, amount).catch(() => undefined);
    await sleep(2500);
    if ((await d.hits(`Buy ${symbol}`)).some((h) => h.enabled)) return true;
  }
  return false;
}

export async function buyOnce(d: Driver, run: number, opts: BuyOptions): Promise<RunResult> {
  const started = Date.now();
  try {
    if (opts.restart) await d.restart();
    const address = await d.address();
    if (!address) throw new Error('the wallet reports no address; run setup first');
    const url = `${opts.app}/tokens?address=${opts.token}`;
    await d.goto(url);
    await d.resize(1440, 900);
    await sleep(7000);
    if (!opts.keepSession) {
      // Drop the cached SIWE token and wallet state so every run exercises the
      // whole path: Tomo modal -> MetaMask connect -> signature -> trade.
      await d.clearStorage();
      await d.goto(url);
      await sleep(7000);
    }

    const connect = await ensureConnected(d);
    await sleep(2000);
    const dismissed = await dismissOnboarding(d);

    const balBefore = await erc20Balance(opts.rpc, opts.token, address);
    const nonceBefore = await nonceOf(opts.rpc, address);

    // The app dry-runs the trade before asking the wallet, and a refreshed quote
    // can clear the amount, so one retry keeps a transient miss from failing.
    let confirmed = false;
    let lastReason = '';
    for (let attempt = 1; attempt <= 2 && !confirmed; attempt++) {
      if (!(await enterAmount(d, opts.amount, opts.symbol))) {
        lastReason = `amount did not enable "Buy ${opts.symbol}"`;
        continue;
      }
      if (!(await clickEnabled(d, `Buy ${opts.symbol}`))) {
        lastReason = 'buy button was not clickable';
        continue;
      }
      await sleep(2500);
      const popup = await d.waitPopup(60_000);
      if (!popup.ok) {
        lastReason = 'no wallet confirmation appeared';
        await sleep(3000);
        continue;
      }
      await d.approveAll();
      confirmed = true;
    }
    if (!confirmed) throw new Error(lastReason || 'buy did not reach the wallet');

    // The UI is not the source of truth; wait for the chain to move.
    let gained = 0n;
    for (let t = 0; t < 40; t++) {
      await sleep(3000);
      gained = (await erc20Balance(opts.rpc, opts.token, address)) - balBefore;
      if (gained > 0n) break;
    }
    const nonceDelta = (await nonceOf(opts.rpc, address)) - nonceBefore;
    if (gained <= 0n) throw new Error(`balance did not increase (nonce delta ${nonceDelta})`);

    return {
      run,
      ok: true,
      address,
      connect,
      dismissedOnboarding: dismissed,
      tokensGained: (Number(gained / 10n ** 14n) / 10000).toFixed(4),
      nonceDelta,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return { run, ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - started };
  }
}

/** Common CLI for the loop scripts. */
export function loopOptions(argv: string[]): { runs: number; keepSession: boolean; opts: BuyOptions } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runs = Number(get('--runs') ?? '10');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  const keepSession = argv.includes('--keep-session');
  return {
    runs,
    keepSession,
    opts: {
      token: get('--token') ?? FIXTURES.token,
      symbol: get('--symbol') ?? FIXTURES.symbol,
      amount: get('--amount') ?? FIXTURES.amount,
      app: FIXTURES.app,
      rpc: FIXTURES.rpc,
      keepSession,
      restart: true,
    },
  };
}
