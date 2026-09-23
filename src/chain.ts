/** Plain JSON-RPC over fetch, for reading chain state and driving a local fork. */
import { RigError } from './types.js';

export async function rpc(
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 10_000,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new RigError('RPC_UNREACHABLE', `${method}: ${url} did not answer (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new RigError('RPC_HTTP', `${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new RigError('RPC_ERROR', `${method}: ${body.error.message}`);
  return body.result;
}

/** A node on this machine: the only kind the fork-manipulation calls may touch. */
export function isLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

function assertLocal(url: string, method: string): void {
  if (!isLocal(url)) {
    throw new RigError(
      'NOT_FORK',
      `${method} is fork-only; active RPC ${url} is not a local node. Pass rpc=http://127.0.0.1:<port> or set RIG_RPC_URL to a local node.`,
    );
  }
}

/** Whole native units (18 decimals) to hex wei, via BigInt to avoid float drift. */
export function toWeiHex(amount: number): string {
  const [intPart = '0', fracRaw = ''] = String(amount).split('.');
  const frac = (fracRaw + '0'.repeat(18)).slice(0, 18);
  return '0x' + (BigInt(intPart) * 10n ** 18n + BigInt(frac || '0')).toString(16);
}

/** Hex wei to a decimal string with six places. */
export function formatNative(weiHex: string): string {
  const wei = BigInt(weiHex);
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

export async function chainInfo(url: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const [chainId, block, clientVersion] = await Promise.all([
    rpc(url, 'eth_chainId', [], timeoutMs),
    rpc(url, 'eth_blockNumber', [], timeoutMs),
    rpc(url, 'web3_clientVersion', [], timeoutMs).catch(() => 'unknown'),
  ]);
  return {
    url,
    chainIdHex: chainId,
    chainId: Number(BigInt(String(chainId))),
    block: Number(BigInt(String(block))),
    client: clientVersion,
    isFork: isLocal(url),
  };
}

export async function balance(url: string, address: string): Promise<Record<string, unknown>> {
  const wei = (await rpc(url, 'eth_getBalance', [address, 'latest'])) as string;
  const native = formatNative(wei);
  // `doge` is kept for existing clients; `native` is the chain-agnostic name.
  return { address, wei, native, doge: native, url };
}

export async function snapshot(url: string): Promise<unknown> {
  assertLocal(url, 'snapshot');
  return rpc(url, 'evm_snapshot');
}

export async function revert(url: string, id: string): Promise<unknown> {
  assertLocal(url, 'revert');
  return rpc(url, 'evm_revert', [id]);
}

export async function fund(url: string, address: string, amount: number): Promise<unknown> {
  assertLocal(url, 'fund');
  return rpc(url, 'hardhat_setBalance', [address, toWeiHex(amount)]);
}

export async function mine(url: string, blocks: number): Promise<unknown> {
  assertLocal(url, 'mine');
  return rpc(url, 'hardhat_mine', ['0x' + blocks.toString(16)]);
}
