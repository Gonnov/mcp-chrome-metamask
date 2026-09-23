/** Prove the rig works with no .env and no existing profile (no key: the wallet generates one). */
import { McpClient } from './mcp-client.js';

const mcp = new McpClient();
await mcp.init();
console.log('tools:', (await mcp.listTools()).join(', '));
console.log('start:', JSON.stringify(await mcp.json('rig_session', { action: 'start' })));

// A key is never a tool argument. RIG_KEY_FILE (or --key-file) on the server
// entry is the only way in, and only a burner belongs there.
const setup = await mcp.json('rig_wallet', {
  action: 'setup',
  chain_id: '6281971',
  rpc_url: 'https://rpc.testnet.dogeos.com',
  name: 'DogeOS Chikyu Testnet',
  symbol: 'DOGE',
});
console.log('setup onboarded:', setup['onboarded'], '| imported:', JSON.stringify(setup['imported']));
console.log('network:', JSON.stringify(setup['network']).slice(0, 200));
console.log('status:', JSON.stringify(await mcp.json('rig_wallet', { action: 'status' })));
console.log('chain:', JSON.stringify(await mcp.json('rig_chain', { action: 'info' })));
mcp.close();
