/** Defaults shared by the acceptance scripts: the Laika test token and RPC. */
import { env } from '../src/daemon/state.js';
import { rpc } from '../src/chain.js';

export const FIXTURES = {
  token: process.env['TOKEN'] ?? '0x7CE995C590394594b9cB5b7A4AbB84F0B3D541F9',
  symbol: process.env['SYMBOL'] ?? 'FEE66607',
  amount: process.env['AMOUNT'] ?? '0.05',
  app: env('RIG_APP_URL', 'http://localhost:3000'),
  rpc: env('RIG_RPC_URL', 'https://rpc.testnet.dogeos.com'),
};

/** ERC-20 balanceOf(address), read straight from the chain. */
export async function erc20Balance(rpcUrl: string, token: string, owner: string): Promise<bigint> {
  const data = `0x70a08231000000000000000000000000${owner.slice(2)}`;
  const r = (await rpc(rpcUrl, 'eth_call', [{ to: token, data }, 'latest'])) as string;
  return BigInt(r || '0x0');
}

export async function nonceOf(rpcUrl: string, owner: string): Promise<number> {
  return Number(BigInt((await rpc(rpcUrl, 'eth_getTransactionCount', [owner, 'latest'])) as string));
}
